import { z } from 'zod';

export const validateCouponSchema = z.object({
  body: z.object({ code: z.string().min(1).max(40) }),
});

const couponBody = z.object({
  code: z.string().min(2).max(40),
  description: z.string().max(200).optional(),
  type: z.enum(['PERCENT', 'FIXED']),
  value: z.number().int().positive(),
  minOrderPaise: z.number().int().nonnegative().optional(),
  maxDiscountPaise: z.number().int().positive().nullable().optional(),
  usageLimit: z.number().int().positive().nullable().optional(),
  perCustomerLimit: z.number().int().positive().nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  storeId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const createCouponSchema = z.object({
  body: couponBody.refine((b) => b.type !== 'PERCENT' || b.value <= 100, {
    message: 'A percent coupon must be between 1 and 100',
    path: ['value'],
  }),
});

export const updateCouponSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: couponBody.partial(),
});

export const couponIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});
