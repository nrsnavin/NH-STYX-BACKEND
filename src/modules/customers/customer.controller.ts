import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as customerService from './customer.service';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search } = req.query as unknown as {
    page: number;
    limit: number;
    search?: string;
  };
  const data = await customerService.listCustomers({ page, limit, search });
  res.json({ success: true, ...data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const data = await customerService.getCustomer(req.params.id);
  res.json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await customerService.updateCustomer(req.params.id, req.body);
  res.json({ success: true, data });
});
