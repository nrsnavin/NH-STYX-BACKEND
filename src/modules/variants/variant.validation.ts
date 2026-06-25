import { z } from 'zod';

const variantBody = z.object({
  name: z.string().min(1).max(120),
  sku: z.string().max(60).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  mrpPaise: z.number().int().nonnegative().nullable().optional(),
  imageUrl: z.string().url().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const productIdParamSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
});

export const createVariantSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
  body: variantBody,
});

export const updateVariantSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: variantBody.partial(),
});

export const variantIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const storeVariantsQuerySchema = z.object({
  params: z.object({ storeId: z.string().uuid() }),
  query: z.object({ productId: z.string().uuid() }),
});

export const upsertStoreVariantSchema = z.object({
  params: z.object({ storeId: z.string().uuid(), variantId: z.string().uuid() }),
  body: z.object({
    pricePaise: z.number().int().nonnegative(),
    mrpPaise: z.number().int().nonnegative().nullable().optional(),
    stockQty: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const storeVariantIdSchema = z.object({
  params: z.object({ storeId: z.string().uuid(), variantId: z.string().uuid() }),
});
