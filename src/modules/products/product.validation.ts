import { z } from 'zod';

const variantSchema = z.object({
  sku: z.string().min(1),
  size: z.string().optional(),
  color: z.string().optional(),
  price: z.number().nonnegative(),
  mrp: z.number().nonnegative().optional(),
  minOrderQty: z.number().int().positive().default(1),
  stockQuantity: z.number().int().nonnegative().default(0),
  isActive: z.boolean().optional(),
});

export const listProductsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().optional(),
    categoryId: z.string().uuid().optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),
});

export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    brand: z.string().optional(),
    imageUrls: z.array(z.string().url()).optional(),
    categoryId: z.string().uuid(),
    isActive: z.boolean().optional(),
    variants: z.array(variantSchema).min(1, 'At least one variant is required'),
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    description: z.string().optional(),
    brand: z.string().optional(),
    imageUrls: z.array(z.string().url()).optional(),
    categoryId: z.string().uuid().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const productIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});
