import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { getCustomerStoreId } from '../../utils/storeContext';
import { storeProductsByIds } from '../products/product.service';

/**
 * A shop owner's saved-for-later products. Stored as plain (customer, product)
 * rows; the list view is resolved against the customer's serving store so it
 * carries the same price/stock shape as the rest of the catalog.
 */

/** The product ids this customer has wishlisted (newest first). */
export async function wishlistProductIds(customerId: string): Promise<string[]> {
  const rows = await prisma.wishlistItem.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    select: { productId: true },
  });
  return rows.map((r) => r.productId);
}

/**
 * Full store-scoped product cards for the wishlist. Products the customer's
 * store no longer stocks are dropped (consistent with the rest of the app,
 * where a shop only ever sees its serving store's catalog).
 */
export async function listWishlist(customerId: string) {
  const ids = await wishlistProductIds(customerId);
  if (ids.length === 0) return [];
  const storeId = await getCustomerStoreId(customerId);
  if (!storeId) return [];
  return storeProductsByIds(storeId, ids);
}

/** Saves a product to the wishlist. Idempotent — saving twice is a no-op. */
export async function addToWishlist(customerId: string, productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, isActive: true },
  });
  if (!product || !product.isActive) throw ApiError.notFound('Product not found');

  await prisma.wishlistItem.upsert({
    where: { customerId_productId: { customerId, productId } },
    create: { customerId, productId },
    update: {},
  });
}

/** Removes a product from the wishlist. Removing something absent is a no-op. */
export async function removeFromWishlist(customerId: string, productId: string) {
  await prisma.wishlistItem.deleteMany({ where: { customerId, productId } });
}
