import {
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ReturnStatus,
  StockMovementType,
} from '@prisma/client';
import { prisma, tenantTransaction } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { recordOrderEvent, recordStockMovement } from '../../utils/ledger';
import { getStaffStoreId } from '../../utils/storeContext';
import { notifyReturnRefunded, notifyReturnRequested } from '../notifications/notification.service';

// Orders eligible for a return: confirmed (paid/accepted) through delivered.
const RETURNABLE: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PACKED,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

async function nextReturnNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('return_number_seq')`;
  return `RET-${year}-${String(Number(nextval)).padStart(5, '0')}`;
}

interface ReturnLineInput {
  orderItemId: string;
  quantity: number;
}

/**
 * Raise a return against an order. Validates the order is returnable and that
 * each line's quantity doesn't exceed what's left after earlier returns, then
 * snapshots a proportional (tax-inclusive) refund amount per line.
 */
export async function createReturn(
  actor: { sub: string; type: 'STAFF' | 'CUSTOMER' },
  input: { orderId: string; reason?: string; items: ReturnLineInput[] },
) {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { items: true },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (actor.type === 'CUSTOMER' && order.customerId !== actor.sub) {
    throw ApiError.forbidden('You cannot return this order');
  }
  if (!RETURNABLE.includes(order.status)) {
    throw ApiError.badRequest(`A ${order.status.toLowerCase()} order can't be returned`);
  }

  // How much of each line has already been returned (excluding rejected ones).
  const prior = await prisma.orderReturnItem.groupBy({
    by: ['orderItemId'],
    where: {
      orderItem: { orderId: order.id },
      return: { status: { in: [ReturnStatus.REQUESTED, ReturnStatus.APPROVED, ReturnStatus.REFUNDED] } },
    },
    _sum: { quantity: true },
  });
  const returnedByItem = new Map(prior.map((p) => [p.orderItemId, p._sum.quantity ?? 0]));

  const lines = input.items
    .filter((i) => i.quantity > 0)
    .map((i) => {
      const orderItem = order.items.find((oi) => oi.id === i.orderItemId);
      if (!orderItem) throw ApiError.badRequest('Return line is not part of this order');
      const already = returnedByItem.get(orderItem.id) ?? 0;
      const remaining = orderItem.quantity - already;
      if (i.quantity > remaining) {
        throw ApiError.badRequest(
          `Only ${remaining} of "${orderItem.productName}" can still be returned`,
        );
      }
      // Refund the line's tax-inclusive total, prorated to the returned units.
      const lineRefundPaise = Math.round(
        (orderItem.lineTotalPaise * i.quantity) / orderItem.quantity,
      );
      return {
        orderItemId: orderItem.id,
        quantity: i.quantity,
        unitPricePaise: orderItem.unitPricePaise,
        lineRefundPaise,
      };
    });

  if (lines.length === 0) throw ApiError.badRequest('Select at least one item to return');
  const refundAmountPaise = lines.reduce((sum, l) => sum + l.lineRefundPaise, 0);

  return tenantTransaction(async (tx) => {
    const returnNumber = await nextReturnNumber(tx);
    const created = await tx.orderReturn.create({
      data: {
        returnNumber,
        orderId: order.id,
        customerId: order.customerId,
        status: ReturnStatus.REQUESTED,
        reason: input.reason?.trim() || null,
        refundAmountPaise,
        items: { create: lines },
      },
      include: { items: true },
    });
    await notifyReturnRequested(tx, { order, returnNumber, refundAmountPaise });
    return created;
  });
}

/** Calls Razorpay's refund API for a captured payment. Network I/O — keep it
 *  outside the DB transaction. Returns the refund id. */
async function razorpayRefund(paymentId: string, amountPaise: number): Promise<string> {
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const resp = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, speed: 'normal' }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    logger.error({ status: resp.status, text }, 'razorpay refund failed');
    throw ApiError.badRequest('Razorpay refund failed — please retry or refund manually');
  }
  const data = (await resp.json()) as { id: string };
  return data.id;
}

/**
 * Process a return: restock the returned units (RELEASE ledger), refund the
 * money (Razorpay when the order was paid online, otherwise marked for manual
 * settlement) and flip the order to RETURNED/REFUNDED once fully returned.
 */
export async function refundReturn(id: string, actorId?: string) {
  const ret = await prisma.orderReturn.findUnique({
    where: { id },
    include: { items: { include: { orderItem: true } }, order: { include: { items: true } } },
  });
  if (!ret) throw ApiError.notFound('Return not found');
  if (ret.status === ReturnStatus.REFUNDED) throw ApiError.badRequest('Return already refunded');
  if (ret.status === ReturnStatus.REJECTED || ret.status === ReturnStatus.CANCELLED) {
    throw ApiError.badRequest(`A ${ret.status.toLowerCase()} return can't be refunded`);
  }
  const order = ret.order;

  // Resolve the refund channel: an online order refunds to its captured
  // Razorpay payment; everything else is settled manually by staff.
  const razorpayPayment = await prisma.payment.findFirst({
    where: {
      orderId: order.id,
      method: PaymentMethod.RAZORPAY,
      status: PaymentStatus.PAID,
      razorpayPaymentId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
  });

  let refundMethod: PaymentMethod = order.paymentMethod;
  let refundReference: string | null = null;
  const canCallRazorpay =
    Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) &&
    razorpayPayment?.razorpayPaymentId;
  if (canCallRazorpay) {
    refundReference = await razorpayRefund(
      razorpayPayment!.razorpayPaymentId!,
      ret.refundAmountPaise,
    );
    refundMethod = PaymentMethod.RAZORPAY;
  }

  return tenantTransaction(async (tx) => {
    // Re-check inside the tx to guard against a double process.
    const fresh = await tx.orderReturn.findUnique({ where: { id } });
    if (!fresh || fresh.status === ReturnStatus.REFUNDED) {
      throw ApiError.badRequest('Return already refunded');
    }

    // Restock each returned line (RELEASE = back into stock).
    if (order.storeId) {
      for (const line of ret.items) {
        const oi = line.orderItem;
        if (oi.variantId) {
          await tx.storeVariant.updateMany({
            where: { storeId: order.storeId, variantId: oi.variantId },
            data: { stockQty: { increment: line.quantity } },
          });
        } else {
          await tx.storeProduct.updateMany({
            where: { storeId: order.storeId, productId: oi.productId },
            data: { stockQty: { increment: line.quantity } },
          });
        }
        await recordStockMovement(tx, {
          storeId: order.storeId,
          productId: oi.productId,
          variantId: oi.variantId,
          deltaQty: line.quantity,
          type: StockMovementType.RELEASE,
          orderId: order.id,
          userId: actorId,
          reason: `Return ${ret.returnNumber}`,
        });
      }
    }

    await tx.orderReturn.update({
      where: { id },
      data: {
        status: ReturnStatus.REFUNDED,
        refundMethod,
        refundReference,
        restocked: Boolean(order.storeId),
        processedAt: new Date(),
      },
    });

    // Fully returned (cumulative refunds cover the order)? Close it out.
    const refundedAgg = await tx.orderReturn.aggregate({
      where: { orderId: order.id, status: ReturnStatus.REFUNDED },
      _sum: { refundAmountPaise: true },
    });
    const totalRefunded = (refundedAgg._sum.refundAmountPaise ?? 0) + ret.refundAmountPaise;
    const fullyReturned = totalRefunded >= order.totalPaise;

    await tx.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: fullyReturned ? OrderPaymentStatus.REFUNDED : order.paymentStatus,
        status: fullyReturned ? OrderStatus.RETURNED : order.status,
      },
    });
    await recordOrderEvent(tx, order.id, fullyReturned ? OrderStatus.RETURNED : order.status, {
      userId: actorId,
      note: `Refund ${ret.returnNumber} processed (₹${(ret.refundAmountPaise / 100).toLocaleString('en-IN')})`,
    });

    await notifyReturnRefunded(tx, {
      order,
      returnNumber: ret.returnNumber,
      refundAmountPaise: ret.refundAmountPaise,
    });

    return tx.orderReturn.findUnique({ where: { id }, include: { items: true } });
  });
}

/** Staff declines a return request. */
export async function rejectReturn(id: string, reason: string | undefined, actorId?: string) {
  const ret = await prisma.orderReturn.findUnique({ where: { id } });
  if (!ret) throw ApiError.notFound('Return not found');
  if (ret.status !== ReturnStatus.REQUESTED && ret.status !== ReturnStatus.APPROVED) {
    throw ApiError.badRequest(`A ${ret.status.toLowerCase()} return can't be rejected`);
  }
  return tenantTransaction(async (tx) => {
    const updated = await tx.orderReturn.update({
      where: { id },
      data: { status: ReturnStatus.REJECTED, reason: reason?.trim() || ret.reason, processedAt: new Date() },
    });
    await recordOrderEvent(tx, ret.orderId, ret.status === ReturnStatus.APPROVED ? OrderStatus.CONFIRMED : OrderStatus.CONFIRMED, {
      userId: actorId,
      note: `Return ${ret.returnNumber} rejected`,
    });
    return updated;
  });
}

export async function listReturns(actor: { sub: string; type: 'STAFF' | 'CUSTOMER' }) {
  const where: Prisma.OrderReturnWhereInput = {};
  if (actor.type === 'CUSTOMER') {
    where.customerId = actor.sub;
  } else {
    const storeId = await getStaffStoreId(actor.sub);
    if (storeId) where.order = { storeId };
  }
  return prisma.orderReturn.findMany({
    where,
    include: {
      items: true,
      order: { select: { orderNumber: true, totalPaise: true, paymentMethod: true } },
      customer: { select: { shopName: true, phone: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

export async function getReturn(actor: { sub: string; type: 'STAFF' | 'CUSTOMER' }, id: string) {
  const ret = await prisma.orderReturn.findUnique({
    where: { id },
    include: {
      items: { include: { orderItem: true } },
      order: { select: { orderNumber: true, totalPaise: true, paymentMethod: true, storeId: true } },
      customer: { select: { shopName: true, phone: true } },
    },
  });
  if (!ret) throw ApiError.notFound('Return not found');
  if (actor.type === 'CUSTOMER' && ret.customerId !== actor.sub) {
    throw ApiError.forbidden('You cannot view this return');
  }
  if (actor.type === 'STAFF') {
    const storeId = await getStaffStoreId(actor.sub);
    if (storeId && ret.order.storeId !== storeId) {
      throw ApiError.forbidden('This return belongs to another store');
    }
  }
  return ret;
}
