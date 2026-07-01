import { Prisma, StoreProduct } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';
import { getCustomerStoreId } from '../../utils/storeContext';
import * as cartService from '../cart/cart.service';

const bundleInclude = {
  items: {
    include: {
      product: {
        select: { id: true, name: true, brand: true, imageUrl: true, unit: true, moqQty: true },
      },
    },
  },
} satisfies Prisma.BundleInclude;

type BundleWithItems = Prisma.BundleGetPayload<{ include: typeof bundleInclude }>;

async function uniqueSlug(base: string): Promise<string> {
  const root = base || 'bundle';
  let slug = root;
  let n = 2;
  while (await prisma.bundle.findUnique({ where: { slug } })) {
    slug = `${root}-${n++}`;
  }
  return slug;
}

// ---- Admin CRUD -------------------------------------------------------------

interface BundleInput {
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
  items: { productId: string; quantity: number }[];
}

async function assertProductsExist(items: { productId: string }[]) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const found = await prisma.product.count({ where: { id: { in: ids }, isActive: true } });
  if (found !== ids.length) throw ApiError.badRequest('One or more products no longer exist');
}

export async function listBundles(opts: { activeOnly?: boolean } = {}): Promise<BundleWithItems[]> {
  return prisma.bundle.findMany({
    where: opts.activeOnly ? { isActive: true } : {},
    include: bundleInclude,
    orderBy: { name: 'asc' },
  });
}

export async function getBundle(id: string): Promise<BundleWithItems> {
  const bundle = await prisma.bundle.findUnique({ where: { id }, include: bundleInclude });
  if (!bundle) throw ApiError.notFound('Bundle not found');
  return bundle;
}

export async function createBundle(input: BundleInput): Promise<BundleWithItems> {
  if (!input.items.length) throw ApiError.badRequest('Add at least one product to the bundle');
  await assertProductsExist(input.items);
  const slug = await uniqueSlug(slugify(input.name));
  return prisma.bundle.create({
    data: {
      name: input.name.trim(),
      slug,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      isActive: input.isActive ?? true,
      items: { create: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
    },
    include: bundleInclude,
  });
}

export async function updateBundle(id: string, input: Partial<BundleInput>): Promise<BundleWithItems> {
  await prisma.bundle.findUniqueOrThrow({ where: { id } }).catch(() => {
    throw ApiError.notFound('Bundle not found');
  });
  if (input.items) {
    if (!input.items.length) throw ApiError.badRequest('A bundle needs at least one product');
    await assertProductsExist(input.items);
  }
  return prisma.$transaction(async (tx) => {
    await tx.bundle.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        description: input.description,
        imageUrl: input.imageUrl,
        isActive: input.isActive,
      },
    });
    if (input.items) {
      await tx.bundleItem.deleteMany({ where: { bundleId: id } });
      await tx.bundleItem.createMany({
        data: input.items.map((i) => ({ bundleId: id, productId: i.productId, quantity: i.quantity })),
      });
    }
    return tx.bundle.findUniqueOrThrow({ where: { id }, include: bundleInclude });
  });
}

export async function deleteBundle(id: string): Promise<void> {
  await prisma.bundle.delete({ where: { id } }).catch(() => {
    throw ApiError.notFound('Bundle not found');
  });
}

// ---- Store-priced views (customer facing) -----------------------------------

function priceBundle(bundle: BundleWithItems, spByProduct: Map<string, StoreProduct>) {
  let totalPaise = 0;
  let allAvailable = bundle.items.length > 0;
  const items = bundle.items.map((it) => {
    const sp = spByProduct.get(it.productId);
    const available = Boolean(sp && sp.isActive && sp.stockQty >= it.quantity);
    if (!available) allAvailable = false;
    const pricePaise = sp?.pricePaise ?? null;
    const lineTotalPaise = pricePaise != null ? pricePaise * it.quantity : null;
    if (lineTotalPaise != null) totalPaise += lineTotalPaise;
    return {
      productId: it.productId,
      name: it.product.name,
      brand: it.product.brand,
      imageUrl: it.product.imageUrl,
      unit: it.product.unit,
      quantity: it.quantity,
      pricePaise,
      lineTotalPaise,
      available,
    };
  });
  return {
    id: bundle.id,
    name: bundle.name,
    slug: bundle.slug,
    description: bundle.description,
    imageUrl: bundle.imageUrl,
    items,
    totalPaise,
    allAvailable,
  };
}

export async function listBundlesForStore(storeId: string) {
  const bundles = await listBundles({ activeOnly: true });
  const productIds = [...new Set(bundles.flatMap((b) => b.items.map((i) => i.productId)))];
  const sps = productIds.length
    ? await prisma.storeProduct.findMany({ where: { storeId, productId: { in: productIds } } })
    : [];
  const map = new Map(sps.map((sp) => [sp.productId, sp]));
  return bundles.map((b) => priceBundle(b, map));
}

export async function getBundleForStore(id: string, storeId: string) {
  const bundle = await getBundle(id);
  const sps = await prisma.storeProduct.findMany({
    where: { storeId, productId: { in: bundle.items.map((i) => i.productId) } },
  });
  return priceBundle(bundle, new Map(sps.map((sp) => [sp.productId, sp])));
}

/** Expand a bundle into the customer's cart at their store's prices. Rejects up
 *  front if any component is unavailable, so the cart isn't left half-filled. */
export async function addBundleToCart(customerId: string, bundleId: string) {
  const storeId = await getCustomerStoreId(customerId);
  if (!storeId) throw ApiError.badRequest('No store is linked to your account yet');
  const priced = await getBundleForStore(bundleId, storeId);
  if (priced.items.length === 0) throw ApiError.badRequest('This bundle has no items');
  if (!priced.allAvailable) {
    throw ApiError.badRequest('Some items in this bundle are out of stock at your store');
  }
  for (const it of priced.items) {
    await cartService.addItem(customerId, it.productId, it.quantity);
  }
  return cartService.getCart(customerId);
}
