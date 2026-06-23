import crypto from 'node:crypto';
import {
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import { computeLineTax, isIntraState, resolveUnitPrice } from '../../utils/pricing';

async function nextOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const count = await tx.order.count();
  return `ORD-${year}-${String(count + 1).padStart(5, '0')}`;
}

interface CreateOrderInput {
  addressId: string;
  paymentMethod: PaymentMethod;
  notes?: string;
}

/** Checkout: turns the customer's cart into a GST-computed order. */
export async function createOrder(customerId: string, input: CreateOrderInput) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw ApiError.notFound('Customer not found');

  const address = await prisma.address.findUnique({ where: { id: input.addressId } });
  if (!address || address.customerId !== customerId) {
    throw ApiError.badRequest('Delivery address not found');
  }

  const cart = await prisma.cart.findUnique({
    where: { customerId },
    include: { items: { include: { product: { include: { priceTiers: true } } } } },
  });
  if (!cart || cart.items.length === 0) {
    throw ApiError.badRequest('Your cart is empty');
  }

  const intra = isIntraState(address.stateCode, address.state);

  let subtotalPaise = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;

  const orderItems = cart.items.map((item) => {
    const { product, quantity } = item;
    if (!product.isActive) throw ApiError.badRequest(`${product.name} is no longer available`);
    if (quantity < product.moqQty) {
      throw ApiError.badRequest(`Minimum order quantity for ${product.name} is ${product.moqQty}`);
    }
    if (quantity > product.stockQty) {
      throw ApiError.badRequest(`Insufficient stock for ${product.name}`);
    }

    const unitPricePaise = resolveUnitPrice(product.pricePaise, product.priceTiers, quantity);
    const lineSubtotalPaise = unitPricePaise * quantity;
    const tax = computeLineTax(lineSubtotalPaise, product.gstRatePercent, intra);

    subtotalPaise += lineSubtotalPaise;
    cgstTotal += tax.cgstPaise;
    sgstTotal += tax.sgstPaise;
    igstTotal += tax.igstPaise;

    return {
      productId: product.id,
      productName: product.name,
      hsnCode: product.hsnCode,
      unit: product.unit,
      quantity,
      unitPricePaise,
      gstRatePercent: product.gstRatePercent,
      lineSubtotalPaise,
      cgstPaise: tax.cgstPaise,
      sgstPaise: tax.sgstPaise,
      igstPaise: tax.igstPaise,
      lineTotalPaise: lineSubtotalPaise + tax.taxPaise,
    };
  });

  const deliveryPaise = env.DELIVERY_FEE_PAISE;
  const discountPaise = 0;
  const totalPaise = subtotalPaise + cgstTotal + sgstTotal + igstTotal + deliveryPaise - discountPaise;

  // Payment-method specifics.
  if (input.paymentMethod === PaymentMethod.CREDIT) {
    if (totalPaise > customer.creditLimitPaise) {
      throw ApiError.badRequest('Order exceeds your available credit limit');
    }
  }
  const initialStatus =
    input.paymentMethod === PaymentMethod.COD || input.paymentMethod === PaymentMethod.CREDIT
      ? OrderStatus.CONFIRMED
      : OrderStatus.PENDING;
  const dueDate =
    input.paymentMethod === PaymentMethod.CREDIT && customer.creditDays > 0
      ? new Date(Date.now() + customer.creditDays * 24 * 60 * 60 * 1000)
      : null;

  return prisma.$transaction(async (tx) => {
    const orderNumber = await nextOrderNumber(tx);

    const order = await tx.order.create({
      data: {
        orderNumber,
        customerId,
        status: initialStatus,
        shipName: address.label ? `${customer.shopName} (${address.label})` : customer.shopName,
        shipLine1: address.line1,
        shipLine2: address.line2,
        shipCity: address.city,
        shipState: address.state,
        shipPincode: address.pincode,
        shipPhone: customer.phone,
        gstinUsed: customer.gstin,
        placeOfSupply: address.state,
        subtotalPaise,
        discountPaise,
        deliveryPaise,
        cgstPaise: cgstTotal,
        sgstPaise: sgstTotal,
        igstPaise: igstTotal,
        totalPaise,
        paymentMethod: input.paymentMethod,
        paymentStatus: OrderPaymentStatus.UNPAID,
        amountPaidPaise: 0,
        amountDuePaise: totalPaise,
        dueDate,
        items: { create: orderItems },
      },
      include: { items: true },
    });

    // Decrement stock.
    for (const item of cart.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stockQty: { decrement: item.quantity } },
      });
    }

    // Empty the cart.
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

    // For online payment, open a payment intent (Razorpay order is stubbed
    // when keys are absent).
    if (input.paymentMethod === PaymentMethod.RAZORPAY) {
      await tx.payment.create({
        data: {
          orderId: order.id,
          method: PaymentMethod.RAZORPAY,
          amountPaise: totalPaise,
          status: PaymentStatus.CREATED,
          razorpayOrderId: env.RAZORPAY_KEY_ID
            ? undefined // a real Razorpay order id would be created via their API
            : `stub_${crypto.randomBytes(8).toString('hex')}`,
        },
      });
    }

    return order;
  });
}

export async function listOrders(
  actor: { sub: string; type: 'STAFF' | 'CUSTOMER' },
  params: { page: number; limit: number; status?: OrderStatus },
) {
  const where: Prisma.OrderWhereInput = {};
  if (params.status) where.status = params.status;
  if (actor.type === 'CUSTOMER') where.customerId = actor.sub;

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        items: true,
        customer: { select: { shopName: true, phone: true } },
      },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.ceil(total / params.limit),
    },
  };
}

export async function getOrder(
  actor: { sub: string; type: 'STAFF' | 'CUSTOMER' },
  id: string,
) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      items: true,
      payments: true,
      customer: { select: { shopName: true, phone: true, gstin: true } },
    },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (actor.type === 'CUSTOMER' && order.customerId !== actor.sub) {
    throw ApiError.forbidden('You cannot view this order');
  }
  return order;
}

export async function updateOrderStatus(id: string, status: OrderStatus) {
  await prisma.order.findUniqueOrThrow({ where: { id } }).catch(() => {
    throw ApiError.notFound('Order not found');
  });
  return prisma.order.update({ where: { id }, data: { status } });
}

/** Recompute amountPaid/Due + paymentStatus from PAID payments; auto-confirm. */
async function recompute(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { payments: true },
  });
  const paid = order.payments
    .filter((p) => p.status === PaymentStatus.PAID)
    .reduce((sum, p) => sum + p.amountPaise, 0);
  const due = Math.max(order.totalPaise - paid, 0);

  let paymentStatus: OrderPaymentStatus = OrderPaymentStatus.UNPAID;
  if (paid >= order.totalPaise) paymentStatus = OrderPaymentStatus.PAID;
  else if (paid > 0) paymentStatus = OrderPaymentStatus.PARTIALLY_PAID;

  const status =
    paymentStatus === OrderPaymentStatus.PAID && order.status === OrderStatus.PENDING
      ? OrderStatus.CONFIRMED
      : order.status;

  return tx.order.update({
    where: { id: orderId },
    data: { amountPaidPaise: paid, amountDuePaise: due, paymentStatus, status },
    include: { payments: true },
  });
}

/** Staff records a payment collected offline (COD / bank transfer / credit settlement). */
export async function recordPayment(
  orderId: string,
  input: { method: PaymentMethod; amountPaise: number; reference?: string },
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');

  return prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        orderId,
        method: input.method,
        amountPaise: input.amountPaise,
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        razorpayPaymentId: input.reference,
      },
    });
    return recompute(tx, orderId);
  });
}

/** Verifies a Razorpay payment (HMAC check when a secret is configured). */
export async function verifyRazorpay(
  customerId: string,
  orderId: string,
  input: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string },
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.customerId !== customerId) throw ApiError.forbidden('You cannot pay for this order');

  if (env.RAZORPAY_KEY_SECRET) {
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
      .digest('hex');
    if (expected !== input.razorpaySignature) {
      throw ApiError.badRequest('Razorpay signature verification failed');
    }
  }
  // When no secret is configured (dev/scaffold) the payment is accepted as-is.

  return prisma.$transaction(async (tx) => {
    const intent = await tx.payment.findFirst({
      where: { orderId, method: PaymentMethod.RAZORPAY, status: PaymentStatus.CREATED },
      orderBy: { createdAt: 'desc' },
    });
    if (intent) {
      await tx.payment.update({
        where: { id: intent.id },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          razorpayOrderId: input.razorpayOrderId,
          razorpayPaymentId: input.razorpayPaymentId,
          razorpaySignature: input.razorpaySignature,
        },
      });
    } else {
      await tx.payment.create({
        data: {
          orderId,
          method: PaymentMethod.RAZORPAY,
          amountPaise: order.amountDuePaise,
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          razorpayOrderId: input.razorpayOrderId,
          razorpayPaymentId: input.razorpayPaymentId,
          razorpaySignature: input.razorpaySignature,
        },
      });
    }
    return recompute(tx, orderId);
  });
}
