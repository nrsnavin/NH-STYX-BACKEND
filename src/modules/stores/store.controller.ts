import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { getStaffStoreId } from '../../utils/storeContext';
import * as storeService from './store.service';

/**
 * Agents may only act on their own store; admins on any. Returns the admin's
 * "no scope" (null) or asserts the agent is touching their assigned store.
 */
async function assertStoreScope(req: Request, storeId: string): Promise<void> {
  if (req.auth?.role === 'ADMIN') return;
  const agentStore = req.auth?.type === 'STAFF' ? await getStaffStoreId(req.auth.sub) : null;
  if (agentStore !== storeId) {
    throw ApiError.forbidden('You can only manage your own store');
  }
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const scope = req.auth?.role === 'ADMIN' ? null : await getStaffStoreId(req.auth!.sub);
  const data = await storeService.listStores(scope);
  res.json({ success: true, items: data });
});

/** Public: serviceable cities for the registration dropdown. */
export const cities = asyncHandler(async (_req: Request, res: Response) => {
  const data = await storeService.listServiceCities();
  res.json({ success: true, items: data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  const data = await storeService.getStore(req.params.id);
  res.json({ success: true, data });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await storeService.createStore(req.body);
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await storeService.updateStore(req.params.id, req.body);
  res.json({ success: true, data });
});

// ---- Service areas ----

export const addArea = asyncHandler(async (req: Request, res: Response) => {
  const data = await storeService.addServiceArea(req.params.id, req.body.city);
  res.status(201).json({ success: true, data });
});

export const removeArea = asyncHandler(async (req: Request, res: Response) => {
  await storeService.removeServiceArea(req.params.areaId);
  res.json({ success: true, message: 'Service area removed' });
});

// ---- Inventory ----

export const inventory = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  const { page, limit, search, categoryId } = req.query as unknown as {
    page: number;
    limit: number;
    search?: string;
    categoryId?: string;
  };
  const data = await storeService.listStoreInventory(req.params.id, { page, limit, search, categoryId });
  res.json({ success: true, ...data });
});

export const upsertProduct = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  const data = await storeService.upsertStoreProduct(req.params.id, req.params.productId, req.body);
  res.json({ success: true, data });
});

export const removeProduct = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  await storeService.removeStoreProduct(req.params.id, req.params.productId);
  res.json({ success: true, message: 'Product removed from store' });
});

export const importInventory = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  if (!req.file) throw ApiError.badRequest('Upload a CSV file (field "file")');
  const data = await storeService.importInventory(req.params.id, req.file.buffer.toString('utf-8'));
  res.json({ success: true, data });
});

// ---- Agents (admin only) ----

export const agents = asyncHandler(async (_req: Request, res: Response) => {
  const data = await storeService.listAgents();
  res.json({ success: true, items: data });
});

export const assignAgent = asyncHandler(async (req: Request, res: Response) => {
  const data = await storeService.assignAgent(req.params.id, req.body.userId);
  res.json({ success: true, data });
});

export const unassignAgent = asyncHandler(async (req: Request, res: Response) => {
  const data = await storeService.unassignAgent(req.params.userId);
  res.json({ success: true, data });
});
