import { z } from 'zod';
import { OrderStatus, PaymentMethod } from '@prisma/client';

export const createOrderSchema = z.object({
  body: z.object({
    addressId: z.string().uuid(),
    paymentMethod: z.nativeEnum(PaymentMethod),
    notes: z.string().optional(),
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
