import { z } from 'zod';

export const addItemSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid().optional(),
    quantity: z.number().int().positive(),
  }),
});

export const updateItemSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
  body: z.object({
    variantId: z.string().uuid().optional(),
    quantity: z.number().int().nonnegative(), // 0 removes the line
  }),
});

export const itemParamSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
  // variantId travels as a query param on DELETE (no body).
  query: z.object({ variantId: z.string().uuid().optional() }),
});
