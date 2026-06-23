import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { resolveUnitPrice } from '../../utils/pricing';
import { getCustomerStoreId, requireCustomerStoreId } from '../../utils/storeContext';

async function getOrCreateCartId(customerId: string): Promise<string> {
  const existing = await prisma.cart.findUnique({ where: { customerId }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.cart.create({ data: { customerId }, select: { id: true } });
  return created.id;
}

/** The store-product (price + stock + tiers) for one item in a customer's store. */
async function storeProductFor(storeId: string, productId: string) {
  return prisma.storeProduct.findUnique({
    where: { storeId_productId: { storeId, productId } },
    include: { priceTiers: true, product: true },
  });
}

/** Returns the cart with per-line resolved (tier-aware) pricing and a subtotal. */
export async function getCart(customerId: string) {
  const storeId = await getCustomerStoreId(customerId);
  const cartId = await getOrCreateCartId(customerId);
  const items = await prisma.cartItem.findMany({
    where: { cartId },
    include: { product: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!storeId || items.length === 0) {
    return { items: [], itemCount: 0, totalQuantity: 0, subtotalPaise: 0 };
  }

  const storeProducts = await prisma.storeProduct.findMany({
    where: { storeId, productId: { in: items.map((i) => i.productId) } },
    include: { priceTiers: true },
  });
  const byProduct = new Map(storeProducts.map((sp) => [sp.productId, sp]));

  let subtotalPaise = 0;
  const enriched = items.flatMap((item) => {
    const sp = byProduct.get(item.productId);
    // Skip lines no longer stocked/active in the store; they're hidden from totals.
    if (!sp || !sp.isActive || !item.product.isActive) return [];

    const unitPricePaise = resolveUnitPrice(sp.pricePaise, sp.priceTiers, item.quantity);
    const lineSubtotalPaise = unitPricePaise * item.quantity;
    subtotalPaise += lineSubtotalPaise;
    return [
      {
        productId: item.productId,
        name: item.product.name,
        brand: item.product.brand,
        unit: item.product.unit,
        imageUrl: item.product.imageUrl,
        moqQty: item.product.moqQty,
        stockQty: sp.stockQty,
        gstRatePercent: item.product.gstRatePercent,
        quantity: item.quantity,
        unitPricePaise,
        lineSubtotalPaise,
      },
    ];
  });

  return {
    items: enriched,
    itemCount: enriched.length,
    totalQuantity: enriched.reduce((s, i) => s + i.quantity, 0),
    subtotalPaise,
  };
}

export async function addItem(customerId: string, productId: string, quantity: number) {
  const storeId = await requireCustomerStoreId(customerId);
  const sp = await storeProductFor(storeId, productId);
  if (!sp || !sp.isActive || !sp.product.isActive) throw ApiError.badRequest('Product is unavailable');

  const cartId = await getOrCreateCartId(customerId);
  const existing = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId, productId } },
  });

  const newQuantity = Math.max((existing?.quantity ?? 0) + quantity, sp.product.moqQty);
  if (newQuantity > sp.stockQty) {
    throw ApiError.badRequest(`Only ${sp.stockQty} ${sp.product.unit.toLowerCase()}(s) in stock`);
  }

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId, productId } },
    create: { cartId, productId, quantity: newQuantity },
    update: { quantity: newQuantity },
  });

  return getCart(customerId);
}

export async function setItemQuantity(customerId: string, productId: string, quantity: number) {
  const cartId = await getOrCreateCartId(customerId);

  if (quantity <= 0) {
    await prisma.cartItem.deleteMany({ where: { cartId, productId } });
    return getCart(customerId);
  }

  const storeId = await requireCustomerStoreId(customerId);
  const sp = await storeProductFor(storeId, productId);
  if (!sp || !sp.isActive || !sp.product.isActive) throw ApiError.badRequest('Product is unavailable');
  if (quantity > sp.stockQty) {
    throw ApiError.badRequest(`Only ${sp.stockQty} ${sp.product.unit.toLowerCase()}(s) in stock`);
  }

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId, productId } },
    create: { cartId, productId, quantity },
    update: { quantity },
  });

  return getCart(customerId);
}

export async function removeItem(customerId: string, productId: string) {
  const cartId = await getOrCreateCartId(customerId);
  await prisma.cartItem.deleteMany({ where: { cartId, productId } });
  return getCart(customerId);
}

export async function clearCart(customerId: string) {
  const cartId = await getOrCreateCartId(customerId);
  await prisma.cartItem.deleteMany({ where: { cartId } });
  return getCart(customerId);
}
