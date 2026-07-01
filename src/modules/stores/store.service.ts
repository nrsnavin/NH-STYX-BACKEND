import { Prisma, Role, StockMovementType } from '@prisma/client';
import { basePrisma, prisma, tenantTransaction } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { recordStockMovement } from '../../utils/ledger';
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
            reorderLevel: sp.reorderLevel,
            reorderQty: sp.reorderQty,
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
  reorderLevel?: number;
  reorderQty?: number;
  isActive?: boolean;
  priceTiers?: { minQty: number; pricePaise: number }[];
}

/** Create or update a store's price/stock/tiers for a product. */
export async function upsertStoreProduct(
  storeId: string,
  productId: string,
  input: UpsertStoreProductInput,
  actorId?: string,
) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw ApiError.notFound('Product not found');

  return tenantTransaction(async (tx) => {
    const before = await tx.storeProduct.findUnique({
      where: { storeId_productId: { storeId, productId } },
      select: { stockQty: true },
    });
    const oldStock = before?.stockQty ?? 0;

    const sp = await tx.storeProduct.upsert({
      where: { storeId_productId: { storeId, productId } },
      create: {
        storeId,
        productId,
        pricePaise: input.pricePaise,
        mrpPaise: input.mrpPaise ?? undefined,
        stockQty: input.stockQty ?? 0,
        reorderLevel: input.reorderLevel ?? 0,
        reorderQty: input.reorderQty ?? 0,
        isActive: input.isActive ?? true,
      },
      update: {
        pricePaise: input.pricePaise,
        mrpPaise: input.mrpPaise,
        stockQty: input.stockQty,
        reorderLevel: input.reorderLevel,
        reorderQty: input.reorderQty,
        isActive: input.isActive,
      },
    });

    // Ledger the stock change (manual edits show as RESTOCK / ADJUSTMENT).
    const delta = sp.stockQty - oldStock;
    if (delta !== 0) {
      await recordStockMovement(tx, {
        storeId,
        productId,
        deltaQty: delta,
        type: delta > 0 ? StockMovementType.RESTOCK : StockMovementType.ADJUSTMENT,
        userId: actorId,
        reason: 'Manual stock update',
      });
    }

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
export async function importInventory(storeId: string, csv: string, actorId?: string) {
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
    const newStock = Math.round(stock);
    await prisma.storeProduct.upsert({
      where: { storeId_productId: { storeId, productId: product.id } },
      create: { storeId, productId: product.id, pricePaise: Math.round(price * 100), stockQty: newStock },
      update: { pricePaise: Math.round(price * 100), stockQty: newStock },
    });
    const delta = newStock - (existing?.stockQty ?? 0);
    if (delta !== 0) {
      // Staff CSV path (no customer RLS context) — use the base client, which
      // is assignable to TransactionClient. StockMovement isn't RLS-scoped.
      await recordStockMovement(basePrisma, {
        storeId,
        productId: product.id,
        deltaQty: delta,
        type: StockMovementType.ADJUSTMENT,
        userId: actorId,
        reason: 'CSV import',
      });
    }
    if (existing) result.updated++;
    else result.created++;
  }
  return result;
}

// ---- Stock adjustments & stock-take -----------------------------------------

interface AdjustStockInput {
  mode: 'delta' | 'set';
  quantity: number; // delta → signed change; set → the new absolute count
  reason?: string;
}

/**
 * Adjust one store-product's stock and ledger the change as an ADJUSTMENT.
 * `delta` applies a signed change (damage, shrinkage, found stock); `set`
 * records the outcome of a physical count. The product must already be stocked.
 */
export async function adjustStock(
  storeId: string,
  productId: string,
  input: AdjustStockInput,
  actorId?: string,
) {
  return tenantTransaction(async (tx) => {
    const sp = await tx.storeProduct.findUnique({
      where: { storeId_productId: { storeId, productId } },
      include: { product: { select: { name: true } } },
    });
    if (!sp) throw ApiError.badRequest('Add this product to the store before adjusting its stock');

    const before = sp.stockQty;
    const after = input.mode === 'set' ? input.quantity : before + input.quantity;
    if (after < 0) {
      throw ApiError.badRequest(`Adjustment would drop stock below zero (currently ${before})`);
    }
    const delta = after - before;
    if (delta === 0) return { storeProduct: sp, before, after, delta };

    const updated = await tx.storeProduct.update({
      where: { id: sp.id },
      data: { stockQty: after },
    });
    await recordStockMovement(tx, {
      storeId,
      productId,
      deltaQty: delta,
      type: StockMovementType.ADJUSTMENT,
      userId: actorId,
      reason: input.reason?.trim() || (input.mode === 'set' ? 'Stock count' : 'Manual adjustment'),
    });
    return { storeProduct: updated, before, after, delta };
  });
}

interface StockTakeInput {
  reason?: string;
  counts: { productId: string; countedQty: number }[];
}

/**
 * Reconcile physically-counted quantities against system stock — records an
 * ADJUSTMENT for every product whose count differs. Products not stocked in the
 * store are skipped and reported back.
 */
export async function stockTake(storeId: string, input: StockTakeInput, actorId?: string) {
  const note = input.reason?.trim() ? `Stock take — ${input.reason.trim()}` : 'Stock take';
  return tenantTransaction(async (tx) => {
    const lines: {
      productId: string;
      name: string;
      before: number;
      after: number;
      delta: number;
    }[] = [];
    let unchanged = 0;
    const skipped: string[] = [];

    for (const c of input.counts) {
      const sp = await tx.storeProduct.findUnique({
        where: { storeId_productId: { storeId, productId: c.productId } },
        include: { product: { select: { name: true } } },
      });
      if (!sp) {
        skipped.push(c.productId);
        continue;
      }
      const delta = c.countedQty - sp.stockQty;
      if (delta === 0) {
        unchanged++;
        continue;
      }
      await tx.storeProduct.update({ where: { id: sp.id }, data: { stockQty: c.countedQty } });
      await recordStockMovement(tx, {
        storeId,
        productId: c.productId,
        deltaQty: delta,
        type: StockMovementType.ADJUSTMENT,
        userId: actorId,
        reason: note,
      });
      lines.push({
        productId: c.productId,
        name: sp.product.name,
        before: sp.stockQty,
        after: c.countedQty,
        delta,
      });
    }
    return { adjusted: lines.length, unchanged, skipped, lines };
  });
}

interface TransferStockInput {
  toStoreId: string;
  productId: string;
  quantity: number;
  reason?: string;
}

/**
 * Move stock of one product from one store to another. Records a paired ledger
 * entry (out of the source, into the destination) atomically. If the
 * destination doesn't stock the product yet, it's created at the source's price.
 */
export async function transferStock(
  fromStoreId: string,
  input: TransferStockInput,
  actorId?: string,
) {
  if (fromStoreId === input.toStoreId) {
    throw ApiError.badRequest('Source and destination stores must be different');
  }
  const [fromStore, toStore, product] = await Promise.all([
    prisma.store.findUnique({ where: { id: fromStoreId } }),
    prisma.store.findUnique({ where: { id: input.toStoreId } }),
    prisma.product.findUnique({ where: { id: input.productId } }),
  ]);
  if (!fromStore) throw ApiError.notFound('Source store not found');
  if (!toStore) throw ApiError.notFound('Destination store not found');
  if (!product) throw ApiError.notFound('Product not found');

  const suffix = input.reason?.trim() ? ` — ${input.reason.trim()}` : '';

  return tenantTransaction(async (tx) => {
    const source = await tx.storeProduct.findUnique({
      where: { storeId_productId: { storeId: fromStoreId, productId: input.productId } },
    });
    if (!source || !source.isActive) {
      throw ApiError.badRequest(`${product.name} is not stocked at ${fromStore.name}`);
    }
    if (source.stockQty < input.quantity) {
      throw ApiError.badRequest(`Only ${source.stockQty} in stock at ${fromStore.name}`);
    }

    // Out of the source.
    await tx.storeProduct.update({
      where: { id: source.id },
      data: { stockQty: { decrement: input.quantity } },
    });
    await recordStockMovement(tx, {
      storeId: fromStoreId,
      productId: input.productId,
      deltaQty: -input.quantity,
      type: StockMovementType.ADJUSTMENT,
      userId: actorId,
      reason: `Transfer to ${toStore.name}${suffix}`,
    });

    // Into the destination (create at the source's price if not yet stocked).
    const existingDest = await tx.storeProduct.findUnique({
      where: { storeId_productId: { storeId: input.toStoreId, productId: input.productId } },
    });
    const dest = await tx.storeProduct.upsert({
      where: { storeId_productId: { storeId: input.toStoreId, productId: input.productId } },
      create: {
        storeId: input.toStoreId,
        productId: input.productId,
        pricePaise: source.pricePaise,
        mrpPaise: source.mrpPaise ?? undefined,
        stockQty: input.quantity,
        isActive: true,
      },
      update: { stockQty: { increment: input.quantity } },
    });
    await recordStockMovement(tx, {
      storeId: input.toStoreId,
      productId: input.productId,
      deltaQty: input.quantity,
      type: StockMovementType.ADJUSTMENT,
      userId: actorId,
      reason: `Transfer from ${fromStore.name}${suffix}`,
    });

    return {
      quantity: input.quantity,
      productName: product.name,
      createdDestination: !existingDest,
      from: { storeId: fromStoreId, name: fromStore.name, stockQty: source.stockQty - input.quantity },
      to: { storeId: input.toStoreId, name: toStore.name, stockQty: dest.stockQty },
    };
  });
}

/** The stock movement ledger for a store (optionally one product). */
export async function listStockMovements(
  storeId: string,
  params: { productId?: string; page: number; limit: number },
) {
  const where: Prisma.StockMovementWhereInput = {
    storeId,
    ...(params.productId ? { productId: params.productId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      include: {
        product: { select: { id: true, name: true } },
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
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.ceil(total / params.limit),
    },
  };
}

export async function removeStoreProduct(storeId: string, productId: string) {
  // Soft delete (delist) — keeps the row + its ledger history.
  await prisma.storeProduct
    .update({ where: { storeId_productId: { storeId, productId } }, data: { isActive: false } })
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
