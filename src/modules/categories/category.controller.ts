import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as categoryService from './category.service';

export const list = asyncHandler(async (_req: Request, res: Response) => {
  const data = await categoryService.listCategories();
  res.json({ success: true, data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const data = await categoryService.getCategory(req.params.id);
  res.json({ success: true, data });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await categoryService.createCategory(req.body);
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await categoryService.updateCategory(req.params.id, req.body);
  res.json({ success: true, data });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await categoryService.deleteCategory(req.params.id);
  res.json({ success: true, message: 'Category deleted' });
});
