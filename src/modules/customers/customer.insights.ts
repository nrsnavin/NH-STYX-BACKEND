import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';

/**
 * Customer 360 + RFM segmentation, computed from order/payment history.
 * Money is integer paise throughout.
 */

const DAY = 86_400_000;
const HIGH_VALUE_PAISE = 50_000_00; // ₹50,000 lifetime spend
const AT_RISK_DAYS = 45;
const DORMANT_DAYS = 90;

// Orders that count toward spend/recency (placed orders, not cancelled/returned).
const COUNTABLE: Prisma.OrderWhereInput = {
  status: { notIn: [OrderStatus.CANCELLED, OrderStatus.RETURNED] },
};

export type Segment = 'NEW' | 'ACTIVE' | 'HIGH_VALUE' | 'AT_RISK' | 'DORMANT';

interface RfmInput {
  orderCount: number;
  ltvPaise: number;
  daysSinceLastOrder: number | null;
}

/** Simple, explainable RFM rules → a single actionable segment. */
export function segmentFor({ orderCount, ltvPaise, daysSinceLastOrder }: RfmInput): Segment {
  if (orderCount === 0) return 'NEW';
  if (daysSinceLastOrder != null && daysSinceLastOrder > DORMANT_DAYS) return 'DORMANT';
  if (daysSinceLastOrder != null && daysSinceLastOrder > AT_RISK_DAYS) return 'AT_RISK';
  if (ltvPaise >= HIGH_VALUE_PAISE) return 'HIGH_VALUE';
  return 'ACTIVE';
}

const daysSince = (d: Date | null | undefined) =>
  d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null;

/** Lightweight per-customer stats for a page of the customer list — one groupBy
 *  query for all ids, then attach LTV / order count / last order / segment. */
export async function statsForCustomers(ids: string[]) {
  if (ids.length === 0) return new Map<string, ReturnType<typeof emptyStats>>();
  const agg = await prisma.order.groupBy({
    by: ['customerId'],
    where: { customerId: { in: ids }, ...COUNTABLE },
    _sum: { totalPaise: true },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const map = new Map<string, ReturnType<typeof emptyStats>>();
  for (const id of ids) map.set(id, emptyStats());
  for (const a of agg) {
    const ltvPaise = a._sum.totalPaise ?? 0;
    const orderCount = a._count._all;
    const lastOrderAt = a._max.createdAt ?? null;
    const dsl = daysSince(lastOrderAt);
    map.set(a.customerId, {
      ltvPaise,
      orderCount,
      lastOrderAt,
      daysSinceLastOrder: dsl,
      segment: segmentFor({ orderCount, ltvPaise, daysSinceLastOrder: dsl }),
    });
  }
  return map;
}

function emptyStats() {
  return {
    ltvPaise: 0,
    orderCount: 0,
    lastOrderAt: null as Date | null,
    daysSinceLastOrder: null as number | null,
    segment: 'NEW' as Segment,
  };
}

/** Full Customer-360 metrics for one shop. */
export async function customerInsights(customerId: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, shopName: true, phone: true, creditLimitPaise: true, creditApproved: true },
  });
  if (!customer) throw ApiError.notFound('Customer not found');

  const orders = await prisma.order.findMany({
    where: { customerId, ...COUNTABLE },
    select: {
      totalPaise: true,
      amountDuePaise: true,
      paymentStatus: true,
      paymentMethod: true,
      dueDate: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const orderCount = orders.length;
  const ltvPaise = orders.reduce((s, o) => s + o.totalPaise, 0);
  const aovPaise = orderCount ? Math.round(ltvPaise / orderCount) : 0;
  const firstOrderAt = orders[0]?.createdAt ?? null;
  const lastOrderAt = orders.at(-1)?.createdAt ?? null;
  const daysSinceLastOrder = daysSince(lastOrderAt);

  // Average cadence between orders (days).
  let avgDaysBetweenOrders: number | null = null;
  if (firstOrderAt && lastOrderAt && orderCount > 1) {
    const span = (new Date(lastOrderAt).getTime() - new Date(firstOrderAt).getTime()) / DAY;
    avgDaysBetweenOrders = Math.round(span / (orderCount - 1));
  }

  const now = new Date();
  const outstandingPaise = orders.reduce(
    (s, o) => (o.paymentStatus !== 'PAID' ? s + o.amountDuePaise : s),
    0,
  );
  const overduePaise = orders.reduce(
    (s, o) => (o.paymentStatus !== 'PAID' && o.dueDate && o.dueDate < now ? s + o.amountDuePaise : s),
    0,
  );

  // On-time payment rate from settled CREDIT orders (paid on/before due date;
  // updatedAt approximates when it flipped to PAID).
  const creditSettled = orders.filter(
    (o) => o.paymentMethod === 'CREDIT' && o.paymentStatus === 'PAID' && o.dueDate,
  );
  const onTime = creditSettled.filter((o) => o.updatedAt <= o.dueDate!).length;
  const onTimePaymentRate = creditSettled.length
    ? Math.round((onTime / creditSettled.length) * 100)
    : null;

  // Top categories by spend.
  const items = await prisma.orderItem.findMany({
    where: { order: { customerId, ...COUNTABLE } },
    select: { lineTotalPaise: true, product: { select: { category: { select: { name: true } } } } },
  });
  const byCategory = new Map<string, number>();
  for (const it of items) {
    const name = it.product?.category?.name ?? 'Other';
    byCategory.set(name, (byCategory.get(name) ?? 0) + it.lineTotalPaise);
  }
  const topCategories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, spendPaise]) => ({ name, spendPaise }));

  return {
    customerId: customer.id,
    shopName: customer.shopName,
    segment: segmentFor({ orderCount, ltvPaise, daysSinceLastOrder }),
    orderCount,
    ltvPaise,
    aovPaise,
    firstOrderAt,
    lastOrderAt,
    daysSinceLastOrder,
    avgDaysBetweenOrders,
    outstandingPaise,
    overduePaise,
    onTimePaymentRate,
    creditLimitPaise: customer.creditLimitPaise,
    creditApproved: customer.creditApproved,
    topCategories,
  };
}
