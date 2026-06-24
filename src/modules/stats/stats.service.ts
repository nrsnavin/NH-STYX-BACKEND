import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const LOW_STOCK_THRESHOLD = 10;

/** Store-scoped dashboard metrics. storeId null = all stores (admin). */
export async function dashboard(storeId: string | null) {
  const orderWhere: Prisma.OrderWhereInput = storeId ? { storeId } : {};
  const storeFilter = storeId ? { storeId } : {};

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [sales, month, statusGroups, pendingApprovals, credit, lowStock, leadGroups, customers] =
    await Promise.all([
      prisma.order.aggregate({ where: orderWhere, _sum: { totalPaise: true }, _count: { _all: true } }),
      prisma.order.aggregate({
        where: { ...orderWhere, createdAt: { gte: startOfMonth } },
        _sum: { totalPaise: true },
        _count: { _all: true },
      }),
      prisma.order.groupBy({ by: ['status'], where: orderWhere, _count: { _all: true } }),
      prisma.customer.count({ where: { status: 'PENDING', ...storeFilter } }),
      prisma.order.aggregate({
        where: { ...orderWhere, paymentMethod: 'CREDIT', paymentStatus: { not: 'PAID' } },
        _sum: { amountDuePaise: true },
      }),
      prisma.storeProduct.count({
        where: { isActive: true, stockQty: { lte: LOW_STOCK_THRESHOLD }, ...storeFilter },
      }),
      prisma.lead.groupBy({ by: ['stage'], where: storeFilter, _count: { _all: true } }),
      prisma.customer.count({ where: storeFilter }),
    ]);

  const ordersByStatus: Record<string, number> = {};
  for (const g of statusGroups) ordersByStatus[g.status] = g._count._all;
  const leadsByStage: Record<string, number> = {};
  for (const g of leadGroups) leadsByStage[g.stage] = g._count._all;

  return {
    sales: {
      totalPaise: sales._sum.totalPaise ?? 0,
      orderCount: sales._count._all,
      thisMonthPaise: month._sum.totalPaise ?? 0,
      thisMonthOrders: month._count._all,
    },
    ordersByStatus,
    pendingApprovals,
    creditOutstandingPaise: credit._sum.amountDuePaise ?? 0,
    lowStockCount: lowStock,
    leadsByStage,
    customers,
  };
}

/** Store products at or below the low-stock threshold. */
export async function lowStock(storeId: string | null, threshold = LOW_STOCK_THRESHOLD) {
  const rows = await prisma.storeProduct.findMany({
    where: { isActive: true, stockQty: { lte: threshold }, ...(storeId ? { storeId } : {}) },
    include: {
      product: { select: { name: true, unit: true } },
      store: { select: { name: true, city: true } },
    },
    orderBy: { stockQty: 'asc' },
    take: 100,
  });
  return rows.map((r) => ({
    productId: r.productId,
    storeId: r.storeId,
    name: r.product.name,
    unit: r.product.unit,
    storeName: r.store.name,
    storeCity: r.store.city,
    stockQty: r.stockQty,
  }));
}
