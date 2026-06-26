import { Prisma, ProductUnit } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { runWithoutTenant } from '../../lib/tenantContext';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';

/**
 * Products split into two concerns now:
 *  - Catalog (Product): shared definition — name, category, HSN, GST, MOQ, image.
 *  - Inventory (StoreProduct): per-store price, stock and quantity tiers.
 *
 * Customers always see the STORE-SCOPED view (catalog + their store's price/
 * stock), composed back into the flat product shape the apps already consume.
 */

// ---- Shared shape returned to customers / store views -----------------------

type CatalogProduct = Prisma.ProductGetPayload<{ include: { category: true } }>;
export type StoreProductWithTiers = Prisma.StoreProductGetPayload<{
  include: { product: { include: { category: true, variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } } }; priceTiers: true };
}>;

export function composeStoreProduct(
  sp: StoreProductWithTiers,
  rating?: { avg: number; count: number },
) {
  const p = sp.product;
  return {
    ratingAvg: rating ? Math.round(rating.avg * 10) / 10 : 0,
    ratingCount: rating?.count ?? 0,
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    brand: p.brand,
    categoryId: p.categoryId,
    categoryName: p.category?.name ?? null,
    tags: p.tags,
    unit: p.unit,
    hsnCode: p.hsnCode,
    gstRatePercent: p.gstRatePercent,
    moqQty: p.moqQty,
    imageUrl: p.imageUrl,
    // Per-store price / stock / MRP
    pricePaise: sp.pricePaise,
    mrpPaise: sp.mrpPaise ?? p.mrpPaise,
    stockQty: sp.stockQty,
    inStock: sp.stockQty > 0,
    // Whether this product is sold via variants (size/colour). When true the
    // apps prompt the shopper to pick a variant instead of one-tap add.
    hasVariants: p.variants.length > 0,
    priceTiers: [...sp.priceTiers]
      .sort((a, b) => a.minQty - b.minQty)
      .map((t) => ({ minQty: t.minQty, pricePaise: t.pricePaise })),
  };
}

/** Average rating + review count for a set of products (for catalog cards). */
async function ratingsFor(productIds: string[]) {
  const empty = new Map<string, { avg: number; count: number }>();
  if (productIds.length === 0) return empty;
  const rows = await prisma.review.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds } },
    _avg: { rating: true },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.productId, { avg: r._avg.rating ?? 0, count: r._count._all }]));
}

/**
 * Search filter over name + brand + tags. Tags (stored lower-case) make search
 * friendlier — e.g. "festive" or "cotton" finds products tagged that way even
 * when the word isn't in the name.
 */
function productSearchWhere(search?: string): Prisma.ProductWhereInput {
  const q = search?.trim();
  if (!q) return {};
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    OR: [
      { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { brand: { contains: q, mode: Prisma.QueryMode.insensitive } },
      { tags: { hasSome: tokens } },
    ],
  };
}

// ---- Store-scoped catalog (customer & agent store view) ---------------------

export type ProductSort = 'NEWEST' | 'PRICE_ASC' | 'PRICE_DESC' | 'NAME';

interface StoreListParams {
  storeId: string;
  page: number;
  limit: number;
  search?: string;
  categoryId?: string;
  sort?: ProductSort;
  brand?: string;
  minPricePaise?: number;
  maxPricePaise?: number;
  inStock?: boolean;
}

const STORE_PRODUCT_ORDER: Record<ProductSort, Prisma.StoreProductOrderByWithRelationInput> = {
  NEWEST: { createdAt: 'desc' },
  PRICE_ASC: { pricePaise: 'asc' },
  PRICE_DESC: { pricePaise: 'desc' },
  NAME: { product: { name: 'asc' } },
};

/** Returns products a store actually stocks, with that store's price/stock/tiers. */
export async function listStoreProducts(params: StoreListParams) {
  const { storeId, page, limit, search, categoryId, sort, brand, minPricePaise, maxPricePaise, inStock } =
    params;

  const productWhere: Prisma.ProductWhereInput = {
    isActive: true,
    ...productSearchWhere(search),
    ...(brand ? { brand: { equals: brand, mode: Prisma.QueryMode.insensitive } } : {}),
  };

  // Category filter is tree-aware: a parent includes its children.
  if (categoryId) {
    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      include: { children: { select: { id: true } } },
    });
    productWhere.categoryId = category
      ? { in: [category.id, ...category.children.map((c) => c.id)] }
      : categoryId;
  }

  const where: Prisma.StoreProductWhereInput = {
    storeId,
    isActive: true,
    product: productWhere,
    ...(inStock ? { stockQty: { gt: 0 } } : {}),
    ...(minPricePaise != null || maxPricePaise != null
      ? {
          pricePaise: {
            ...(minPricePaise != null ? { gte: minPricePaise } : {}),
            ...(maxPricePaise != null ? { lte: maxPricePaise } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.storeProduct.findMany({
      where,
      include: { product: { include: { category: true, variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } } }, priceTiers: true },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: STORE_PRODUCT_ORDER[sort ?? 'NEWEST'],
    }),
    prisma.storeProduct.count({ where }),
  ]);

  const ratings = await ratingsFor(rows.map((r) => r.productId));
  return {
    items: rows.map((r) => composeStoreProduct(r, ratings.get(r.productId))),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** Distinct brands a store stocks — powers the catalog's brand filter. */
export async function listStoreBrands(storeId: string): Promise<string[]> {
  const rows = await prisma.product.findMany({
    where: {
      isActive: true,
      brand: { not: null },
      storeProducts: { some: { storeId, isActive: true } },
    },
    select: { brand: true },
    distinct: ['brand'],
    orderBy: { brand: 'asc' },
  });
  return rows.map((r) => r.brand).filter((b): b is string => Boolean(b));
}

/** A single store-scoped product (catalog + store price/stock/tiers). */
export async function getStoreProduct(storeId: string, productId: string) {
  const sp = await prisma.storeProduct.findUnique({
    where: { storeId_productId: { storeId, productId } },
    include: { product: { include: { category: true, variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } } }, priceTiers: true },
  });
  if (!sp || !sp.isActive || !sp.product.isActive) {
    throw ApiError.notFound('Product not found in your store');
  }
  const rating = (await ratingsFor([productId])).get(productId);
  return composeStoreProduct(sp, rating);
}

// ---- Home feed (best-selling / recently ordered) ----------------------------

/** Compose the store view for a list of product ids, preserving their order
 *  and dropping any the store no longer actively stocks. */
export async function storeProductsByIds(storeId: string, productIds: string[]) {
  if (productIds.length === 0) return [];
  const rows = await prisma.storeProduct.findMany({
    where: {
      storeId,
      isActive: true,
      productId: { in: productIds },
      product: { isActive: true },
    },
    include: { product: { include: { category: true, variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } } }, priceTiers: true },
  });
  const byId = new Map(rows.map((r) => [r.productId, r]));
  const ratings = await ratingsFor(rows.map((r) => r.productId));
  return productIds
    .map((id) => byId.get(id))
    .filter((r): r is StoreProductWithTiers => Boolean(r))
    .map((r) => composeStoreProduct(r, ratings.get(r.productId)));
}

/** Best sellers in a store/city — ranked by total quantity ordered there.
 *  This is a store-wide aggregate across all shops, so it runs privileged:
 *  under a customer's RLS context the groupBy would otherwise see only the
 *  signed-in customer's own order items. */
export async function bestSellingForStore(storeId: string, limit = 10) {
  return runWithoutTenant(async () => {
    const grouped = await prisma.orderItem.groupBy({
      by: ['productId'],
      where: { order: { storeId } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit * 2, // headroom: some may be unstocked/inactive and filtered out
    });
    const items = await storeProductsByIds(storeId, grouped.map((g) => g.productId));
    return items.slice(0, limit);
  });
}

/** Products this customer ordered before (most recent first, de-duplicated),
 *  limited to what their store still stocks. */
export async function recentlyOrderedForCustomer(
  customerId: string,
  storeId: string,
  limit = 10,
) {
  const rows = await prisma.orderItem.findMany({
    where: { order: { customerId } },
    orderBy: { order: { createdAt: 'desc' } },
    select: { productId: true },
    take: 60,
  });
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const r of rows) {
    if (seen.has(r.productId)) continue;
    seen.add(r.productId);
    ids.push(r.productId);
    if (ids.length >= limit) break;
  }
  return storeProductsByIds(storeId, ids);
}

// ---- Catalog management (admin) ---------------------------------------------

interface CatalogListParams {
  page: number;
  limit: number;
  search?: string;
  categoryId?: string;
  isActive?: boolean;
}

/** The shared catalog (no price/stock). Used by admin to manage products. */
export async function listCatalog(params: CatalogListParams) {
  const { page, limit, search, categoryId, isActive } = params;
  const where: Prisma.ProductWhereInput = {
    ...(isActive !== undefined ? { isActive } : {}),
    ...productSearchWhere(search),
  };

  if (categoryId) {
    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      include: { children: { select: { id: true } } },
    });
    where.categoryId = category
      ? { in: [category.id, ...category.children.map((c) => c.id)] }
      : categoryId;
  }

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { storeProducts: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.product.count({ where }),
  ]);

  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getCatalogProduct(id: string): Promise<CatalogProduct> {
  const product = await prisma.product.findUnique({ where: { id }, include: { category: true } });
  if (!product) throw ApiError.notFound('Product not found');
  return product;
}

/** Stock-movement ledger for a product across stores (or one store for agents),
 *  with the store, variant, order and staff member resolved. */
export async function listProductMovements(
  productId: string,
  params: { storeId?: string | null; page: number; limit: number },
) {
  const where: Prisma.StockMovementWhereInput = {
    productId,
    ...(params.storeId ? { storeId: params.storeId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      include: {
        store: { select: { name: true, code: true } },
        variant: { select: { name: true } },
        user: { select: { name: true } },
        order: { select: { orderNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    }),
    prisma.stockMovement.count({ where }),
  ]);
  return {
    items,
    pagination: { page: params.page, limit: params.limit, total, totalPages: Math.ceil(total / params.limit) },
  };
}

interface CreateProductInput {
  name: string;
  description?: string;
  brand?: string;
  categoryId: string;
  tags?: string[];
  unit?: ProductUnit;
  hsnCode?: string;
  gstRatePercent?: number;
  mrpPaise?: number;
  moqQty?: number;
  imageUrl?: string;
  isActive?: boolean;
}

/** Trim, lower-case and de-dupe tags so search (hasSome) is predictable. */
function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const t of tags) {
    const n = t.trim().toLowerCase();
    if (n) seen.add(n);
  }
  return [...seen];
}

export async function createProduct(input: CreateProductInput) {
  return prisma.product.create({
    data: {
      name: input.name,
      slug: slugify(`${input.name}-${Date.now().toString(36)}`),
      description: input.description,
      brand: input.brand,
      categoryId: input.categoryId,
      tags: normalizeTags(input.tags),
      unit: input.unit ?? ProductUnit.PIECE,
      hsnCode: input.hsnCode,
      gstRatePercent: input.gstRatePercent ?? 0,
      mrpPaise: input.mrpPaise,
      moqQty: input.moqQty ?? 1,
      imageUrl: input.imageUrl,
      isActive: input.isActive ?? true,
    },
    include: { category: true },
  });
}

export async function updateProduct(
  id: string,
  input: Partial<CreateProductInput> & { mrpPaise?: number | null },
) {
  const { name, categoryId, tags, ...rest } = input;
  const data: Prisma.ProductUpdateInput = {
    description: rest.description,
    brand: rest.brand,
    unit: rest.unit,
    hsnCode: rest.hsnCode,
    gstRatePercent: rest.gstRatePercent,
    mrpPaise: rest.mrpPaise,
    moqQty: rest.moqQty,
    imageUrl: rest.imageUrl,
    isActive: rest.isActive,
  };
  if (tags !== undefined) data.tags = normalizeTags(tags);
  if (name) {
    data.name = name;
    data.slug = slugify(`${name}-${Date.now().toString(36)}`);
  }
  if (categoryId) data.category = { connect: { id: categoryId } };

  return prisma.product.update({ where: { id }, data, include: { category: true } });
}

export async function deleteProduct(id: string) {
  // Soft delete — preserves order/cart references; isActive filters hide it.
  await prisma.product.update({ where: { id }, data: { isActive: false } }).catch(() => {
    throw ApiError.notFound('Product not found');
  });
}

// ---- Reviews ----------------------------------------------------------------

/** A product's rating summary + recent reviews (newest first). */
export async function listReviews(productId: string) {
  const [summary, items] = await Promise.all([
    prisma.review.aggregate({
      where: { productId },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.review.findMany({
      where: { productId },
      include: { customer: { select: { shopName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);
  return {
    summary: {
      avg: Math.round((summary._avg.rating ?? 0) * 10) / 10,
      count: summary._count._all,
    },
    items: items.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      shopName: r.customer.shopName,
      createdAt: r.createdAt,
    })),
  };
}

/** The signed-in shop's own review for a product, if any (to prefill the form). */
export async function myReview(customerId: string, productId: string) {
  return prisma.review.findUnique({
    where: { productId_customerId: { productId, customerId } },
  });
}

/** Create or update the shop's review for a product (one per shop per product). */
export async function upsertReview(
  customerId: string,
  productId: string,
  input: { rating: number; comment?: string | null },
) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw ApiError.notFound('Product not found');
  return prisma.review.upsert({
    where: { productId_customerId: { productId, customerId } },
    create: { productId, customerId, rating: input.rating, comment: input.comment ?? null },
    update: { rating: input.rating, comment: input.comment ?? null },
  });
}
