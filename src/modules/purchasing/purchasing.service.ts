import { Prisma, PurchaseOrderStatus, StockMovementType } from '@prisma/client';
import { prisma, tenantTransaction } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { recordStockMovement } from '../../utils/ledger';

const poInclude = {
  store: { select: { id: true, name: true, city: true } },
  supplier: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, name: true } },
  items: true,
} satisfies Prisma.PurchaseOrderInclude;

// ---- Suppliers --------------------------------------------------------------

export async function listSuppliers(params: { search?: string; activeOnly?: boolean }) {
  return prisma.supplier.findMany({
    where: {
      ...(params.activeOnly ? { isActive: true } : {}),
      ...(params.search
        ? { name: { contains: params.search, mode: Prisma.QueryMode.insensitive } }
        : {}),
    },
    orderBy: { name: 'asc' },
  });
}

export async function createSupplier(input: {
  name: string;
  phone?: string;
  email?: string;
  gstin?: string;
  addressLine?: string;
}) {
  return prisma.supplier.create({ data: input });
}

export async function updateSupplier(
  id: string,
  input: Partial<{
    name: string;
    phone: string | null;
    email: string | null;
    gstin: string | null;
    addressLine: string | null;
    isActive: boolean;
  }>,
) {
  await prisma.supplier.findUniqueOrThrow({ where: { id } }).catch(() => {
    throw ApiError.notFound('Supplier not found');
  });
  return prisma.supplier.update({ where: { id }, data: input });
}

// ---- Low stock --------------------------------------------------------------

/** Store products at/below their reorder level (the replenishment work list). */
export async function lowStock(storeId: string | null) {
  const rows = await prisma.storeProduct.findMany({
    where: { isActive: true, reorderLevel: { gt: 0 }, ...(storeId ? { storeId } : {}) },
    include: {
      product: { select: { id: true, name: true, brand: true, unit: true, imageUrl: true } },
      store: { select: { id: true, name: true, city: true } },
    },
    orderBy: { stockQty: 'asc' },
  });
  // Column-to-column compare (stockQty <= reorderLevel) isn't expressible in a
  // Prisma where, so narrow with reorderLevel > 0 then filter in memory.
  return rows
    .filter((r) => r.stockQty <= r.reorderLevel)
    .map((r) => ({
      productId: r.productId,
      storeId: r.storeId,
      storeName: r.store.name,
      storeCity: r.store.city,
      name: r.product.name,
      brand: r.product.brand,
      unit: r.product.unit,
      imageUrl: r.product.imageUrl,
      stockQty: r.stockQty,
      reorderLevel: r.reorderLevel,
      reorderQty: r.reorderQty,
      pricePaise: r.pricePaise,
      suggestedQty: r.reorderQty > 0 ? r.reorderQty : Math.max(r.reorderLevel * 2 - r.stockQty, 1),
    }));
}

// ---- Purchase orders --------------------------------------------------------

async function nextPoNumber(tx: Prisma.TransactionClient): Promise<string> {
  const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('po_number_seq')`;
  return `PO-${new Date().getFullYear()}-${String(Number(nextval)).padStart(5, '0')}`;
}

interface PoItemInput {
  productId: string;
  variantId?: string | null;
  orderedQty: number;
  unitCostPaise: number;
}

async function buildPoItems(items: PoItemInput[]) {
  const productIds = [...new Set(items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
  const productById = new Map(products.map((p) => [p.id, p]));
  const variantIds = items.filter((i) => i.variantId).map((i) => i.variantId!);
  const variants = variantIds.length
    ? await prisma.productVariant.findMany({ where: { id: { in: variantIds } } })
    : [];
  const variantById = new Map(variants.map((v) => [v.id, v]));

  let totalCostPaise = 0;
  const rows = items.map(({ productId, variantId, orderedQty, unitCostPaise }) => {
    const product = productById.get(productId);
    if (!product) throw ApiError.badRequest('A selected product was not found');
    let variantName: string | null = null;
    if (variantId) {
      const variant = variantById.get(variantId);
      if (!variant || variant.productId !== productId) {
        throw ApiError.badRequest(`Invalid option for ${product.name}`);
      }
      variantName = variant.name;
    }
    const lineCostPaise = unitCostPaise * orderedQty;
    totalCostPaise += lineCostPaise;
    return {
      productId,
      variantId: variantId ?? null,
      productName: product.name,
      variantName,
      orderedQty,
      receivedQty: 0,
      unitCostPaise,
      lineCostPaise,
    };
  });
  return { rows, totalCostPaise };
}

export async function listPurchaseOrders(params: {
  page: number;
  limit: number;
  status?: PurchaseOrderStatus;
  supplierId?: string;
  search?: string;
  storeId?: string | null;
}) {
  const { page, limit, status, supplierId, search, storeId } = params;
  const where: Prisma.PurchaseOrderWhereInput = {
    ...(storeId ? { storeId } : {}),
    ...(status ? { status } : {}),
    ...(supplierId ? { supplierId } : {}),
    ...(search
      ? {
          OR: [
            { poNumber: { contains: search, mode: Prisma.QueryMode.insensitive } },
            { supplier: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: poInclude,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getPurchaseOrder(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: poInclude });
  if (!po) throw ApiError.notFound('Purchase order not found');
  return po;
}

export async function createPurchaseOrder(
  input: {
    storeId?: string;
    supplierId: string;
    notes?: string;
    expectedAt?: string | null;
    items: PoItemInput[];
  },
  staff: { id: string; storeId: string | null },
) {
  const storeId = staff.storeId ?? input.storeId ?? null;
  if (!storeId) throw ApiError.badRequest('Choose a store for this purchase order');

  const [supplier, store] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: input.supplierId } }),
    prisma.store.findUnique({ where: { id: storeId } }),
  ]);
  if (!supplier) throw ApiError.notFound('Supplier not found');
  if (!store) throw ApiError.notFound('Store not found');

  const built = await buildPoItems(input.items);
  return tenantTransaction(async (tx) => {
    const poNumber = await nextPoNumber(tx);
    return tx.purchaseOrder.create({
      data: {
        poNumber,
        status: PurchaseOrderStatus.DRAFT,
        storeId,
        supplierId: input.supplierId,
        createdById: staff.id,
        notes: input.notes,
        expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
        totalCostPaise: built.totalCostPaise,
        items: { create: built.rows },
      },
      include: poInclude,
    });
  });
}

export async function updatePurchaseOrder(
  id: string,
  input: {
    supplierId?: string;
    notes?: string | null;
    expectedAt?: string | null;
    items?: PoItemInput[];
  },
) {
  const existing = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Purchase order not found');
  if (existing.status !== PurchaseOrderStatus.DRAFT) {
    throw ApiError.badRequest('Only draft purchase orders can be edited');
  }
  if (input.supplierId) {
    const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier) throw ApiError.notFound('Supplier not found');
  }

  const data: Prisma.PurchaseOrderUpdateInput = {
    ...(input.supplierId ? { supplier: { connect: { id: input.supplierId } } } : {}),
    notes: input.notes,
    expectedAt:
      input.expectedAt === undefined ? undefined : input.expectedAt ? new Date(input.expectedAt) : null,
  };

  if (input.items) {
    const built = await buildPoItems(input.items);
    return tenantTransaction(async (tx) => {
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
      return tx.purchaseOrder.update({
        where: { id },
        data: { ...data, totalCostPaise: built.totalCostPaise, items: { create: built.rows } },
        include: poInclude,
      });
    });
  }
  return prisma.purchaseOrder.update({ where: { id }, data, include: poInclude });
}

export async function setStatus(id: string, status: 'ORDERED' | 'CANCELLED') {
  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw ApiError.notFound('Purchase order not found');
  if (po.status === PurchaseOrderStatus.RECEIVED) {
    throw ApiError.badRequest('This purchase order is already received');
  }
  if (po.status === PurchaseOrderStatus.CANCELLED) {
    throw ApiError.badRequest('This purchase order is cancelled');
  }
  if (status === 'ORDERED' && po.status !== PurchaseOrderStatus.DRAFT) {
    throw ApiError.badRequest('Only a draft purchase order can be marked ordered');
  }
  return prisma.purchaseOrder.update({
    where: { id },
    data: { status: status as PurchaseOrderStatus },
    include: poInclude,
  });
}

/**
 * Receive goods against a PO: add the received quantities to store stock,
 * write RESTOCK ledger rows linked back to the PO, and advance the PO to
 * PARTIAL or RECEIVED. New store rows are created inactive (priced at cost)
 * so received-but-unpriced stock isn't accidentally sold.
 */
export async function receivePurchaseOrder(
  id: string,
  lines: { itemId: string; receiveQty: number }[],
  staffSub: string,
) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
  if (!po) throw ApiError.notFound('Purchase order not found');
  if (po.status !== PurchaseOrderStatus.ORDERED && po.status !== PurchaseOrderStatus.PARTIAL) {
    throw ApiError.badRequest('Mark the purchase order as ordered before receiving goods');
  }

  const itemById = new Map(po.items.map((i) => [i.id, i]));
  for (const l of lines) {
    const it = itemById.get(l.itemId);
    if (!it) throw ApiError.badRequest('A received line is not part of this purchase order');
    if (it.receivedQty + l.receiveQty > it.orderedQty) {
      throw ApiError.badRequest(`Cannot receive more than ordered for ${it.productName}`);
    }
  }

  return tenantTransaction(async (tx) => {
    for (const l of lines) {
      const it = itemById.get(l.itemId)!;
      if (it.variantId) {
        await tx.storeVariant.upsert({
          where: { storeId_variantId: { storeId: po.storeId, variantId: it.variantId } },
          create: {
            storeId: po.storeId,
            variantId: it.variantId,
            pricePaise: it.unitCostPaise,
            stockQty: l.receiveQty,
            isActive: false,
          },
          update: { stockQty: { increment: l.receiveQty } },
        });
      } else {
        await tx.storeProduct.upsert({
          where: { storeId_productId: { storeId: po.storeId, productId: it.productId } },
          create: {
            storeId: po.storeId,
            productId: it.productId,
            pricePaise: it.unitCostPaise,
            stockQty: l.receiveQty,
            isActive: false,
          },
          update: { stockQty: { increment: l.receiveQty } },
        });
      }

      await recordStockMovement(tx, {
        storeId: po.storeId,
        productId: it.productId,
        variantId: it.variantId,
        deltaQty: l.receiveQty,
        type: StockMovementType.RESTOCK,
        purchaseOrderId: po.id,
        userId: staffSub,
        reason: `PO ${po.poNumber} received`,
      });

      await tx.purchaseOrderItem.update({
        where: { id: it.id },
        data: { receivedQty: { increment: l.receiveQty } },
      });
    }

    const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } });
    const allReceived = items.every((i) => i.receivedQty >= i.orderedQty);
    return tx.purchaseOrder.update({
      where: { id },
      data: {
        status: allReceived ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIAL,
        receivedAt: allReceived ? new Date() : null,
      },
      include: poInclude,
    });
  });
}
