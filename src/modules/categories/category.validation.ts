import { z } from 'zod';

export const createCategorySchema = z.object({
  body: z.object({
    name: z.string().min(2),
    imageUrl: z.string().url().optional(),
    parentId: z.string().uuid().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const updateCategorySchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    imageUrl: z.string().url().optional(),
    parentId: z.string().uuid().nullable().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const categoryIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});
