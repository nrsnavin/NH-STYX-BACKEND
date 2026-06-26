import { CouponType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { createCoupon } from '../coupons/coupon.service';

/**
 * One-click win-back: mint a single-use percentage coupon for a specific shop
 * (locked to its serving store, valid 30 days) and log it on the customer's
 * timeline so the agent can share the code (e.g. over WhatsApp).
 */
export async function createWinbackOffer(
  customerId: string,
  opts: { percent?: number; minOrderPaise?: number },
) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, shopName: true, storeId: true },
  });
  if (!customer) throw ApiError.notFound('Customer not found');

  const percent = Math.min(Math.max(Math.round(opts.percent ?? 10), 1), 50);
  const code = `WB${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const endsAt = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const coupon = await createCoupon({
    code,
    description: `Win-back offer for ${customer.shopName}`,
    type: CouponType.PERCENT,
    value: percent,
    minOrderPaise: opts.minOrderPaise ?? 0,
    usageLimit: 1,
    perCustomerLimit: 1,
    endsAt,
    storeId: customer.storeId ?? null,
    isActive: true,
  });

  await prisma.activity.create({
    data: {
      type: 'NOTE',
      body: `Win-back offer ${code} (${percent}% off) created`,
      customerId,
    },
  });

  return { code: coupon.code, percent, endsAt: coupon.endsAt };
}
