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
import { logger } from '../../config/logger';
import { computeLineTax, isIntraState, resolveUnitPrice } from '../../utils/pricing';
import { getStaffStoreId } from '../../utils/storeContext';

const RAZORPAY_CURRENCY = 'INR';

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

interface RazorpayCheckout {
  enabled: boolean;
  keyId: string | null;
  orderId: string;
  amountPaise: number;
  currency: string;
  name: string;
  description: string;
  prefill: {
    name: string;
    contact: string;
    email?: string | null;
  };
  notes: Record<string, string>;
}

async function nextOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const count = await tx.order.count();
  return `ORD-${year}-${String(count + 1).padStart(5, '0')}`;
}

function razorpayConfigured(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

function assertRazorpayConfigComplete(): void {
  const hasKey = Boolean(env.RAZORPAY_KEY_ID);
  const hasSecret = Boolean(env.RAZORPAY_KEY_SECRET);
  if (hasKey !== hasSecret) {
    throw ApiError.internal('Razorpay is partially configured. Set both key id and key secret.');
  }
}

async function createRazorpayOrder(input: {
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrderResponse> {
  assertRazorpayConfigComplete();

  if (!razorpayConfigured()) {
    throw ApiError.badRequest('Razorpay is not configured yet. Please choose another payment method.');
  }

  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');

  // Hard timeout so a slow/unreachable gateway can't hang the checkout request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: RAZORPAY_CURRENCY,
        receipt: input.receipt,
        notes: input.notes,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    logger.error({ err }, 'Razorpay order request failed (timeout/network)');
    throw ApiError.badRequest(
      'Could not reach the payment gateway. Please try again, or choose Credit / Bank transfer.',
    );
  } finally {
    clearTimeout(timer);
  }

  const data = (await response.json().catch(() => null)) as
    | (Partial<RazorpayOrderResponse> & { error?: { description?: string } })
    | null;
  if (!response.ok || !data?.id) {
    logger.error({ status: response.status, body: data }, 'Razorpay rejected order creation');
    throw ApiError.badRequest(data?.error?.description ?? 'Unable to create Razorpay order');
  }

  return {
    id: data.id,
    amount: data.amount ?? input.amountPaise,
    currency: data.currency ?? RAZORPAY_CURRENCY,
    receipt: data.receipt ?? input.receipt,
    status: data.status ?? 'created',
  };
}

interface CreateOrderInput {
  addressId: string;
  paymentMethod: PaymentMethod;
  notes?: string;
  // Customer-supplied transfer reference (UTR / txn id) for BANK_TRANSFER.
  bankReference?: string;
}

/** Checkout: turns the customer's cart into a GST-computed order. */
export async function createOrder(customerId: string, input: CreateOrderInput) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: { store: true },
  });
  if (!customer) throw ApiError.notFound('Customer not found');
  if (!customer.storeId || !customer.store) {
    throw ApiError.badRequest('Your shop is not linked to a store yet.');
  }
  const store = customer.store;

  const address = await prisma.address.findUnique({ where: { id: input.addressId } });
  if (!address || address.customerId !== customerId) {
    throw ApiError.badRequest('Delivery address not found');
  }

  const cart = await prisma.cart.findUnique({
    where: { customerId },
    include: { items: { include: { product: true } } },
  });
  if (!cart || cart.items.length === 0) {
    throw ApiError.badRequest('Your cart is empty');
  }

  // Per-store price/stock/tiers for everything in the cart.
  const storeProducts = await prisma.storeProduct.findMany({
    where: { storeId: store.id, productId: { in: cart.items.map((i) => i.productId) } },
    include: { priceTiers: true },
  });
  const spByProduct = new Map(storeProducts.map((sp) => [sp.productId, sp]));

  // GST seller side = the fulfilling store's state (multi-state ready).
  const intra = isIntraState(address.stateCode, address.state, store.stateCode, store.state);

  let subtotalPaise = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;

  const orderItems = cart.items.map((item) => {
    const { product, quantity } = item;
    const sp = spByProduct.get(item.productId);
    if (!product.isActive || !sp || !sp.isActive) {
      throw ApiError.badRequest(`${product.name} is no longer available`);
    }
    if (quantity < product.moqQty) {
      throw ApiError.badRequest(`Minimum order quantity for ${product.name} is ${product.moqQty}`);
    }
    if (quantity > sp.stockQty) {
      throw ApiError.badRequest(`Insufficient stock for ${product.name}`);
    }

    const unitPricePaise = resolveUnitPrice(sp.pricePaise, sp.priceTiers, quantity);
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

  // Payment-method specifics. COD is not offered.
  if (input.paymentMethod === PaymentMethod.COD) {
    throw ApiError.badRequest('Cash on delivery is not available');
  }
  if (input.paymentMethod === PaymentMethod.CREDIT) {
    if (!customer.creditApproved || customer.creditLimitPaise <= 0) {
      throw ApiError.badRequest('Credit is not approved for your account yet');
    }
    // Available credit = approved limit minus what's still owed on open credit orders.
    const open = await prisma.order.aggregate({
      where: { customerId, paymentMethod: PaymentMethod.CREDIT, paymentStatus: { not: 'PAID' } },
      _sum: { amountDuePaise: true },
    });
    const outstanding = open._sum.amountDuePaise ?? 0;
    const available = customer.creditLimitPaise - outstanding;
    if (totalPaise > available) {
      throw ApiError.badRequest(
        `Order exceeds your available credit (₹${(available / 100).toFixed(0)} of ₹${(customer.creditLimitPaise / 100).toFixed(0)} left)`,
      );
    }
  }
  if (input.paymentMethod === PaymentMethod.BANK_TRANSFER && !input.bankReference?.trim()) {
    throw ApiError.badRequest('Enter your bank transfer reference to place the order');
  }

  // Every order starts PENDING and is only processed after verification:
  // RAZORPAY auto-confirms when payment is verified; CREDIT and BANK_TRANSFER
  // are confirmed by staff after they verify the order / transfer.
  const initialStatus = OrderStatus.PENDING;
  const dueDate =
    input.paymentMethod === PaymentMethod.CREDIT && customer.creditDays > 0
      ? new Date(Date.now() + customer.creditDays * 24 * 60 * 60 * 1000)
      : null;

  const receipt = `nhstyx_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  // Persist the order FIRST, then make the slow external Razorpay call. Doing
  // the gateway request before the transaction left a multi-second gap during
  // which a serverless DB (e.g. Neon) could reap the pooled connection, so the
  // transaction then failed and rolled back. Committing first — on a warm
  // connection, with generous timeouts — removes that race entirely.
  const order = await prisma.$transaction(
    async (tx) => {
      const orderNumber = await nextOrderNumber(tx);

      const order = await tx.order.create({
        data: {
          orderNumber,
          customerId,
          storeId: store.id,
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
          sellerStateCode: store.stateCode,
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

      // For non-online methods the order is final the moment it's placed, so
      // consume stock and empty the cart now. RAZORPAY defers BOTH until the
      // payment is verified (see verifyRazorpay) — otherwise a cancelled or
      // failed payment would lose the customer's cart and silently eat stock.
      if (input.paymentMethod !== PaymentMethod.RAZORPAY) {
        for (const item of cart.items) {
          await tx.storeProduct.update({
            where: { storeId_productId: { storeId: store.id, productId: item.productId } },
            data: { stockQty: { decrement: item.quantity } },
          });
        }
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      }

      // Open a payment intent. The Razorpay order id is attached AFTER commit.
      if (input.paymentMethod === PaymentMethod.RAZORPAY) {
        await tx.payment.create({
          data: {
            orderId: order.id,
            method: PaymentMethod.RAZORPAY,
            amountPaise: totalPaise,
            status: PaymentStatus.CREATED,
          },
        });
      }

      // For a bank transfer, record the customer's reference; staff verify it
      // and mark it paid later (order stays UNPAID until then).
      if (input.paymentMethod === PaymentMethod.BANK_TRANSFER) {
        await tx.payment.create({
          data: {
            orderId: order.id,
            method: PaymentMethod.BANK_TRANSFER,
            amountPaise: totalPaise,
            status: PaymentStatus.CREATED,
            reference: input.bankReference?.trim(),
            note: input.notes?.trim(),
          },
        });
      }

      return order;
    },
    { maxWait: 15000, timeout: 30000 },
  );

  if (input.paymentMethod !== PaymentMethod.RAZORPAY) return order;

  // Order is safely committed — now create the gateway order (slow, external)
  // and attach its id to the payment intent.
  const razorpayOrder = await createRazorpayOrder({
    amountPaise: totalPaise,
    receipt,
    notes: { customerId, shopName: customer.shopName, storeId: store.id },
  });
  await prisma.payment.updateMany({
    where: { orderId: order.id, method: PaymentMethod.RAZORPAY, status: PaymentStatus.CREATED },
    data: { razorpayOrderId: razorpayOrder.id },
  });

  return {
    order,
    razorpay: {
      enabled: true,
      keyId: env.RAZORPAY_KEY_ID!,
      orderId: razorpayOrder.id,
      amountPaise: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      name: 'NH Styx',
      description: `Order ${order.orderNumber}`,
      prefill: {
        name: customer.ownerName ?? customer.shopName,
        contact: customer.phone,
        email: customer.email,
      },
      notes: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        receipt: razorpayOrder.receipt,
      },
    } satisfies RazorpayCheckout,
  };
}

export async function listOrders(
  actor: { sub: string; type: 'STAFF' | 'CUSTOMER' },
  params: { page: number; limit: number; status?: OrderStatus },
) {
  const where: Prisma.OrderWhereInput = {};
  if (params.status) where.status = params.status;
  if (actor.type === 'CUSTOMER') {
    where.customerId = actor.sub;
  } else {
    // Agents are scoped to their store; admins (storeId null) see every store.
    const storeId = await getStaffStoreId(actor.sub);
    if (storeId) where.storeId = storeId;
  }

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        items: true,
        customer: { select: { shopName: true, phone: true } },
        store: { select: { id: true, name: true, city: true } },
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
      store: { select: { id: true, name: true, city: true } },
    },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (actor.type === 'CUSTOMER' && order.customerId !== actor.sub) {
    throw ApiError.forbidden('You cannot view this order');
  }
  if (actor.type === 'STAFF') {
    // Agents may only open orders from their own store; admins see all.
    const storeId = await getStaffStoreId(actor.sub);
    if (storeId && order.storeId !== storeId) {
      throw ApiError.forbidden('This order belongs to another store');
    }
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
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
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
    if (!intent) {
      throw ApiError.badRequest('No pending Razorpay payment found for this order');
    }
    if (intent.razorpayOrderId && intent.razorpayOrderId !== input.razorpayOrderId) {
      throw ApiError.badRequest('Razorpay order does not match this checkout');
    }
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

    // Payment confirmed — NOW consume stock and empty the cart. We deferred
    // both from checkout so an abandoned/failed payment left them untouched.
    // Guarded by the CREATED→PAID intent transition above, so this runs once.
    if (order.storeId) {
      for (const item of order.items) {
        await tx.storeProduct.updateMany({
          where: { storeId: order.storeId, productId: item.productId },
          data: { stockQty: { decrement: item.quantity } },
        });
      }
    }
    const cart = await tx.cart.findUnique({ where: { customerId } });
    if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

    return recompute(tx, orderId);
  });
}
