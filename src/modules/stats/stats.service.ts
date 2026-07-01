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

/** Receivables: money owed per customer (unpaid balances), with overdue and
 *  credit-limit utilisation. Store-scoped for agents. */
export async function receivables(storeId: string | null) {
  const now = new Date();
  const orders = await prisma.order.findMany({
    where: {
      ...(storeId ? { storeId } : {}),
      amountDuePaise: { gt: 0 },
      status: { notIn: ['CANCELLED', 'RETURNED'] },
    },
    select: {
      customerId: true,
      amountDuePaise: true,
      dueDate: true,
      customer: {
        select: { shopName: true, phone: true, creditLimitPaise: true, creditApproved: true },
      },
    },
  });

  interface Row {
    customerId: string;
    shopName: string;
    phone: string;
    creditLimitPaise: number;
    creditApproved: boolean;
    outstandingPaise: number;
    overduePaise: number;
    oldestDueDate: Date | null;
    ordersWithDue: number;
  }
  const byCustomer = new Map<string, Row>();
  for (const o of orders) {
    let row = byCustomer.get(o.customerId);
    if (!row) {
      row = {
        customerId: o.customerId,
        shopName: o.customer.shopName,
        phone: o.customer.phone,
        creditLimitPaise: o.customer.creditLimitPaise,
        creditApproved: o.customer.creditApproved,
        outstandingPaise: 0,
        overduePaise: 0,
        oldestDueDate: null,
        ordersWithDue: 0,
      };
      byCustomer.set(o.customerId, row);
    }
    row.outstandingPaise += o.amountDuePaise;
    row.ordersWithDue += 1;
    if (o.dueDate && o.dueDate < now) {
      row.overduePaise += o.amountDuePaise;
      if (!row.oldestDueDate || o.dueDate < row.oldestDueDate) row.oldestDueDate = o.dueDate;
    }
  }

  const customers = [...byCustomer.values()]
    .map((r) => ({
      ...r,
      utilizationPct:
        r.creditLimitPaise > 0 ? Math.round((r.outstandingPaise / r.creditLimitPaise) * 100) : null,
      overLimit: r.creditLimitPaise > 0 && r.outstandingPaise > r.creditLimitPaise,
    }))
    .sort((a, b) => b.outstandingPaise - a.outstandingPaise);

  return {
    summary: {
      totalOutstandingPaise: customers.reduce((s, c) => s + c.outstandingPaise, 0),
      totalOverduePaise: customers.reduce((s, c) => s + c.overduePaise, 0),
      customersWithDues: customers.length,
      overLimitCount: customers.filter((c) => c.overLimit).length,
    },
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
