import { z } from 'zod';
import { PurchaseOrderStatus } from '@prisma/client';

// ---- Suppliers --------------------------------------------------------------

export const listSuppliersSchema = z.object({
  query: z.object({
    search: z.string().optional(),
    activeOnly: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),
});

export const supplierIdSchema = z.object({ params: z.object({ id: z.string().uuid() }) });

export const createSupplierSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(120),
    phone: z.string().max(20).optional(),
    email: z.string().email().optional(),
    gstin: z.string().max(20).optional(),
    addressLine: z.string().max(300).optional(),
  }),
});

export const updateSupplierSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).max(120).optional(),
    phone: z.string().max(20).nullable().optional(),
    email: z.string().email().nullable().optional(),
    gstin: z.string().max(20).nullable().optional(),
    addressLine: z.string().max(300).nullable().optional(),
    isActive: z.boolean().optional(),
  }),
});

// ---- Low stock --------------------------------------------------------------

export const lowStockSchema = z.object({
  query: z.object({ storeId: z.string().uuid().optional() }),
});

// ---- Purchase orders --------------------------------------------------------

const poItem = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  orderedQty: z.number().int().positive(),
  unitCostPaise: z.number().int().nonnegative(),
});

export const listPurchaseOrdersSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    status: z.nativeEnum(PurchaseOrderStatus).optional(),
    supplierId: z.string().uuid().optional(),
    search: z.string().optional(),
  }),
});

export const purchaseOrderIdSchema = z.object({ params: z.object({ id: z.string().uuid() }) });

export const createPurchaseOrderSchema = z.object({
  body: z.object({
    storeId: z.string().uuid().optional(), // admins target any store; agents use their own
    supplierId: z.string().uuid(),
    notes: z.string().max(2000).optional(),
    expectedAt: z.string().datetime().nullable().optional(),
    items: z.array(poItem).min(1),
  }),
});

export const updatePurchaseOrderSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    supplierId: z.string().uuid().optional(),
    notes: z.string().max(2000).nullable().optional(),
    expectedAt: z.string().datetime().nullable().optional(),
    items: z.array(poItem).min(1).optional(),
  }),
});

export const setPurchaseOrderStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ status: z.enum(['ORDERED', 'CANCELLED']) }),
});

export const receivePurchaseOrderSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    lines: z
      .array(z.object({ itemId: z.string().uuid(), receiveQty: z.number().int().positive() }))
      .min(1),
  }),
});
