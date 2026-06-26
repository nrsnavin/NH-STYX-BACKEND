import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import { getCustomerStoreId, getStaffStoreId } from '../../utils/storeContext';
import * as productService from './product.service';
import { composeStoreVariants } from '../variants/variant.service';

/**
 * Customers get the store-scoped catalog (their store's price/stock); staff get
 * the shared catalog for management.
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search, categoryId, isActive, sort, brand, minPricePaise, maxPricePaise, inStock } =
    req.query as unknown as {
      page: number;
      limit: number;
      search?: string;
      categoryId?: string;
      isActive?: boolean;
      sort?: productService.ProductSort;
      brand?: string;
      minPricePaise?: number;
      maxPricePaise?: number;
      inStock?: boolean;
    };

  if (req.auth?.type === 'CUSTOMER') {
    const storeId = await getCustomerStoreId(req.auth.sub);
    if (!storeId) {
      res.json({ success: true, items: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      return;
    }
    const data = await productService.listStoreProducts({
      storeId,
      page,
      limit,
      search,
      categoryId,
      sort,
      brand,
      minPricePaise,
      maxPricePaise,
      inStock,
    });
    res.json({ success: true, ...data });
    return;
  }

  const data = await productService.listCatalog({ page, limit, search, categoryId, isActive });
  res.json({ success: true, ...data });
});

/** Distinct brands the customer's store stocks (powers the catalog filter). */
export const brands = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth?.type !== 'CUSTOMER') {
    res.json({ success: true, items: [] });
    return;
  }
  const storeId = await getCustomerStoreId(req.auth.sub);
  const items = storeId ? await productService.listStoreBrands(storeId) : [];
  res.json({ success: true, items });
});

/** Best sellers in the customer's store/city. Empty for staff / no store. */
export const bestSelling = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth?.type !== 'CUSTOMER') {
    res.json({ success: true, items: [] });
    return;
  }
  const storeId = await getCustomerStoreId(req.auth.sub);
  if (!storeId) {
    res.json({ success: true, items: [] });
    return;
  }
  const items = await productService.bestSellingForStore(storeId, 10);
  res.json({ success: true, items });
});

/** Products the signed-in customer has ordered before (most recent first). */
export const recentlyOrdered = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth?.type !== 'CUSTOMER') {
    res.json({ success: true, items: [] });
    return;
  }
  const storeId = await getCustomerStoreId(req.auth.sub);
  if (!storeId) {
    res.json({ success: true, items: [] });
    return;
  }
  const items = await productService.recentlyOrderedForCustomer(req.auth.sub, storeId, 10);
  res.json({ success: true, items });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth?.type === 'CUSTOMER') {
    const storeId = await getCustomerStoreId(req.auth.sub);
    if (!storeId) {
      res.status(404).json({ success: false, message: 'Product not available in your area' });
      return;
    }
    const data = await productService.getStoreProduct(storeId, req.params.id);
    // Attach the store's variants (size/colour) for products sold that way.
    const variants = data.hasVariants ? await composeStoreVariants(storeId, req.params.id) : [];
    res.json({ success: true, data: { ...data, variants } });
    return;
  }

  const data = await productService.getCatalogProduct(req.params.id);
  res.json({ success: true, data });
});

/** Per-product stock ledger. Admins see all stores; an agent only their own. */
export const movements = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };
  const storeId = req.auth!.role === 'ADMIN' ? null : await getStaffStoreId(req.auth!.sub);
  const data = await productService.listProductMovements(req.params.id, { storeId, page, limit });
  res.json({ success: true, ...data });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await productService.createProduct(req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'product.create',
    entity: 'Product',
    entityId: data.id,
    meta: { name: data.name },
  });
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await productService.updateProduct(req.params.id, req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'product.update',
    entity: 'Product',
    entityId: req.params.id,
  });
  res.json({ success: true, data });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await productService.deleteProduct(req.params.id);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'product.delete',
    entity: 'Product',
    entityId: req.params.id,
  });
  res.json({ success: true, message: 'Product deleted' });
});
