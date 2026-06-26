import { NotificationAudience, NotificationStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/**
 * In-app notification outbox. `dispatch` (and its typed helpers) persist one row
 * per event; the customer app reads its feed from here and the ops console reads
 * the staff stream. External channels (email/SMS/push) attach to this same hook
 * — wire a provider into `record` and they fire for every event automatically.
 *
 * Helpers take a transaction client so the notification commits atomically with
 * the change that triggered it (mirrors recordOrderEvent / recordStockMovement).
 */
type Db = Prisma.TransactionClient;

interface OrderLike {
  id: string;
  orderNumber: string;
  customerId: string;
  totalPaise?: number;
  courierName?: string | null;
  trackingNumber?: string | null;
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

async function record(
  db: Db,
  input: {
    audience: NotificationAudience;
    customerId?: string | null;
    event: string;
    title: string;
    body: string;
    orderId?: string | null;
  },
): Promise<void> {
  await db.notification.create({
    data: {
      audience: input.audience,
      customerId: input.customerId ?? null,
      event: input.event,
      title: input.title,
      body: input.body,
      orderId: input.orderId ?? null,
      status: NotificationStatus.SENT,
    },
  });
}

export async function notifyOrderPlaced(db: Db, order: OrderLike): Promise<void> {
  const amount = order.totalPaise != null ? ` for ${rupees(order.totalPaise)}` : '';
  await record(db, {
    audience: NotificationAudience.CUSTOMER,
    customerId: order.customerId,
    event: 'ORDER_PLACED',
    title: `Order ${order.orderNumber} placed`,
    body: `We've received your order${amount}. We'll keep you posted on its progress.`,
    orderId: order.id,
  });
  await record(db, {
    audience: NotificationAudience.STAFF,
    event: 'ORDER_PLACED',
    title: `New order ${order.orderNumber}`,
    body: `A new order${amount} was placed.`,
    orderId: order.id,
  });
}

export async function notifyPaymentReceived(db: Db, order: OrderLike): Promise<void> {
  const amount = order.totalPaise != null ? ` of ${rupees(order.totalPaise)}` : '';
  await record(db, {
    audience: NotificationAudience.CUSTOMER,
    customerId: order.customerId,
    event: 'PAYMENT_RECEIVED',
    title: `Payment received for ${order.orderNumber}`,
    body: `Thanks! Your payment${amount} is confirmed and your order is now being processed.`,
    orderId: order.id,
  });
  await record(db, {
    audience: NotificationAudience.STAFF,
    event: 'PAYMENT_RECEIVED',
    title: `Payment received — ${order.orderNumber}`,
    body: `Order ${order.orderNumber} is now paid.`,
    orderId: order.id,
  });
}

export async function notifyOrderShipped(db: Db, order: OrderLike): Promise<void> {
  const via = order.courierName ? ` via ${order.courierName}` : '';
  const awb = order.trackingNumber ? ` (AWB ${order.trackingNumber})` : '';
  await record(db, {
    audience: NotificationAudience.CUSTOMER,
    customerId: order.customerId,
    event: 'ORDER_SHIPPED',
    title: `Order ${order.orderNumber} shipped`,
    body: `Your order is on its way${via}${awb}.`,
    orderId: order.id,
  });
}

export async function notifyOrderDelivered(db: Db, order: OrderLike): Promise<void> {
  await record(db, {
    audience: NotificationAudience.CUSTOMER,
    customerId: order.customerId,
    event: 'ORDER_DELIVERED',
    title: `Order ${order.orderNumber} delivered`,
    body: `Your order has been delivered. Thank you for shopping with NH Styx!`,
    orderId: order.id,
  });
}

export async function notifyReturnRequested(
  db: Db,
  opts: { order: OrderLike; returnNumber: string; refundAmountPaise: number },
): Promise<void> {
  await record(db, {
    audience: NotificationAudience.STAFF,
    event: 'RETURN_REQUESTED',
    title: `Return ${opts.returnNumber} requested`,
    body: `A return was raised on order ${opts.order.orderNumber} for ${rupees(opts.refundAmountPaise)}.`,
    orderId: opts.order.id,
  });
  await record(db, {
    audience: NotificationAudience.CUSTOMER,
    customerId: opts.order.customerId,
    event: 'RETURN_REQUESTED',
    title: `Return ${opts.returnNumber} received`,
    body: `We've received your return request for order ${opts.order.orderNumber}. We'll review it shortly.`,
    orderId: opts.order.id,
  });
}

export async function notifyReturnRefunded(
  db: Db,
  opts: { order: OrderLike; returnNumber: string; refundAmountPaise: number },
): Promise<void> {
  await record(db, {
    audience: NotificationAudience.CUSTOMER,
    customerId: opts.order.customerId,
    event: 'RETURN_REFUNDED',
    title: `Refund processed for ${opts.order.orderNumber}`,
    body: `Your refund of ${rupees(opts.refundAmountPaise)} for return ${opts.returnNumber} has been processed.`,
    orderId: opts.order.id,
  });
}

// ---- Reads -----------------------------------------------------------------
// The new tables carry no RLS policy, so customer reads are scoped here by an
// explicit customerId filter (the trusted, app-layer guard).

export async function listMine(customerId: string) {
  return prisma.notification.findMany({
    where: { customerId, audience: NotificationAudience.CUSTOMER },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export async function unreadCount(customerId: string): Promise<number> {
  return prisma.notification.count({
    where: {
      customerId,
      audience: NotificationAudience.CUSTOMER,
      status: NotificationStatus.SENT,
    },
  });
}

export async function markRead(customerId: string, id: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id, customerId },
    data: { status: NotificationStatus.READ, readAt: new Date() },
  });
}

export async function markAllRead(customerId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: {
      customerId,
      audience: NotificationAudience.CUSTOMER,
      status: NotificationStatus.SENT,
    },
    data: { status: NotificationStatus.READ, readAt: new Date() },
  });
}

export async function listStaff() {
  return prisma.notification.findMany({
    where: { audience: NotificationAudience.STAFF },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}
