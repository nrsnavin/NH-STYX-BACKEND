import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { resolveUnitPrice } from '../../utils/pricing';

async function getOrCreateCartId(customerId: string): Promise<string> {
  const existing = await prisma.cart.findUnique({ where: { customerId }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.cart.create({ data: { customerId }, select: { id: true } });
  return created.id;
}

/** Returns the cart with per-line resolved (tier-aware) pricing and a subtotal. */
export async function getCart(customerId: string) {
  const cartId = await getOrCreateCartId(customerId);
  const items = await prisma.cartItem.findMany({
    where: { cartId },
    include: { product: { include: { priceTiers: true } } },
    orderBy: { createdAt: 'asc' },
  });

  let subtotalPaise = 0;
  const enriched = items.map((item) => {
    const unitPricePaise = resolveUnitPrice(
      item.product.pricePaise,
      item.product.priceTiers,
      item.quantity,
    );
    const lineSubtotalPaise = unitPricePaise * item.quantity;
    subtotalPaise += lineSubtotalPaise;
    return {
      productId: item.productId,
      name: item.product.name,
      brand: item.product.brand,
      unit: item.product.unit,
      imageUrl: item.product.imageUrl,
      moqQty: item.product.moqQty,
      stockQty: item.product.stockQty,
      gstRatePercent: item.product.gstRatePercent,
      quantity: item.quantity,
      unitPricePaise,
      lineSubtotalPaise,
    };
  });

  return {
    items: enriched,
    itemCount: enriched.length,
    totalQuantity: enriched.reduce((s, i) => s + i.quantity, 0),
    subtotalPaise,
  };
}

export async function addItem(customerId: string, productId: string, quantity: number) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) throw ApiError.badRequest('Product is unavailable');

  const cartId = await getOrCreateCartId(customerId);
  const existing = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId, productId } },
  });

  const newQuantity = Math.max((existing?.quantity ?? 0) + quantity, product.moqQty);
  if (newQuantity > product.stockQty) {
    throw ApiError.badRequest(`Only ${product.stockQty} ${product.unit.toLowerCase()}(s) in stock`);
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

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) throw ApiError.badRequest('Product is unavailable');
  if (quantity > product.stockQty) {
    throw ApiError.badRequest(`Only ${product.stockQty} ${product.unit.toLowerCase()}(s) in stock`);
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
