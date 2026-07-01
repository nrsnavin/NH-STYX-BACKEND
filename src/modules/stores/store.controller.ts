import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { audit } from '../../utils/audit';
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
  const data = await storeService.upsertStoreProduct(
    req.params.id,
    req.params.productId,
    req.body,
    req.auth?.sub,
  );
  res.json({ success: true, data });
});

export const removeProduct = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  await storeService.removeStoreProduct(req.params.id, req.params.productId);
  res.json({ success: true, message: 'Product removed from store' });
});

// Adjust a single product's stock (correction / physical count) with a reason.
export const adjustStock = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  const data = await storeService.adjustStock(
    req.params.id,
    req.params.productId,
    req.body,
    req.auth?.sub,
  );
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'stock.adjust',
    entity: 'StoreProduct',
    entityId: req.params.productId,
    meta: { storeId: req.params.id, mode: req.body.mode, delta: data.delta, reason: req.body.reason },
  });
  res.json({ success: true, data });
});

// Reconcile counted quantities against system stock (bulk physical count).
export const stockTake = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  const data = await storeService.stockTake(req.params.id, req.body, req.auth?.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'stock.take',
    entity: 'Store',
    entityId: req.params.id,
    meta: { adjusted: data.adjusted, unchanged: data.unchanged, skipped: data.skipped.length },
  });
  res.json({ success: true, data });
});

// Move stock of a product from this store to another (admin only).
export const transfer = asyncHandler(async (req: Request, res: Response) => {
  const data = await storeService.transferStock(req.params.id, req.body, req.auth?.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'stock.transfer',
    entity: 'StoreProduct',
    entityId: req.body.productId,
    meta: { fromStoreId: req.params.id, toStoreId: req.body.toStoreId, quantity: req.body.quantity },
  });
  res.json({ success: true, data });
});

export const movements = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  const { productId, page, limit } = req.query as unknown as {
    productId?: string;
    page: number;
    limit: number;
  };
  const data = await storeService.listStockMovements(req.params.id, { productId, page, limit });
  res.json({ success: true, ...data });
});

export const importInventory = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.id);
  if (!req.file) throw ApiError.badRequest('Upload a CSV file (field "file")');
  const data = await storeService.importInventory(
    req.params.id,
    req.file.buffer.toString('utf-8'),
    req.auth?.sub,
  );
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
