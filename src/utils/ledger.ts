import { OrderStatus, Prisma, StockMovementType } from '@prisma/client';

/** Append a row to the per-store stock ledger. Pass a transaction client when
 *  the movement must be atomic with the stock change. */
export async function recordStockMovement(
  db: Prisma.TransactionClient,
  input: {
    storeId: string;
    productId: string;
    variantId?: string | null;
    deltaQty: number;
    type: StockMovementType;
    orderId?: string | null;
    purchaseOrderId?: string | null;
    userId?: string | null;
    reason?: string;
  },
) {
  await db.stockMovement.create({
    data: {
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      deltaQty: input.deltaQty,
      type: input.type,
      orderId: input.orderId ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      userId: input.userId ?? null,
      reason: input.reason,
    },
  });
}

/** Record an order status-change event (history + audit). */
export async function recordOrderEvent(
  db: Prisma.TransactionClient,
  orderId: string,
  status: OrderStatus,
  opts: { note?: string; userId?: string | null } = {},
) {
  await db.orderEvent.create({
    data: { orderId, status, note: opts.note, userId: opts.userId ?? null },
  });
}
