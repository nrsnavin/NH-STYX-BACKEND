import { z } from 'zod';

export const addItemSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
  }),
});

export const updateItemSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
  body: z.object({
    quantity: z.number().int().nonnegative(), // 0 removes the line
  }),
});

export const itemParamSchema = z.object({
  params: z.object({ productId: z.string().uuid() }),
});
