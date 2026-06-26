import { z } from 'zod';
import { QuotationStatus } from '@prisma/client';

const itemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().positive(),
  unitPricePaise: z.number().int().nonnegative().optional(),
});

export const listQuotationsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    status: z.nativeEnum(QuotationStatus).optional(),
    search: z.string().optional(),
    customerId: z.string().uuid().optional(),
  }),
});

export const quotationIdSchema = z.object({ params: z.object({ id: z.string().uuid() }) });

export const createQuotationSchema = z.object({
  body: z
    .object({
      customerId: z.string().uuid().optional(),
      leadId: z.string().uuid().optional(),
      title: z.string().max(200).optional(),
      notes: z.string().max(2000).optional(),
      validUntil: z.string().datetime().nullable().optional(),
      discountPaise: z.number().int().nonnegative().optional(),
      items: z.array(itemSchema).min(1),
    })
    .refine((b) => b.customerId || b.leadId, { message: 'Choose a customer or a lead' }),
});

export const updateQuotationSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    title: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    validUntil: z.string().datetime().nullable().optional(),
    discountPaise: z.number().int().nonnegative().optional(),
    items: z.array(itemSchema).min(1).optional(),
  }),
});

export const setQuotationStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ status: z.nativeEnum(QuotationStatus) }),
});

export const convertQuotationSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    paymentMethod: z.enum(['CREDIT', 'BANK_TRANSFER']),
    addressId: z.string().uuid().optional(),
  }),
});

export const respondQuotationSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ action: z.enum(['ACCEPT', 'DECLINE']) }),
});
