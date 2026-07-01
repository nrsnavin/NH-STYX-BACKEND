import { z } from 'zod';

const bundleItem = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const createBundleSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(120),
    description: z.string().max(1000).nullish(),
    imageUrl: z.string().url().max(500).nullish().or(z.literal('')),
    isActive: z.boolean().optional(),
    items: z.array(bundleItem).min(1, 'Add at least one product'),
  }),
});

export const updateBundleSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).max(120).optional(),
    description: z.string().max(1000).nullish(),
    imageUrl: z.string().url().max(500).nullish().or(z.literal('')),
    isActive: z.boolean().optional(),
    items: z.array(bundleItem).min(1).optional(),
  }),
});

export const bundleIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});
