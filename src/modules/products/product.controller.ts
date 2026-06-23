import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { getCustomerStoreId } from '../../utils/storeContext';
import * as productService from './product.service';

/**
 * Customers get the store-scoped catalog (their store's price/stock); staff get
 * the shared catalog for management.
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search, categoryId, isActive } = req.query as unknown as {
    page: number;
    limit: number;
    search?: string;
    categoryId?: string;
    isActive?: boolean;
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
    });
    res.json({ success: true, ...data });
    return;
  }

  const data = await productService.listCatalog({ page, limit, search, categoryId, isActive });
  res.json({ success: true, ...data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth?.type === 'CUSTOMER') {
    const storeId = await getCustomerStoreId(req.auth.sub);
    if (!storeId) {
      res.status(404).json({ success: false, message: 'Product not available in your area' });
      return;
    }
    const data = await productService.getStoreProduct(storeId, req.params.id);
    res.json({ success: true, data });
    return;
  }

  const data = await productService.getCatalogProduct(req.params.id);
  res.json({ success: true, data });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await productService.createProduct(req.body);
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await productService.updateProduct(req.params.id, req.body);
  res.json({ success: true, data });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await productService.deleteProduct(req.params.id);
  res.json({ success: true, message: 'Product deleted' });
});
