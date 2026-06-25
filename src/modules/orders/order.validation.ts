import { z } from 'zod';
import { OrderStatus, PaymentMethod } from '@prisma/client';

export const createOrderSchema = z.object({
  body: z.object({
    addressId: z.string().uuid(),
    // COD is not offered — online, credit (if approved) or bank transfer only.
    paymentMethod: z.enum(['RAZORPAY', 'CREDIT', 'BANK_TRANSFER']),
    notes: z.string().max(500).optional(),
    bankReference: z.string().max(120).optional(),
    couponCode: z.string().max(40).optional(),
  }),
});

/** Agent/admin places an order on behalf of a customer from explicit items. */
export const staffOrderSchema = z.object({
  body: z.object({
    customerId: z.string().uuid(),
    addressId: z.string().uuid().optional(),
    paymentMethod: z.enum(['RAZORPAY', 'CREDIT', 'BANK_TRANSFER']),
    items: z
      .array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive() }))
      .min(1, 'Add at least one item'),
    notes: z.string().max(500).optional(),
    bankReference: z.string().max(120).optional(),
  }),
});

export const listOrdersSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    status: z.nativeEnum(OrderStatus).optional(),
  }),
});

export const orderIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const updateOrderStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ status: z.nativeEnum(OrderStatus) }),
});

export const recordPaymentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    method: z.nativeEnum(PaymentMethod),
    amountPaise: z.number().int().positive(),
    reference: z.string().optional(),
  }),
});

export const razorpayVerifySchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    razorpayOrderId: z.string().min(3),
    razorpayPaymentId: z.string().min(3),
    razorpaySignature: z.string().min(3),
  }),
});
