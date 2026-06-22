import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as productService from './product.service';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search, categoryId, isActive } = req.query as unknown as {
    page: number;
    limit: number;
    search?: string;
    categoryId?: string;
    isActive?: boolean;
  };
  const data = await productService.listProducts({ page, limit, search, categoryId, isActive });
  res.json({ success: true, ...data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const data = await productService.getProduct(req.params.id);
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
