import { OrderStatus, PrismaClient } from '@prisma/client';

/**
 * Demo helper: gives a couple of each approved customer's recent orders a
 * realistic shipment — courier, AWB, tracking URL and a clean, backdated
 * lifecycle (placed → confirmed → packed → shipped → delivered) — so the
 * customer app's tracking timeline has something to show without a live
 * courier integration. Deterministic: re-running rewrites the same demo state.
 *
 *   npx tsx prisma/demo-shipments.ts
 */
const prisma = new PrismaClient();

const COURIERS = [
  { name: 'Delhivery', url: (awb: string) => `https://www.delhivery.com/track/package/${awb}` },
  { name: 'Blue Dart', url: (awb: string) => `https://www.bluedart.com/tracking?awb=${awb}` },
  { name: 'DTDC', url: (awb: string) => `https://www.dtdc.in/tracking.asp?awb=${awb}` },
];

const HOUR = 3_600_000;

async function ship(orderId: string, deliver: boolean, seed: number) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;
  const courier = COURIERS[seed % COURIERS.length];
  const awb = `${courier.name.slice(0, 3).toUpperCase()}${100000000 + seed * 7777}`;
  const t0 = order.createdAt.getTime();
  const shippedAt = new Date(t0 + 20 * HOUR);
  const deliveredAt = deliver ? new Date(t0 + 66 * HOUR) : null;

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: deliver ? OrderStatus.DELIVERED : OrderStatus.SHIPPED,
      courierName: courier.name,
      trackingNumber: awb,
      trackingUrl: courier.url(awb),
      shippedAt,
      deliveredAt,
    },
  });

  // Rewrite the lifecycle events to a clean, backdated demo sequence so the
  // tracking timeline reads sensibly regardless of prior test artefacts.
  await prisma.orderEvent.deleteMany({ where: { orderId } });
  const events: { status: OrderStatus; at: Date; note: string }[] = [
    { status: OrderStatus.PENDING, at: new Date(t0), note: 'Order placed' },
    { status: OrderStatus.CONFIRMED, at: new Date(t0 + 4 * HOUR), note: 'Payment confirmed' },
    { status: OrderStatus.PACKED, at: new Date(t0 + 12 * HOUR), note: 'Packed for dispatch' },
    { status: OrderStatus.SHIPPED, at: shippedAt, note: `Dispatched via ${courier.name} · AWB ${awb}` },
  ];
  if (deliver && deliveredAt) {
    events.push({ status: OrderStatus.DELIVERED, at: deliveredAt, note: 'Delivered' });
  }
  for (const e of events) {
    await prisma.orderEvent.create({
      data: { orderId, status: e.status, note: e.note, createdAt: e.at },
    });
  }
  console.log(
    `  ${order.orderNumber} → ${deliver ? 'DELIVERED' : 'SHIPPED'} via ${courier.name} (AWB ${awb})`,
  );
}

async function main() {
  const customers = await prisma.customer.findMany({
    where: { status: 'APPROVED', storeId: { not: null } },
    select: { id: true, shopName: true },
  });

  let seed = 1;
  for (const c of customers) {
    const orders = await prisma.order.findMany({
      where: { customerId: c.id, status: { notIn: [OrderStatus.CANCELLED, OrderStatus.RETURNED] } },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    if (orders.length === 0) continue;
    console.log(`${c.shopName}:`);
    await ship(orders[0].id, true, seed++); // most recent → delivered (full journey)
    if (orders[1]) await ship(orders[1].id, false, seed++); // next → in transit
  }
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
