import crypto from 'node:crypto';
import {
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  StockMovementType,
} from '@prisma/client';
import { prisma, tenantTransaction } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { computeLineTax, isIntraState, resolveUnitPrice } from '../../utils/pricing';
import { recordOrderEvent, recordStockMovement } from '../../utils/ledger';
import { getStaffStoreId } from '../../utils/storeContext';
import * as couponService from '../coupons/coupon.service';
import {
  notifyOrderDelivered,
  notifyOrderPlaced,
  notifyOrderShipped,
  notifyPaymentReceived,
} from '../notifications/notification.service';

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

export async function nextOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  // A Postgres sequence (migration `enable_rls`) gives a gap-free, race-free,
  // and RLS-independent counter — a global `order.count()` would be wrong under
  // a customer's row-level-security context (it would only see their orders).
  const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('order_number_seq')`;
  return `ORD-${year}-${String(Number(nextval)).padStart(5, '0')}`;
}

/** Concurrency-safe stock decrement for an order line — on the variant for a
 *  variant line, otherwise the store-product — plus a SALE ledger entry. */
async function decrementStock(
  tx: Prisma.TransactionClient,
  storeId: string,
  productId: string,
  variantId: string | null,
  quantity: number,
  productName: string,
  orderId: string,
) {
  const dec = variantId
    ? await tx.storeVariant.updateMany({
        where: { storeId, variantId, stockQty: { gte: quantity } },
        data: { stockQty: { decrement: quantity } },
      })
    : await tx.storeProduct.updateMany({
        where: { storeId, productId, stockQty: { gte: quantity } },
        data: { stockQty: { decrement: quantity } },
      });
  if (dec.count !== 1) throw ApiError.badRequest(`${productName} just went out of stock`);

  await recordStockMovement(tx, {
    storeId,
    productId,
    variantId,
    deltaQty: -quantity,
    type: StockMovementType.SALE,
    orderId,
  });
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
  // Optional promo code applied to the order.
  couponCode?: string;
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
    include: { items: { include: { product: true, variant: true } } },
  });
  if (!cart || cart.items.length === 0) {
    throw ApiError.badRequest('Your cart is empty');
  }

  // Per-store price/stock/tiers for base products, and per-variant price/stock
  // for variant lines.
  const storeProducts = await prisma.storeProduct.findMany({
    where: { storeId: store.id, productId: { in: cart.items.map((i) => i.productId) } },
    include: { priceTiers: true },
  });
  const spByProduct = new Map(storeProducts.map((sp) => [sp.productId, sp]));
  const variantIds = cart.items.filter((i) => i.variantId).map((i) => i.variantId!);
  const storeVariants = variantIds.length
    ? await prisma.storeVariant.findMany({ where: { storeId: store.id, variantId: { in: variantIds } } })
    : [];
  const svByVariant = new Map(storeVariants.map((sv) => [sv.variantId, sv]));

  // GST seller side = the fulfilling store's state (multi-state ready).
  const intra = isIntraState(address.stateCode, address.state, store.stateCode, store.state);

  let subtotalPaise = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;

  const orderItems = cart.items.map((item) => {
    const { product, quantity } = item;

    let unitPricePaise: number;
    let stockQty: number;
    let variantName: string | null = null;
    if (item.variantId) {
      const sv = svByVariant.get(item.variantId);
      if (!product.isActive || !sv || !sv.isActive || !item.variant?.isActive) {
        throw ApiError.badRequest(`${product.name} (${item.variant?.name ?? 'option'}) is no longer available`);
      }
      unitPricePaise = sv.pricePaise;
      stockQty = sv.stockQty;
      variantName = item.variant?.name ?? null;
    } else {
      const sp = spByProduct.get(item.productId);
      if (!product.isActive || !sp || !sp.isActive) {
        throw ApiError.badRequest(`${product.name} is no longer available`);
      }
      unitPricePaise = resolveUnitPrice(sp.pricePaise, sp.priceTiers, quantity);
      stockQty = sp.stockQty;
    }

    if (quantity < product.moqQty) {
      throw ApiError.badRequest(`Minimum order quantity for ${product.name} is ${product.moqQty}`);
    }
    if (quantity > stockQty) {
      throw ApiError.badRequest(
        `Insufficient stock for ${product.name}${variantName ? ` (${variantName})` : ''}`,
      );
    }

    const lineSubtotalPaise = unitPricePaise * quantity;
    const tax = computeLineTax(lineSubtotalPaise, product.gstRatePercent, intra);

    subtotalPaise += lineSubtotalPaise;
    cgstTotal += tax.cgstPaise;
    sgstTotal += tax.sgstPaise;
    igstTotal += tax.igstPaise;

    return {
      productId: product.id,
      variantId: item.variantId ?? null,
      productName: product.name,
      variantName,
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

  // Apply a coupon (post-tax rebate on the payable amount) if one was given.
  let discountPaise = 0;
  let appliedCoupon: { id: string; code: string } | null = null;
  if (input.couponCode?.trim()) {
    const result = await couponService.validateCoupon({
      code: input.couponCode,
      customerId,
      storeId: store.id,
      subtotalPaise,
    });
    discountPaise = result.discountPaise;
    appliedCoupon = { id: result.coupon.id, code: result.coupon.code };
  }

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
  const order = await tenantTransaction(
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
          couponCode: appliedCoupon?.code ?? null,
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
      await recordOrderEvent(tx, order.id, OrderStatus.PENDING, { note: 'Order placed' });
      await notifyOrderPlaced(tx, order);

      if (appliedCoupon) {
        await couponService.redeem(tx, appliedCoupon.id, customerId, order.id, discountPaise);
      }

      if (input.paymentMethod !== PaymentMethod.RAZORPAY) {
        // Conditional decrement guards against overselling under concurrency —
        // on the variant for variant lines, otherwise on the store-product.
        for (const item of cart.items) {
          await decrementStock(tx, store.id, item.productId, item.variantId, item.quantity, item.product.name, order.id);
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

/** The Razorpay checkout payload the apps open. Shared by checkout + pay-now. */
function buildCheckout(
  order: { id: string; orderNumber: string },
  customer: { ownerName: string | null; shopName: string; phone: string; email: string | null },
  rzp: { id: string; amount: number; currency: string; receipt?: string },
): RazorpayCheckout {
  return {
    enabled: true,
    keyId: env.RAZORPAY_KEY_ID!,
    orderId: rzp.id,
    amountPaise: rzp.amount,
    currency: rzp.currency,
    name: 'NH Styx',
    description: `Order ${order.orderNumber}`,
    prefill: {
      name: customer.ownerName ?? customer.shopName,
      contact: customer.phone,
      email: customer.email,
    },
    notes: { orderId: order.id, orderNumber: order.orderNumber, receipt: rzp.receipt ?? '' },
  };
}

interface StaffOrderInput {
  customerId: string;
  addressId?: string;
  paymentMethod: PaymentMethod;
  items: { productId: string; quantity: number; variantId?: string }[];
  notes?: string;
  bankReference?: string;
}

/**
 * An agent/admin places an order ON BEHALF of a customer (e.g. a phoned-in bulk
 * order) from explicit line items. Same GST/credit/stock rules as customer
 * checkout; RAZORPAY orders are left UNPAID for the customer to pay later.
 */
export async function createStaffOrder(staffSub: string, input: StaffOrderInput) {
  const customer = await prisma.customer.findUnique({
    where: { id: input.customerId },
    include: { store: true },
  });
  if (!customer) throw ApiError.notFound('Customer not found');
  if (!customer.storeId || !customer.store) {
    throw ApiError.badRequest('This customer is not linked to a store yet.');
  }
  const store = customer.store;

  // Agents may only order for customers in their own store; admins: any store.
  const staffStoreId = await getStaffStoreId(staffSub);
  if (staffStoreId && staffStoreId !== store.id) {
    throw ApiError.forbidden('This customer belongs to another store');
  }
  if (!input.items?.length) throw ApiError.badRequest('Add at least one item to the order');

  // Delivery address: the given one, or the customer's default / first.
  let address;
  if (input.addressId) {
    address = await prisma.address.findUnique({ where: { id: input.addressId } });
    if (!address || address.customerId !== customer.id) {
      throw ApiError.badRequest('Delivery address not found');
    }
  } else {
    address = await prisma.address.findFirst({
      where: { customerId: customer.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (!address) throw ApiError.badRequest('This customer has no saved delivery address');
  }

  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
  const productById = new Map(products.map((p) => [p.id, p]));
  const storeProducts = await prisma.storeProduct.findMany({
    where: { storeId: store.id, productId: { in: productIds } },
    include: { priceTiers: true },
  });
  const spByProduct = new Map(storeProducts.map((sp) => [sp.productId, sp]));
  const variantIds = input.items.filter((i) => i.variantId).map((i) => i.variantId!);
  const storeVariants = variantIds.length
    ? await prisma.storeVariant.findMany({
        where: { storeId: store.id, variantId: { in: variantIds } },
        include: { variant: true },
      })
    : [];
  const svByVariant = new Map(storeVariants.map((sv) => [sv.variantId, sv]));

  const intra = isIntraState(address.stateCode, address.state, store.stateCode, store.state);
  let subtotalPaise = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;

  const orderItems = input.items.map(({ productId, quantity, variantId }) => {
    const product = productById.get(productId);
    if (!product) throw ApiError.badRequest('A selected product was not found');

    let unitPricePaise: number;
    let stockQty: number;
    let variantName: string | null = null;
    if (variantId) {
      const sv = svByVariant.get(variantId);
      if (!product.isActive || !sv || !sv.isActive || !sv.variant.isActive || sv.variant.productId !== productId) {
        throw ApiError.badRequest(`${product.name} (${sv?.variant.name ?? 'option'}) is not stocked in this store`);
      }
      unitPricePaise = sv.pricePaise;
      stockQty = sv.stockQty;
      variantName = sv.variant.name;
    } else {
      const sp = spByProduct.get(productId);
      if (!product.isActive || !sp || !sp.isActive) {
        throw ApiError.badRequest(`${product.name} is not stocked in this store`);
      }
      unitPricePaise = resolveUnitPrice(sp.pricePaise, sp.priceTiers, quantity);
      stockQty = sp.stockQty;
    }

    if (quantity < product.moqQty) {
      throw ApiError.badRequest(`Minimum order quantity for ${product.name} is ${product.moqQty}`);
    }
    if (quantity > stockQty) {
      throw ApiError.badRequest(
        `Insufficient stock for ${product.name}${variantName ? ` (${variantName})` : ''} (have ${stockQty})`,
      );
    }
    const lineSubtotalPaise = unitPricePaise * quantity;
    const tax = computeLineTax(lineSubtotalPaise, product.gstRatePercent, intra);
    subtotalPaise += lineSubtotalPaise;
    cgstTotal += tax.cgstPaise;
    sgstTotal += tax.sgstPaise;
    igstTotal += tax.igstPaise;
    return {
      productId: product.id,
      variantId: variantId ?? null,
      productName: product.name,
      variantName,
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
  const totalPaise = subtotalPaise + cgstTotal + sgstTotal + igstTotal + deliveryPaise;

  if (input.paymentMethod === PaymentMethod.COD) {
    throw ApiError.badRequest('Cash on delivery is not available');
  }
  if (input.paymentMethod === PaymentMethod.CREDIT) {
    if (!customer.creditApproved || customer.creditLimitPaise <= 0) {
      throw ApiError.badRequest('Credit is not approved for this customer');
    }
    const open = await prisma.order.aggregate({
      where: { customerId: customer.id, paymentMethod: PaymentMethod.CREDIT, paymentStatus: { not: 'PAID' } },
      _sum: { amountDuePaise: true },
    });
    const available = customer.creditLimitPaise - (open._sum.amountDuePaise ?? 0);
    if (totalPaise > available) {
      throw ApiError.badRequest(
        `Order exceeds the customer's available credit (₹${(available / 100).toFixed(0)} left)`,
      );
    }
  }
  if (input.paymentMethod === PaymentMethod.BANK_TRANSFER && !input.bankReference?.trim()) {
    throw ApiError.badRequest('A bank transfer reference is required');
  }

  const dueDate =
    input.paymentMethod === PaymentMethod.CREDIT && customer.creditDays > 0
      ? new Date(Date.now() + customer.creditDays * 24 * 60 * 60 * 1000)
      : null;
  const receipt = `nhstyx_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  const order = await tenantTransaction(
    async (tx) => {
      const orderNumber = await nextOrderNumber(tx);
      const created = await tx.order.create({
        data: {
          orderNumber,
          customerId: customer.id,
          storeId: store.id,
          status: OrderStatus.PENDING,
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
          discountPaise: 0,
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

      await recordOrderEvent(tx, created.id, OrderStatus.PENDING, {
        note: 'Order placed by staff',
        userId: staffSub,
      });
      await notifyOrderPlaced(tx, created);

      // Non-online orders consume stock immediately; RAZORPAY defers to payment.
      // Conditional decrement (stockQty >= qty) prevents overselling under
      // concurrent orders — if it doesn't update exactly one row, we roll back.
      if (input.paymentMethod !== PaymentMethod.RAZORPAY) {
        for (const item of orderItems) {
          const dec = item.variantId
            ? await tx.storeVariant.updateMany({
                where: { storeId: store.id, variantId: item.variantId, stockQty: { gte: item.quantity } },
                data: { stockQty: { decrement: item.quantity } },
              })
            : await tx.storeProduct.updateMany({
                where: { storeId: store.id, productId: item.productId, stockQty: { gte: item.quantity } },
                data: { stockQty: { decrement: item.quantity } },
              });
          if (dec.count !== 1) {
            throw ApiError.badRequest(`${item.productName} just went out of stock`);
          }
          await recordStockMovement(tx, {
            storeId: store.id,
            productId: item.productId,
            variantId: item.variantId,
            deltaQty: -item.quantity,
            type: StockMovementType.SALE,
            orderId: created.id,
            userId: staffSub,
          });
        }
      }
      if (input.paymentMethod === PaymentMethod.RAZORPAY) {
        await tx.payment.create({
          data: { orderId: created.id, method: PaymentMethod.RAZORPAY, amountPaise: totalPaise, status: PaymentStatus.CREATED },
        });
      }
      if (input.paymentMethod === PaymentMethod.BANK_TRANSFER) {
        await tx.payment.create({
          data: {
            orderId: created.id,
            method: PaymentMethod.BANK_TRANSFER,
            amountPaise: totalPaise,
            status: PaymentStatus.CREATED,
            reference: input.bankReference?.trim(),
            note: input.notes?.trim(),
          },
        });
      }
      return created;
    },
    { maxWait: 15000, timeout: 30000 },
  );

  if (input.paymentMethod !== PaymentMethod.RAZORPAY) return { order };

  const razorpayOrder = await createRazorpayOrder({
    amountPaise: totalPaise,
    receipt,
    notes: { customerId: customer.id, shopName: customer.shopName, storeId: store.id },
  });
  await prisma.payment.updateMany({
    where: { orderId: order.id, method: PaymentMethod.RAZORPAY, status: PaymentStatus.CREATED },
    data: { razorpayOrderId: razorpayOrder.id },
  });
  return { order, razorpay: buildCheckout(order, customer, razorpayOrder) };
}

/**
 * (Re)issues a Razorpay checkout for an existing UNPAID online order, so the
 * customer can pay it from the Orders screen (e.g. an agent-placed order).
 */
export async function reissueRazorpay(
  actor: { sub: string; type: 'STAFF' | 'CUSTOMER' },
  orderId: string,
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true, payments: true },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (actor.type === 'CUSTOMER' && order.customerId !== actor.sub) {
    throw ApiError.forbidden('You cannot pay for this order');
  }
  if (actor.type === 'STAFF') {
    const sid = await getStaffStoreId(actor.sub);
    if (sid && order.storeId !== sid) throw ApiError.forbidden('This order belongs to another store');
  }
  if (order.paymentMethod !== PaymentMethod.RAZORPAY) {
    throw ApiError.badRequest('This order is not an online (Razorpay) order');
  }
  if (order.paymentStatus === OrderPaymentStatus.PAID) {
    throw ApiError.badRequest('This order is already paid');
  }

  let intent = order.payments.find(
    (p) => p.method === PaymentMethod.RAZORPAY && p.status === PaymentStatus.CREATED,
  );
  if (!intent) {
    intent = await prisma.payment.create({
      data: { orderId: order.id, method: PaymentMethod.RAZORPAY, amountPaise: order.totalPaise, status: PaymentStatus.CREATED },
    });
  }

  let razorpayOrderId = intent.razorpayOrderId;
  if (!razorpayOrderId) {
    const receipt = `nhstyx_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const rzp = await createRazorpayOrder({
      amountPaise: order.totalPaise,
      receipt,
      notes: { customerId: order.customerId, orderId: order.id, storeId: order.storeId ?? '' },
    });
    razorpayOrderId = rzp.id;
    await prisma.payment.update({ where: { id: intent.id }, data: { razorpayOrderId } });
  }

  return buildCheckout(order, order.customer, {
    id: razorpayOrderId,
    amount: order.totalPaise,
    currency: RAZORPAY_CURRENCY,
  });
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
      events: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
      customer: { select: { shopName: true, phone: true, gstin: true } },
      store: { select: { id: true, name: true, city: true } },
      returns: { include: { items: true }, orderBy: { createdAt: 'desc' } },
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

export async function updateOrderStatus(id: string, status: OrderStatus, actorId?: string) {
  await prisma.order.findUniqueOrThrow({ where: { id } }).catch(() => {
    throw ApiError.notFound('Order not found');
  });
  return tenantTransaction(async (tx) => {
    const updated = await tx.order.update({ where: { id }, data: { status } });
    await recordOrderEvent(tx, id, status, { userId: actorId });
    return updated;
  });
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

  if (status === OrderStatus.CONFIRMED && order.status === OrderStatus.PENDING) {
    await recordOrderEvent(tx, orderId, OrderStatus.CONFIRMED, { note: 'Payment confirmed' });
  }

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

  return tenantTransaction(async (tx) => {
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
/**
 * Marks the order's pending Razorpay intent PAID, consumes stock (SALE ledger)
 * and clears the ordered cart lines. Idempotent: returns false when there is no
 * pending intent (already settled — e.g. the webhook and the client both fire).
 * Shared by the client verify path and the webhook backstop.
 */
async function settleRazorpayPayment(
  tx: Prisma.TransactionClient,
  order: {
    id: string;
    storeId: string | null;
    customerId: string;
    items: { productId: string; variantId: string | null; quantity: number }[];
  },
  refs: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature?: string },
): Promise<boolean> {
  const intent = await tx.payment.findFirst({
    where: { orderId: order.id, method: PaymentMethod.RAZORPAY, status: PaymentStatus.CREATED },
    orderBy: { createdAt: 'desc' },
  });
  if (!intent) return false;
  if (intent.razorpayOrderId && intent.razorpayOrderId !== refs.razorpayOrderId) {
    throw ApiError.badRequest('Razorpay order does not match this checkout');
  }
  await tx.payment.update({
    where: { id: intent.id },
    data: {
      status: PaymentStatus.PAID,
      paidAt: new Date(),
      razorpayOrderId: refs.razorpayOrderId,
      razorpayPaymentId: refs.razorpayPaymentId,
      razorpaySignature: refs.razorpaySignature ?? intent.razorpaySignature,
    },
  });

  // Consume stock now (deferred from checkout so an abandoned payment left it
  // untouched). Unconditional: the customer has paid, so honour the order even
  // if it drives stock negative.
  if (order.storeId) {
    for (const item of order.items) {
      if (item.variantId) {
        await tx.storeVariant.updateMany({
          where: { storeId: order.storeId, variantId: item.variantId },
          data: { stockQty: { decrement: item.quantity } },
        });
      } else {
        await tx.storeProduct.updateMany({
          where: { storeId: order.storeId, productId: item.productId },
          data: { stockQty: { decrement: item.quantity } },
        });
      }
      await recordStockMovement(tx, {
        storeId: order.storeId,
        productId: item.productId,
        variantId: item.variantId,
        deltaQty: -item.quantity,
        type: StockMovementType.SALE,
        orderId: order.id,
        reason: 'Razorpay payment confirmed',
      });
    }
  }

  // Clear only the lines this order covered (keeps items added after checkout).
  const cart = await tx.cart.findUnique({ where: { customerId: order.customerId } });
  if (cart) {
    await tx.cartItem.deleteMany({
      where: {
        cartId: cart.id,
        OR: order.items.map((i) => ({ productId: i.productId, variantId: i.variantId })),
      },
    });
  }
  return true;
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

  return tenantTransaction(async (tx) => {
    const settled = await settleRazorpayPayment(tx, order, input);
    if (settled) {
      await notifyPaymentReceived(tx, order);
    } else {
      // Already settled (the webhook beat the client here) — idempotent success,
      // unless there is genuinely no Razorpay payment on record.
      const paid = await tx.payment.findFirst({
        where: { orderId, method: PaymentMethod.RAZORPAY, status: PaymentStatus.PAID },
      });
      if (!paid) throw ApiError.badRequest('No pending Razorpay payment found for this order');
    }
    return recompute(tx, orderId);
  });
}

/**
 * Razorpay webhook backstop: confirms a captured payment even if the customer's
 * app never returned to call verify. Looks up the order by its Razorpay order id
 * and settles idempotently (a no-op if the client already confirmed it). Runs on
 * the trusted system path (no customer context).
 */
export async function settleRazorpayWebhookPayment(refs: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
}): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: { razorpayOrderId: refs.razorpayOrderId },
    include: { order: { include: { items: true } } },
  });
  if (!payment?.order) {
    logger.warn({ razorpayOrderId: refs.razorpayOrderId }, 'razorpay webhook: no matching order');
    return;
  }
  const order = payment.order;
  await tenantTransaction(async (tx) => {
    const settled = await settleRazorpayPayment(tx, order, refs);
    if (settled) {
      await notifyPaymentReceived(tx, order);
      await recompute(tx, order.id);
    }
  });
}

/** Staff dispatches an order: records courier/AWB, flips to SHIPPED, notifies. */
export async function shipOrder(
  id: string,
  input: { courierName?: string; trackingNumber?: string; trackingUrl?: string },
  actorId?: string,
) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
    throw ApiError.badRequest(`Cannot ship a ${order.status.toLowerCase()} order`);
  }
  return tenantTransaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id },
      data: {
        status: OrderStatus.SHIPPED,
        courierName: input.courierName?.trim() || null,
        trackingNumber: input.trackingNumber?.trim() || null,
        trackingUrl: input.trackingUrl?.trim() || null,
        shippedAt: order.shippedAt ?? new Date(),
      },
    });
    const via = input.courierName ? ` via ${input.courierName.trim()}` : '';
    const awb = input.trackingNumber ? ` (${input.trackingNumber.trim()})` : '';
    await recordOrderEvent(tx, id, OrderStatus.SHIPPED, {
      userId: actorId,
      note: `Shipped${via}${awb}`,
    });
    await notifyOrderShipped(tx, updated);
    return updated;
  });
}

/** Staff marks an order delivered. */
export async function markDelivered(id: string, actorId?: string) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
    throw ApiError.badRequest(`Cannot deliver a ${order.status.toLowerCase()} order`);
  }
  return tenantTransaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id },
      data: { status: OrderStatus.DELIVERED, deliveredAt: order.deliveredAt ?? new Date() },
    });
    await recordOrderEvent(tx, id, OrderStatus.DELIVERED, { userId: actorId, note: 'Delivered' });
    await notifyOrderDelivered(tx, updated);
    return updated;
  });
}

interface TrackingCheckpoint {
  status: string;
  at: string;
  note?: string | null;
  location?: string | null;
}

/**
 * Live courier fetch — env-gated. Expects the partner to answer
 * `GET {SHIPPING_API_URL}?awb=<awb>` with `{ status, checkpoints: [...] }`.
 * Plug a specific courier (Delhivery / Shiprocket / …) here. Returns null when
 * unconfigured or on any error, so tracking falls back to our own timeline.
 */
async function fetchCourierStatus(
  awb: string,
): Promise<{ status?: string; checkpoints: TrackingCheckpoint[] } | null> {
  if (!env.SHIPPING_API_URL) return null;
  try {
    const url = `${env.SHIPPING_API_URL}${env.SHIPPING_API_URL.includes('?') ? '&' : '?'}awb=${encodeURIComponent(awb)}`;
    const resp = await fetch(url, {
      headers: env.SHIPPING_API_TOKEN ? { Authorization: `Bearer ${env.SHIPPING_API_TOKEN}` } : {},
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      status?: string;
      checkpoints?: { status?: string; at?: string; note?: string; location?: string }[];
    };
    return {
      status: data.status,
      checkpoints: (data.checkpoints ?? []).map((c) => ({
        status: c.status ?? 'IN_TRANSIT',
        at: c.at ?? new Date().toISOString(),
        note: c.note ?? null,
        location: c.location ?? null,
      })),
    };
  } catch (err) {
    logger.warn({ err, awb }, 'courier tracking fetch failed');
    return null;
  }
}

/**
 * Shipment tracking for an order: courier + AWB + a checkpoint timeline. The
 * timeline is built from the order's lifecycle events, and enriched with live
 * courier checkpoints when a shipping partner API is configured and the order
 * has shipped.
 */
export async function getOrderTracking(
  actor: { sub: string; type: 'STAFF' | 'CUSTOMER' },
  id: string,
) {
  const order = await getOrder(actor, id); // authorizes + includes events

  const checkpoints: TrackingCheckpoint[] = (order.events ?? [])
    .map((e) => ({
      status: e.status,
      at: e.createdAt.toISOString(),
      note: e.note ?? (e.user ? `by ${e.user.name}` : null),
    }))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const base = {
    orderNumber: order.orderNumber,
    status: order.status,
    courierName: order.courierName,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
    shippedAt: order.shippedAt,
    deliveredAt: order.deliveredAt,
    live: false,
    checkpoints,
  };

  if (order.trackingNumber && (order.status === OrderStatus.SHIPPED || order.status === OrderStatus.DELIVERED)) {
    const live = await fetchCourierStatus(order.trackingNumber);
    if (live) {
      return {
        ...base,
        live: true,
        status: live.status ?? base.status,
        checkpoints: live.checkpoints.length ? live.checkpoints : checkpoints,
      };
    }
  }
  return base;
}

interface CourierBooking {
  awb: string;
  courierName: string;
  trackingUrl?: string;
  labelUrl?: string;
}

/** Books a shipment with the configured courier (env-gated). Throws a clear
 *  error when no courier API is configured — staff then enter the AWB manually. */
async function createCourierShipment(order: {
  orderNumber: string;
  shipName: string;
  shipPhone: string;
  shipLine1: string;
  shipLine2: string | null;
  shipCity: string;
  shipState: string;
  shipPincode: string;
  amountDuePaise: number;
  paymentStatus: OrderPaymentStatus;
}): Promise<CourierBooking> {
  if (!env.COURIER_API_URL) {
    throw ApiError.badRequest(
      'Courier integration is not configured. Set COURIER_API_URL, or enter the AWB manually via "Mark shipped".',
    );
  }
  const resp = await fetch(env.COURIER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.COURIER_API_TOKEN ? { Authorization: `Bearer ${env.COURIER_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      orderNumber: order.orderNumber,
      consignee: {
        name: order.shipName,
        phone: order.shipPhone,
        line1: order.shipLine1,
        line2: order.shipLine2,
        city: order.shipCity,
        state: order.shipState,
        pincode: order.shipPincode,
      },
      // Collect the balance on delivery for orders that aren't fully paid.
      codAmountPaise: order.paymentStatus === OrderPaymentStatus.PAID ? 0 : order.amountDuePaise,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    logger.error({ status: resp.status, text }, 'courier booking failed');
    throw ApiError.badRequest('Courier booking failed — please retry or enter the AWB manually');
  }
  const data = (await resp.json()) as {
    awb?: string;
    trackingNumber?: string;
    courierName?: string;
    trackingUrl?: string;
    labelUrl?: string;
  };
  const awb = data.awb ?? data.trackingNumber;
  if (!awb) throw ApiError.badRequest('Courier did not return an AWB');
  return {
    awb,
    courierName: data.courierName ?? env.COURIER_NAME,
    trackingUrl: data.trackingUrl,
    labelUrl: data.labelUrl,
  };
}

/** Auto-books a shipment with the courier, then marks the order SHIPPED with the
 *  returned AWB. Returns the updated order plus any shipping-label URL. */
export async function bookShipment(id: string, actorId?: string) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
    throw ApiError.badRequest(`Cannot ship a ${order.status.toLowerCase()} order`);
  }
  const booking = await createCourierShipment(order);
  const updated = await shipOrder(
    id,
    {
      courierName: booking.courierName,
      trackingNumber: booking.awb,
      trackingUrl: booking.trackingUrl,
    },
    actorId,
  );
  return { order: updated, labelUrl: booking.labelUrl ?? null };
}
