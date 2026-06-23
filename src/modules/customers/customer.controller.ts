import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { getStaffStoreId } from '../../utils/storeContext';
import * as customerService from './customer.service';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search } = req.query as unknown as {
    page: number;
    limit: number;
    search?: string;
  };
  // Agents are scoped to their store; admins (storeId null) see all customers.
  const storeId = req.auth?.type === 'STAFF' ? await getStaffStoreId(req.auth.sub) : null;
  const data = await customerService.listCustomers({ page, limit, search, storeId });
  res.json({ success: true, ...data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const data = await customerService.getCustomer(req.params.id);
  const storeId = req.auth?.type === 'STAFF' ? await getStaffStoreId(req.auth.sub) : null;
  if (storeId && data.storeId !== storeId) {
    throw ApiError.forbidden('This customer belongs to another store');
  }
  res.json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await customerService.updateCustomer(req.params.id, req.body);
  res.json({ success: true, data });
});
