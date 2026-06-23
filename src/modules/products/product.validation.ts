import { z } from 'zod';
import { ProductUnit } from '@prisma/client';

const priceTier = z.object({
  minQty: z.number().int().positive(),
  pricePaise: z.number().int().nonnegative(),
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
    categoryId: z.string().uuid(),
    unit: z.nativeEnum(ProductUnit).default(ProductUnit.PIECE),
    hsnCode: z.string().optional(),
    gstRatePercent: z.number().int().min(0).max(28).default(0),
    mrpPaise: z.number().int().nonnegative().optional(),
    pricePaise: z.number().int().nonnegative(),
    moqQty: z.number().int().positive().default(1),
    stockQty: z.number().int().nonnegative().default(0),
    imageUrl: z.string().url().optional(),
    isActive: z.boolean().optional(),
    priceTiers: z.array(priceTier).optional(),
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    description: z.string().optional(),
    brand: z.string().optional(),
    categoryId: z.string().uuid().optional(),
    unit: z.nativeEnum(ProductUnit).optional(),
    hsnCode: z.string().optional(),
    gstRatePercent: z.number().int().min(0).max(28).optional(),
    mrpPaise: z.number().int().nonnegative().nullable().optional(),
    pricePaise: z.number().int().nonnegative().optional(),
    moqQty: z.number().int().positive().optional(),
    stockQty: z.number().int().nonnegative().optional(),
    imageUrl: z.string().url().optional(),
    isActive: z.boolean().optional(),
    // When provided, replaces the full tier set for the product.
    priceTiers: z.array(priceTier).optional(),
  }),
});

export const productIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});
