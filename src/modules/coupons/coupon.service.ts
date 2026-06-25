import { Coupon, CouponType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { getCustomerStoreId } from '../../utils/storeContext';
import { getCart } from '../cart/cart.service';

const rs = (paise: number) => `₹${Math.round(paise / 100)}`;

/** Pure discount computation for a coupon against an order subtotal (paise).
 *  Capped at maxDiscountPaise (PERCENT) and never more than the subtotal. */
export function discountFor(
  coupon: Pick<Coupon, 'type' | 'value' | 'maxDiscountPaise'>,
  subtotalPaise: number,
): number {
  let discount =
    coupon.type === CouponType.PERCENT
      ? Math.floor((subtotalPaise * coupon.value) / 100)
      : coupon.value;
  if (coupon.maxDiscountPaise != null) discount = Math.min(discount, coupon.maxDiscountPaise);
  return Math.max(0, Math.min(discount, subtotalPaise));
}

interface ValidateInput {
  code: string;
  customerId: string;
  storeId: string | null;
  subtotalPaise: number;
}

/**
 * Validates a coupon for a customer + order subtotal, returning the coupon and
 * the discount it grants. Throws ApiError with a shopper-friendly message when
 * the code is unknown, inactive, out of window, below the minimum, store-locked
 * or over its usage limits.
 */
export async function validateCoupon(
  input: ValidateInput,
): Promise<{ coupon: Coupon; discountPaise: number }> {
  const code = input.code.trim().toUpperCase();
  if (!code) throw ApiError.badRequest('Enter a coupon code');

  const coupon = await prisma.coupon.findUnique({ where: { code } });
  if (!coupon || !coupon.isActive) throw ApiError.badRequest('This coupon is not valid');

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) throw ApiError.badRequest('This coupon is not active yet');
  if (coupon.endsAt && coupon.endsAt < now) throw ApiError.badRequest('This coupon has expired');
  if (coupon.storeId && coupon.storeId !== input.storeId) {
    throw ApiError.badRequest('This coupon is not valid for your store');
  }
  if (input.subtotalPaise < coupon.minOrderPaise) {
    throw ApiError.badRequest(
      `Spend ${rs(coupon.minOrderPaise)} or more to use this coupon`,
    );
  }
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    throw ApiError.badRequest('This coupon has reached its usage limit');
  }
  if (coupon.perCustomerLimit != null) {
    const used = await prisma.couponRedemption.count({
      where: { couponId: coupon.id, customerId: input.customerId },
    });
    if (used >= coupon.perCustomerLimit) throw ApiError.badRequest('You have already used this coupon');
  }

  const discountPaise = discountFor(coupon, input.subtotalPaise);
  if (discountPaise <= 0) throw ApiError.badRequest('This coupon gives no discount on your order');
  return { coupon, discountPaise };
}

/** Preview a coupon against the customer's current server-side cart. */
export async function previewForCart(customerId: string, code: string) {
  const storeId = await getCustomerStoreId(customerId);
  const cart = await getCart(customerId);
  if (cart.subtotalPaise <= 0) throw ApiError.badRequest('Your cart is empty');
  const { coupon, discountPaise } = await validateCoupon({
    code,
    customerId,
    storeId,
    subtotalPaise: cart.subtotalPaise,
  });
  return {
    code: coupon.code,
    type: coupon.type,
    description: coupon.description,
    subtotalPaise: cart.subtotalPaise,
    discountPaise,
  };
}

/** Records a redemption and bumps the usage counter. Call inside the checkout
 *  transaction so it commits atomically with the order. */
export async function redeem(
  tx: Prisma.TransactionClient,
  couponId: string,
  customerId: string,
  orderId: string,
  discountPaise: number,
) {
  await tx.couponRedemption.create({ data: { couponId, customerId, orderId, discountPaise } });
  await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } });
}

// ---- Admin management --------------------------------------------------------

export async function listCoupons() {
  const coupons = await prisma.coupon.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { redemptions: true } }, store: { select: { name: true } } },
  });
  return coupons;
}

interface CouponInput {
  code: string;
  description?: string;
  type: CouponType;
  value: number;
  minOrderPaise?: number;
  maxDiscountPaise?: number | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  storeId?: string | null;
  isActive?: boolean;
}

export async function createCoupon(input: CouponInput) {
  const code = input.code.trim().toUpperCase();
  const existing = await prisma.coupon.findUnique({ where: { code } });
  if (existing) throw ApiError.conflict('A coupon with this code already exists');
  return prisma.coupon.create({
    data: {
      code,
      description: input.description?.trim() || null,
      type: input.type,
      value: input.value,
      minOrderPaise: input.minOrderPaise ?? 0,
      maxDiscountPaise: input.maxDiscountPaise ?? null,
      usageLimit: input.usageLimit ?? null,
      perCustomerLimit: input.perCustomerLimit ?? null,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      storeId: input.storeId ?? null,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateCoupon(id: string, input: Partial<CouponInput>) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw ApiError.notFound('Coupon not found');
  const data: Prisma.CouponUpdateInput = {
    description: input.description?.trim() || null,
    type: input.type,
    value: input.value,
    minOrderPaise: input.minOrderPaise,
    maxDiscountPaise: input.maxDiscountPaise ?? null,
    usageLimit: input.usageLimit ?? null,
    perCustomerLimit: input.perCustomerLimit ?? null,
    startsAt: input.startsAt ? new Date(input.startsAt) : input.startsAt === null ? null : undefined,
    endsAt: input.endsAt ? new Date(input.endsAt) : input.endsAt === null ? null : undefined,
    isActive: input.isActive,
  };
  if (input.code) data.code = input.code.trim().toUpperCase();
  if (input.storeId !== undefined) {
    data.store = input.storeId ? { connect: { id: input.storeId } } : { disconnect: true };
  }
  return prisma.coupon.update({ where: { id }, data });
}

export async function deleteCoupon(id: string) {
  await prisma.coupon
    .update({ where: { id }, data: { isActive: false } })
    .catch(() => {
      throw ApiError.notFound('Coupon not found');
    });
}
