import { Prisma, StockMovementType } from '@prisma/client';
import { prisma, tenantTransaction } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { recordStockMovement } from '../../utils/ledger';

/**
 * Product variants (e.g. "Red / M"). The variant is the shared definition;
 * price & stock are per-store (StoreVariant), mirroring StoreProduct.
 */

// ---- Customer-facing composition ---------------------------------------------

/** The store-carried variants of a product, with that store's price/stock.
 *  Variants the store doesn't actively stock are omitted. */
export async function composeStoreVariants(storeId: string, productId: string) {
  const variants = await prisma.productVariant.findMany({
    where: { productId, isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (variants.length === 0) return [];

  const stock = await prisma.storeVariant.findMany({
    where: { storeId, variantId: { in: variants.map((v) => v.id) } },
  });
  const byVariant = new Map(stock.map((s) => [s.variantId, s]));

  return variants.flatMap((v) => {
    const sv = byVariant.get(v.id);
    if (!sv || !sv.isActive) return [];
    return [
      {
        id: v.id,
        name: v.name,
        sku: v.sku,
        attributes: v.attributes,
        imageUrl: v.imageUrl ?? null,
        pricePaise: sv.pricePaise,
        mrpPaise: sv.mrpPaise ?? v.mrpPaise,
        stockQty: sv.stockQty,
        inStock: sv.stockQty > 0,
      },
    ];
  });
}

// ---- Catalog management (admin) ----------------------------------------------

export async function listVariants(productId: string) {
  return prisma.productVariant.findMany({
    where: { productId },
    orderBy: { sortOrder: 'asc' },
  });
}

interface VariantInput {
  name: string;
  sku?: string;
  attributes?: Prisma.InputJsonValue;
  mrpPaise?: number | null;
  imageUrl?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export async function createVariant(productId: string, input: VariantInput) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw ApiError.notFound('Product not found');
  if (input.sku) {
    const dupe = await prisma.productVariant.findUnique({ where: { sku: input.sku } });
    if (dupe) throw ApiError.conflict('A variant with this SKU already exists');
  }
  return prisma.productVariant.create({
    data: {
      productId,
      name: input.name.trim(),
      sku: input.sku?.trim() || null,
      attributes: input.attributes ?? Prisma.JsonNull,
      mrpPaise: input.mrpPaise ?? null,
      imageUrl: input.imageUrl,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateVariant(id: string, input: Partial<VariantInput>) {
  const variant = await prisma.productVariant.findUnique({ where: { id } });
  if (!variant) throw ApiError.notFound('Variant not found');
  if (input.sku && input.sku !== variant.sku) {
    const dupe = await prisma.productVariant.findUnique({ where: { sku: input.sku } });
    if (dupe) throw ApiError.conflict('A variant with this SKU already exists');
  }
  const data: Prisma.ProductVariantUpdateInput = {
    name: input.name?.trim(),
    sku: input.sku !== undefined ? input.sku?.trim() || null : undefined,
    mrpPaise: input.mrpPaise,
    imageUrl: input.imageUrl,
    sortOrder: input.sortOrder,
    isActive: input.isActive,
  };
  if (input.attributes !== undefined) data.attributes = input.attributes;
  return prisma.productVariant.update({ where: { id }, data });
}

export async function deleteVariant(id: string) {
  await prisma.productVariant
    .update({ where: { id }, data: { isActive: false } })
    .catch(() => {
      throw ApiError.notFound('Variant not found');
    });
  // Drop this variant from every shopper's cart (trusted admin path).
  await prisma.cartItem.deleteMany({ where: { variantId: id } });
}

// ---- Per-store inventory (admin / store agent) -------------------------------

/** A store's variants for a product, with this store's price/stock (or null
 *  when the store hasn't priced a variant yet). Powers the ops inventory UI. */
export async function listStoreVariants(storeId: string, productId: string) {
  const variants = await prisma.productVariant.findMany({
    where: { productId },
    orderBy: { sortOrder: 'asc' },
  });
  const stock = await prisma.storeVariant.findMany({
    where: { storeId, variantId: { in: variants.map((v) => v.id) } },
  });
  const byVariant = new Map(stock.map((s) => [s.variantId, s]));
  return variants.map((v) => ({
    id: v.id,
    name: v.name,
    sku: v.sku,
    attributes: v.attributes,
    mrpPaise: v.mrpPaise,
    isActive: v.isActive,
    storeVariant: byVariant.get(v.id)
      ? {
          pricePaise: byVariant.get(v.id)!.pricePaise,
          mrpPaise: byVariant.get(v.id)!.mrpPaise,
          stockQty: byVariant.get(v.id)!.stockQty,
          isActive: byVariant.get(v.id)!.isActive,
        }
      : null,
  }));
}

interface StoreVariantInput {
  pricePaise: number;
  mrpPaise?: number | null;
  stockQty?: number;
  isActive?: boolean;
}

export async function upsertStoreVariant(
  storeId: string,
  variantId: string,
  input: StoreVariantInput,
  actorId?: string,
) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, productId: true },
  });
  if (!variant) throw ApiError.notFound('Variant not found');

  return tenantTransaction(async (tx) => {
    const before = await tx.storeVariant.findUnique({
      where: { storeId_variantId: { storeId, variantId } },
      select: { stockQty: true },
    });
    const oldStock = before?.stockQty ?? 0;

    const sv = await tx.storeVariant.upsert({
      where: { storeId_variantId: { storeId, variantId } },
      create: {
        storeId,
        variantId,
        pricePaise: input.pricePaise,
        mrpPaise: input.mrpPaise ?? undefined,
        stockQty: input.stockQty ?? 0,
        isActive: input.isActive ?? true,
      },
      update: {
        pricePaise: input.pricePaise,
        mrpPaise: input.mrpPaise,
        stockQty: input.stockQty,
        isActive: input.isActive,
      },
    });

    const delta = sv.stockQty - oldStock;
    if (delta !== 0) {
      await recordStockMovement(tx, {
        storeId,
        productId: variant.productId,
        variantId,
        deltaQty: delta,
        type: delta > 0 ? StockMovementType.RESTOCK : StockMovementType.ADJUSTMENT,
        userId: actorId,
        reason: 'Manual variant stock update',
      });
    }
    return sv;
  });
}

export async function removeStoreVariant(storeId: string, variantId: string) {
  await prisma.storeVariant.updateMany({
    where: { storeId, variantId },
    data: { isActive: false },
  });
}
