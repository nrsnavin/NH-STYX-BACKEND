import { z } from 'zod';
import { CustomerStatus } from '@prisma/client';

export const listCustomersSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().optional(),
    status: z.nativeEnum(CustomerStatus).optional(),
  }),
});

export const customerIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const updateCustomerSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    shopName: z.string().min(2).optional(),
    ownerName: z.string().min(2).optional(),
    email: z.string().email().nullable().optional(),
    gstin: z.string().length(15).nullable().optional(),
    creditApproved: z.boolean().optional(),
    creditLimitPaise: z.number().int().nonnegative().optional(),
    creditDays: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
    storeId: z.string().uuid().nullable().optional(),
  }),
});

export const approveCustomerSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    creditApproved: z.boolean().optional(),
    creditLimitPaise: z.number().int().nonnegative().optional(),
    creditDays: z.number().int().nonnegative().optional(),
  }),
});

export const rejectCustomerSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().max(300).optional() }),
});
