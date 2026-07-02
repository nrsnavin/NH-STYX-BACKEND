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

/** One cart line is identified by its (cart, product, variant) tuple. */
function findLine(cartId: string, productId: string, variantId: string | null) {
  return prisma.cartItem.findFirst({ where: { cartId, productId, variantId } });
}

/** Resolves the orderable price + stock for an item in a store. For a variant
 *  it comes from StoreVariant; otherwise from StoreProduct (tier-aware). */
async function resolveItem(storeId: string, productId: string, variantId: string | null, quantity: number) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) throw ApiError.badRequest('Product is unavailable');

  if (variantId) {
    const sv = await prisma.storeVariant.findUnique({
      where: { storeId_variantId: { storeId, variantId } },
      include: { variant: true },
    });
    if (!sv || !sv.isActive || !sv.variant.isActive || sv.variant.productId !== productId) {
      throw ApiError.badRequest('This option is no longer available');
    }
    return { product, unitPricePaise: sv.pricePaise, stockQty: sv.stockQty };
  }

  const sp = await prisma.storeProduct.findUnique({
    where: { storeId_productId: { storeId, productId } },
    include: { priceTiers: true },
  });
  if (!sp || !sp.isActive) throw ApiError.badRequest('Product is unavailable');
  return { product, unitPricePaise: resolveUnitPrice(sp.pricePaise, sp.priceTiers, quantity), stockQty: sp.stockQty };
}

/** Returns the cart with per-line resolved (variant/tier-aware) pricing. */
export async function getCart(customerId: string) {
  const storeId = await getCustomerStoreId(customerId);
  const cartId = await getOrCreateCartId(customerId);
  const items = await prisma.cartItem.findMany({
    where: { cartId },
    include: { product: true, variant: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!storeId || items.length === 0) {
    return { items: [], itemCount: 0, totalQuantity: 0, subtotalPaise: 0 };
  }

  const productIds = items.filter((i) => !i.variantId).map((i) => i.productId);
  const variantIds = items.filter((i) => i.variantId).map((i) => i.variantId!);
  const [storeProducts, storeVariants] = await Promise.all([
    productIds.length
      ? prisma.storeProduct.findMany({ where: { storeId, productId: { in: productIds } }, include: { priceTiers: true } })
      : Promise.resolve([]),
    variantIds.length
      ? prisma.storeVariant.findMany({ where: { storeId, variantId: { in: variantIds } } })
      : Promise.resolve([]),
  ]);
  const spByProduct = new Map(storeProducts.map((sp) => [sp.productId, sp]));
  const svByVariant = new Map(storeVariants.map((sv) => [sv.variantId, sv]));

  let subtotalPaise = 0;
  const deadLineIds: string[] = [];
  const enriched = items.flatMap((item) => {
    const product = item.product;
    if (!product.isActive) {
      deadLineIds.push(item.id);
      return [];
    }

    let unitPricePaise: number;
    let stockQty: number;
    if (item.variantId) {
      const sv = svByVariant.get(item.variantId);
      if (!sv || !sv.isActive || !item.variant?.isActive) {
        deadLineIds.push(item.id);
        return [];
      }
      unitPricePaise = sv.pricePaise;
      stockQty = sv.stockQty;
    } else {
      const sp = spByProduct.get(item.productId);
      if (!sp || !sp.isActive) {
        deadLineIds.push(item.id);
        return [];
      }
      unitPricePaise = resolveUnitPrice(sp.pricePaise, sp.priceTiers, item.quantity);
      stockQty = sp.stockQty;
    }

    const lineSubtotalPaise = unitPricePaise * item.quantity;
    subtotalPaise += lineSubtotalPaise;
    return [
      {
        productId: item.productId,
        variantId: item.variantId,
        variantName: item.variant?.name ?? null,
        name: product.name,
        brand: product.brand,
        unit: product.unit,
        imageUrl: item.variant?.imageUrl ?? product.imageUrl,
        moqQty: product.moqQty,
        stockQty,
        gstRatePercent: product.gstRatePercent,
        quantity: item.quantity,
        unitPricePaise,
        lineSubtotalPaise,
      },
    ];
  });

  // Self-heal: physically remove lines whose product/variant was delisted,
  // instead of merely hiding them — a hidden-but-present line is exactly the
  // phantom that used to block checkout.
  if (deadLineIds.length > 0) {
    await prisma.cartItem.deleteMany({ where: { id: { in: deadLineIds } } });
  }

  return {
    items: enriched,
    itemCount: enriched.length,
    totalQuantity: enriched.reduce((s, i) => s + i.quantity, 0),
    subtotalPaise,
  };
}

export async function addItem(customerId: string, productId: string, quantity: number, variantId?: string | null) {
  const storeId = await requireCustomerStoreId(customerId);
  const vId = variantId ?? null;
  const { product, stockQty } = await resolveItem(storeId, productId, vId, quantity);

  const cartId = await getOrCreateCartId(customerId);
  const existing = await findLine(cartId, productId, vId);
  const newQuantity = Math.max((existing?.quantity ?? 0) + quantity, product.moqQty);
  if (newQuantity > stockQty) {
    throw ApiError.badRequest(`Only ${stockQty} ${product.unit.toLowerCase()}(s) in stock`);
  }

  if (existing) {
    await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: newQuantity } });
  } else {
    await prisma.cartItem.create({ data: { cartId, productId, variantId: vId, quantity: newQuantity } });
  }
  return getCart(customerId);
}

export async function setItemQuantity(
  customerId: string,
  productId: string,
  quantity: number,
  variantId?: string | null,
) {
  const cartId = await getOrCreateCartId(customerId);
  const vId = variantId ?? null;

  if (quantity <= 0) {
    await prisma.cartItem.deleteMany({ where: { cartId, productId, variantId: vId } });
    return getCart(customerId);
  }

  const storeId = await requireCustomerStoreId(customerId);
  const { product, stockQty } = await resolveItem(storeId, productId, vId, quantity);
  if (quantity > stockQty) {
    throw ApiError.badRequest(`Only ${stockQty} ${product.unit.toLowerCase()}(s) in stock`);
  }

  const existing = await findLine(cartId, productId, vId);
  if (existing) {
    await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity } });
  } else {
    await prisma.cartItem.create({ data: { cartId, productId, variantId: vId, quantity } });
  }
  return getCart(customerId);
}

export async function removeItem(customerId: string, productId: string, variantId?: string | null) {
  const cartId = await getOrCreateCartId(customerId);
  await prisma.cartItem.deleteMany({ where: { cartId, productId, variantId: variantId ?? null } });
  return getCart(customerId);
}

export async function clearCart(customerId: string) {
  const cartId = await getOrCreateCartId(customerId);
  await prisma.cartItem.deleteMany({ where: { cartId } });
  return getCart(customerId);
}

/**
 * ADMIN maintenance: empties EVERY customer's cart. Runs on the trusted path
 * (no customer RLS context), so the delete spans all carts. Returns the number
 * of lines removed.
 */
export async function clearAllCarts(): Promise<number> {
  const { count } = await prisma.cartItem.deleteMany({});
  return count;
}
