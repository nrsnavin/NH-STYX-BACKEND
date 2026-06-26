import { z } from 'zod';

export const createReturnSchema = z.object({
  body: z.object({
    orderId: z.string().uuid(),
    reason: z.string().max(500).optional(),
    items: z
      .array(
        z.object({
          orderItemId: z.string().uuid(),
          quantity: z.number().int().positive(),
        }),
      )
      .min(1, 'Select at least one item to return'),
  }),
});

export const returnIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const rejectReturnSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().max(500).optional() }),
});
