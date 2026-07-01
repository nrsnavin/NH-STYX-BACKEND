import {
  ActivityType,
  LeadStage,
  OrderStatus,
  Prisma,
  QuotationStatus,
  Role,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const LOW_STOCK_THRESHOLD = 10;

const OPEN_LEAD_STAGES: LeadStage[] = [LeadStage.NEW, LeadStage.CONTACTED, LeadStage.QUALIFIED];

/**
 * Per-agent sales performance. `selfUserId` limits it to one agent (an agent
 * viewing their own numbers); null returns every agent (admin). Metrics come
 * from what's directly attributable to the agent — leads assigned to them,
 * quotations they built, and field activity they logged — plus store context
 * (customers + last-30-day revenue at the agent's store, shared when a store
 * has more than one agent).
 */
export async function agentPerformance(selfUserId: string | null) {
  const agents = await prisma.user.findMany({
    where: { role: Role.AGENT, ...(selfUserId ? { id: selfUserId } : {}) },
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
      storeId: true,
      store: { select: { name: true, city: true } },
    },
    orderBy: { name: 'asc' },
  });
  if (agents.length === 0) return { agents: [], generatedAt: new Date().toISOString() };

  const agentIds = agents.map((a) => a.id);
  const storeIds = [...new Set(agents.map((a) => a.storeId).filter((s): s is string => Boolean(s)))];
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const [leadGroups, quoteGroups, actGroups, custGroups, revGroups] = await Promise.all([
    prisma.lead.groupBy({
      by: ['assignedToId', 'stage'],
      where: { assignedToId: { in: agentIds } },
      _count: { _all: true },
      _sum: { estValuePaise: true },
    }),
    prisma.quotation.groupBy({
      by: ['createdById', 'status'],
      where: { createdById: { in: agentIds } },
      _count: { _all: true },
      _sum: { totalPaise: true },
    }),
    prisma.activity.groupBy({
      by: ['createdById', 'type'],
      where: { createdById: { in: agentIds } },
      _count: { _all: true },
    }),
    storeIds.length
      ? prisma.customer.groupBy({
          by: ['storeId'],
          where: { storeId: { in: storeIds } },
          _count: { _all: true },
        })
      : Promise.resolve([] as { storeId: string | null; _count: { _all: number } }[]),
    storeIds.length
      ? prisma.order.groupBy({
          by: ['storeId'],
          where: {
            storeId: { in: storeIds },
            createdAt: { gte: since },
            status: { notIn: [OrderStatus.CANCELLED, OrderStatus.RETURNED] },
          },
          _sum: { totalPaise: true },
        })
      : Promise.resolve([] as { storeId: string | null; _sum: { totalPaise: number | null } }[]),
  ]);

  const custByStore = new Map(custGroups.map((g) => [g.storeId, g._count._all]));
  const revByStore = new Map(revGroups.map((g) => [g.storeId, g._sum.totalPaise ?? 0]));

  const rows = agents.map((a) => {
    const myLeads = leadGroups.filter((g) => g.assignedToId === a.id);
    const leadStage = (st: LeadStage) =>
      myLeads.filter((g) => g.stage === st).reduce((s, g) => s + g._count._all, 0);
    const won = leadStage(LeadStage.WON);
    const lost = leadStage(LeadStage.LOST);
    const open = OPEN_LEAD_STAGES.reduce((s, st) => s + leadStage(st), 0);
    const leadsTotal = myLeads.reduce((s, g) => s + g._count._all, 0);
    const pipelinePaise = myLeads
      .filter((g) => OPEN_LEAD_STAGES.includes(g.stage))
      .reduce((s, g) => s + (g._sum.estValuePaise ?? 0), 0);
    const decided = won + lost;

    const myQuotes = quoteGroups.filter((g) => g.createdById === a.id);
    const quotesTotal = myQuotes.reduce((s, g) => s + g._count._all, 0);
    const converted = myQuotes
      .filter((g) => g.status === QuotationStatus.CONVERTED)
      .reduce((s, g) => s + g._count._all, 0);
    const quoteValuePaise = myQuotes.reduce((s, g) => s + (g._sum.totalPaise ?? 0), 0);

    const myActs = actGroups.filter((g) => g.createdById === a.id);
    const actType = (t: ActivityType) =>
      myActs.filter((g) => g.type === t).reduce((s, g) => s + g._count._all, 0);
    const activities = myActs.reduce((s, g) => s + g._count._all, 0);

    return {
      id: a.id,
      name: a.name,
      email: a.email,
      isActive: a.isActive,
      store: a.store ? { name: a.store.name, city: a.store.city } : null,
      customersManaged: a.storeId ? custByStore.get(a.storeId) ?? 0 : 0,
      storeRevenuePaise: a.storeId ? revByStore.get(a.storeId) ?? 0 : 0,
      leads: {
        total: leadsTotal,
        won,
        lost,
        open,
        winRatePct: decided ? Math.round((won / decided) * 100) : 0,
        pipelinePaise,
      },
      quotations: {
        total: quotesTotal,
        converted,
        valuePaise: quoteValuePaise,
        conversionPct: quotesTotal ? Math.round((converted / quotesTotal) * 100) : 0,
      },
      visits: actType(ActivityType.VISIT),
      calls: actType(ActivityType.CALL),
      activities,
    };
  });

  return { agents: rows, generatedAt: new Date().toISOString() };
}

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
