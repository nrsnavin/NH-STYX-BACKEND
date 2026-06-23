import { Prisma, ProductUnit } from '@prisma/client';
import { prisma } from '../../lib/prisma';
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
  include: { product: { include: { category: true } }; priceTiers: true };
}>;

export function composeStoreProduct(sp: StoreProductWithTiers) {
  const p = sp.product;
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    brand: p.brand,
    categoryId: p.categoryId,
    categoryName: p.category?.name ?? null,
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
    priceTiers: [...sp.priceTiers]
      .sort((a, b) => a.minQty - b.minQty)
      .map((t) => ({ minQty: t.minQty, pricePaise: t.pricePaise })),
  };
}

// ---- Store-scoped catalog (customer & agent store view) ---------------------

interface StoreListParams {
  storeId: string;
  page: number;
  limit: number;
  search?: string;
  categoryId?: string;
}

/** Returns products a store actually stocks, with that store's price/stock/tiers. */
export async function listStoreProducts(params: StoreListParams) {
  const { storeId, page, limit, search, categoryId } = params;

  const productWhere: Prisma.ProductWhereInput = {
    isActive: true,
    ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
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
  };

  const [rows, total] = await Promise.all([
    prisma.storeProduct.findMany({
      where,
      include: { product: { include: { category: true } }, priceTiers: true },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.storeProduct.count({ where }),
  ]);

  return {
    items: rows.map(composeStoreProduct),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** A single store-scoped product (catalog + store price/stock/tiers). */
export async function getStoreProduct(storeId: string, productId: string) {
  const sp = await prisma.storeProduct.findUnique({
    where: { storeId_productId: { storeId, productId } },
    include: { product: { include: { category: true } }, priceTiers: true },
  });
  if (!sp || !sp.isActive || !sp.product.isActive) {
    throw ApiError.notFound('Product not found in your store');
  }
  return composeStoreProduct(sp);
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
    ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
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

interface CreateProductInput {
  name: string;
  description?: string;
  brand?: string;
  categoryId: string;
  unit?: ProductUnit;
  hsnCode?: string;
  gstRatePercent?: number;
  mrpPaise?: number;
  moqQty?: number;
  imageUrl?: string;
  isActive?: boolean;
}

export async function createProduct(input: CreateProductInput) {
  return prisma.product.create({
    data: {
      name: input.name,
      slug: slugify(`${input.name}-${Date.now().toString(36)}`),
      description: input.description,
      brand: input.brand,
      categoryId: input.categoryId,
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
  const { name, categoryId, ...rest } = input;
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
  if (name) {
    data.name = name;
    data.slug = slugify(`${name}-${Date.now().toString(36)}`);
  }
  if (categoryId) data.category = { connect: { id: categoryId } };

  return prisma.product.update({ where: { id }, data, include: { category: true } });
}

export async function deleteProduct(id: string) {
  await prisma.product.delete({ where: { id } });
}
