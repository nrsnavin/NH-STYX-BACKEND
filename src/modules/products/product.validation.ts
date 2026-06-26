import { z } from 'zod';
import { ProductUnit } from '@prisma/client';

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
    // Customer catalog filter + sort.
    sort: z.enum(['NEWEST', 'PRICE_ASC', 'PRICE_DESC', 'NAME']).optional(),
    brand: z.string().optional(),
    minPricePaise: z.coerce.number().int().nonnegative().optional(),
    maxPricePaise: z.coerce.number().int().nonnegative().optional(),
    inStock: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),
});

// Catalog fields only — price, stock and quantity tiers live on StoreProduct
// (managed per store via the stores module).
export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    brand: z.string().optional(),
    categoryId: z.string().uuid(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    unit: z.nativeEnum(ProductUnit).default(ProductUnit.PIECE),
    hsnCode: z.string().optional(),
    gstRatePercent: z.number().int().min(0).max(28).default(0),
    mrpPaise: z.number().int().nonnegative().optional(),
    moqQty: z.number().int().positive().default(1),
    imageUrl: z.string().url().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    description: z.string().optional(),
    brand: z.string().optional(),
    categoryId: z.string().uuid().optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    unit: z.nativeEnum(ProductUnit).optional(),
    hsnCode: z.string().optional(),
    gstRatePercent: z.number().int().min(0).max(28).optional(),
    mrpPaise: z.number().int().nonnegative().nullable().optional(),
    moqQty: z.number().int().positive().optional(),
    imageUrl: z.string().url().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const productIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const productMovementsSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(30),
  }),
});
