import { z } from 'zod';

const priceTier = z.object({
  minQty: z.number().int().positive(),
  pricePaise: z.number().int().nonnegative(),
});

const stateCode = z.string().regex(/^\d{2}$/, 'State code must be 2 digits (e.g. "27")');

export const listStoresSchema = z.object({ query: z.object({}).optional() });

export const storeIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const createStoreSchema = z.object({
  body: z.object({
    name: z.string().min(2),
    code: z.string().min(2).max(12).regex(/^[A-Za-z0-9_-]+$/, 'Code: letters, digits, - or _ only'),
    phone: z.string().optional(),
    addressLine: z.string().optional(),
    city: z.string().min(2),
    state: z.string().min(2),
    stateCode,
    pincode: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits').optional(),
    isActive: z.boolean().optional(),
  }),
});

export const updateStoreSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    code: z.string().min(2).max(12).regex(/^[A-Za-z0-9_-]+$/).optional(),
    phone: z.string().nullable().optional(),
    addressLine: z.string().nullable().optional(),
    city: z.string().min(2).optional(),
    state: z.string().min(2).optional(),
    stateCode: stateCode.optional(),
    pincode: z.string().regex(/^\d{6}$/).nullable().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const addServiceAreaSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ city: z.string().min(2) }),
});

export const areaIdSchema = z.object({
  params: z.object({ areaId: z.string().uuid() }),
});

export const listInventorySchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().optional(),
    categoryId: z.string().uuid().optional(),
  }),
});

export const upsertStoreProductSchema = z.object({
  params: z.object({ id: z.string().uuid(), productId: z.string().uuid() }),
  body: z.object({
    pricePaise: z.number().int().nonnegative(),
    mrpPaise: z.number().int().nonnegative().nullable().optional(),
    stockQty: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
    priceTiers: z.array(priceTier).optional(),
  }),
});

export const storeProductIdSchema = z.object({
  params: z.object({ id: z.string().uuid(), productId: z.string().uuid() }),
});

export const assignAgentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ userId: z.string().uuid() }),
});

export const agentUserIdSchema = z.object({
  params: z.object({ userId: z.string().uuid() }),
});
