import { Prisma, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { normalizeCity } from '../../utils/storeContext';

// ---- Stores -----------------------------------------------------------------

const storeInclude = {
  serviceAreas: { orderBy: { label: 'asc' } },
  _count: { select: { agents: true, customers: true, inventory: true } },
} satisfies Prisma.StoreInclude;

/** Agents see only their store; admins (storeId null) see all. */
export async function listStores(scopeStoreId?: string | null) {
  return prisma.store.findMany({
    where: scopeStoreId ? { id: scopeStoreId } : {},
    include: storeInclude,
    orderBy: { name: 'asc' },
  });
}

export async function getStore(id: string) {
  const store = await prisma.store.findUnique({ where: { id }, include: storeInclude });
  if (!store) throw ApiError.notFound('Store not found');
  return store;
}

/**
 * Public list of serviceable cities + the store that serves each. Powers the
 * city dropdown on the (pre-auth) registration screen.
 */
export async function listServiceCities() {
  const areas = await prisma.serviceArea.findMany({
    where: { store: { isActive: true } },
    include: { store: { select: { name: true, city: true } } },
    orderBy: { label: 'asc' },
  });
  return areas.map((a) => ({ city: a.label, storeName: a.store.name, storeCity: a.store.city }));
}

interface StoreInput {
  name: string;
  code: string;
  phone?: string;
  addressLine?: string;
  city: string;
  state: string;
  stateCode: string;
  pincode?: string;
  isActive?: boolean;
}

export async function createStore(input: StoreInput) {
  const exists = await prisma.store.findUnique({ where: { code: input.code } });
  if (exists) throw ApiError.conflict(`A store with code "${input.code}" already exists`);
  return prisma.store.create({ data: input, include: storeInclude });
}

export async function updateStore(id: string, input: Partial<StoreInput>) {
  await prisma.store.findUniqueOrThrow({ where: { id } }).catch(() => {
    throw ApiError.notFound('Store not found');
  });
  return prisma.store.update({ where: { id }, data: input, include: storeInclude });
}

// ---- Service areas (city → store routing) -----------------------------------

export async function addServiceArea(storeId: string, label: string) {
  await prisma.store.findUniqueOrThrow({ where: { id: storeId } }).catch(() => {
    throw ApiError.notFound('Store not found');
  });
  const city = normalizeCity(label);
  const clash = await prisma.serviceArea.findUnique({ where: { city } });
  if (clash) {
    throw ApiError.conflict(
      clash.storeId === storeId
        ? `"${label}" is already served by this store`
        : `"${label}" is already served by another store`,
    );
  }
  return prisma.serviceArea.create({ data: { city, label: label.trim(), storeId } });
}

export async function removeServiceArea(areaId: string) {
  await prisma.serviceArea.delete({ where: { id: areaId } }).catch(() => {
    throw ApiError.notFound('Service area not found');
  });
}

// ---- Per-store inventory (price + stock + tiers) ----------------------------

interface InventoryListParams {
  page: number;
  limit: number;
  search?: string;
  categoryId?: string;
}

/**
 * Catalog products with this store's price/stock attached (null when not yet
 * stocked) — the working surface for managing a store's inventory.
 */
export async function listStoreInventory(storeId: string, params: InventoryListParams) {
  const { page, limit, search, categoryId } = params;
  const where: Prisma.ProductWhereInput = {
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

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        storeProducts: { where: { storeId }, include: { priceTiers: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { name: 'asc' },
    }),
    prisma.product.count({ where }),
  ]);

  const items = products.map((p) => {
    const sp = p.storeProducts[0];
    return {
      productId: p.id,
      name: p.name,
      brand: p.brand,
      unit: p.unit,
      gstRatePercent: p.gstRatePercent,
      moqQty: p.moqQty,
      mrpPaise: p.mrpPaise,
      imageUrl: p.imageUrl,
      categoryName: p.category?.name ?? null,
      stocked: Boolean(sp),
      storeProduct: sp
        ? {
            pricePaise: sp.pricePaise,
            mrpPaise: sp.mrpPaise,
            stockQty: sp.stockQty,
            isActive: sp.isActive,
            priceTiers: [...sp.priceTiers]
              .sort((a, b) => a.minQty - b.minQty)
              .map((t) => ({ minQty: t.minQty, pricePaise: t.pricePaise })),
          }
        : null,
    };
  });

  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

interface UpsertStoreProductInput {
  pricePaise: number;
  mrpPaise?: number | null;
  stockQty?: number;
  isActive?: boolean;
  priceTiers?: { minQty: number; pricePaise: number }[];
}

/** Create or update a store's price/stock/tiers for a product. */
export async function upsertStoreProduct(
  storeId: string,
  productId: string,
  input: UpsertStoreProductInput,
) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw ApiError.notFound('Product not found');

  return prisma.$transaction(async (tx) => {
    const sp = await tx.storeProduct.upsert({
      where: { storeId_productId: { storeId, productId } },
      create: {
        storeId,
        productId,
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

    if (input.priceTiers) {
      await tx.storePriceTier.deleteMany({ where: { storeProductId: sp.id } });
      if (input.priceTiers.length) {
        await tx.storePriceTier.createMany({
          data: input.priceTiers.map((t) => ({
            storeProductId: sp.id,
            minQty: t.minQty,
            pricePaise: t.pricePaise,
          })),
        });
      }
    }

    return tx.storeProduct.findUniqueOrThrow({
      where: { id: sp.id },
      include: { priceTiers: { orderBy: { minQty: 'asc' } } },
    });
  });
}

/**
 * Bulk-imports a store's price + stock from a CSV. Columns: slug (or name),
 * price (in rupees), stock. Matches catalog products and upserts StoreProducts.
 */
export async function importInventory(storeId: string, csv: string) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw ApiError.badRequest('CSV has no data rows');

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = {
    slug: header.indexOf('slug'),
    name: header.indexOf('name'),
    price: header.indexOf('price'),
    stock: header.indexOf('stock'),
  };
  if (col.price < 0 || col.stock < 0 || (col.slug < 0 && col.name < 0)) {
    throw ApiError.badRequest('CSV needs columns: slug (or name), price, stock');
  }

  const result = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const slug = col.slug >= 0 ? cells[col.slug] : undefined;
    const name = col.name >= 0 ? cells[col.name] : undefined;
    const price = Number(cells[col.price]);
    const stock = Number(cells[col.stock]);
    if (Number.isNaN(price) || Number.isNaN(stock)) {
      result.errors.push(`Row ${i + 1}: invalid price/stock`);
      continue;
    }
    const product = slug
      ? await prisma.product.findUnique({ where: { slug } })
      : await prisma.product.findFirst({
          where: { name: { equals: name, mode: Prisma.QueryMode.insensitive } },
        });
    if (!product) {
      result.skipped++;
      result.errors.push(`Row ${i + 1}: product not found (${slug ?? name})`);
      continue;
    }
    const existing = await prisma.storeProduct.findUnique({
      where: { storeId_productId: { storeId, productId: product.id } },
    });
    await prisma.storeProduct.upsert({
      where: { storeId_productId: { storeId, productId: product.id } },
      create: { storeId, productId: product.id, pricePaise: Math.round(price * 100), stockQty: Math.round(stock) },
      update: { pricePaise: Math.round(price * 100), stockQty: Math.round(stock) },
    });
    if (existing) result.updated++;
    else result.created++;
  }
  return result;
}

export async function removeStoreProduct(storeId: string, productId: string) {
  await prisma.storeProduct
    .delete({ where: { storeId_productId: { storeId, productId } } })
    .catch(() => {
      throw ApiError.notFound('This product is not stocked in the store');
    });
}

// ---- Agent assignment -------------------------------------------------------

const agentSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  storeId: true,
  store: { select: { id: true, name: true, city: true, code: true } },
} satisfies Prisma.UserSelect;

/** All agents (admins assign them to stores). Optionally filter by store. */
export async function listAgents(storeId?: string | null) {
  return prisma.user.findMany({
    where: { role: Role.AGENT, ...(storeId ? { storeId } : {}) },
    select: agentSelect,
    orderBy: { name: 'asc' },
  });
}

export async function assignAgent(storeId: string, userId: string) {
  await prisma.store.findUniqueOrThrow({ where: { id: storeId } }).catch(() => {
    throw ApiError.notFound('Store not found');
  });
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('Staff member not found');
  if (user.role !== Role.AGENT) throw ApiError.badRequest('Only agents can be assigned to a store');
  return prisma.user.update({ where: { id: userId }, data: { storeId }, select: agentSelect });
}

export async function unassignAgent(userId: string) {
  return prisma.user.update({ where: { id: userId }, data: { storeId: null }, select: agentSelect });
}
