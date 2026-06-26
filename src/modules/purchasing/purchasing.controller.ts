import { Request, Response } from 'express';
import { PurchaseOrderStatus } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { getStaffStoreId } from '../../utils/storeContext';
import * as service from './purchasing.service';

/** Agents are scoped to their store; admins (null) see all. */
async function storeScope(req: Request): Promise<string | null> {
  return req.auth?.role === 'ADMIN' ? null : getStaffStoreId(req.auth!.sub);
}

async function assertScope(req: Request, poStoreId: string | null): Promise<void> {
  if (req.auth?.role === 'ADMIN') return;
  const storeId = await getStaffStoreId(req.auth!.sub);
  if (storeId && poStoreId !== storeId) {
    throw ApiError.forbidden('This purchase order belongs to another store');
  }
}

// ---- Suppliers --------------------------------------------------------------

export const listSuppliers = asyncHandler(async (req: Request, res: Response) => {
  const { search, activeOnly } = req.query as unknown as { search?: string; activeOnly?: boolean };
  const items = await service.listSuppliers({ search, activeOnly });
  res.json({ success: true, items });
});

export const createSupplier = asyncHandler(async (req: Request, res: Response) => {
  const data = await service.createSupplier(req.body);
  res.status(201).json({ success: true, data });
});

export const updateSupplier = asyncHandler(async (req: Request, res: Response) => {
  const data = await service.updateSupplier(req.params.id, req.body);
  res.json({ success: true, data });
});

// ---- Low stock --------------------------------------------------------------

export const lowStock = asyncHandler(async (req: Request, res: Response) => {
  // Admins may target a specific store; agents are pinned to their own.
  const scope = await storeScope(req);
  const storeId = scope ?? (req.query.storeId as string | undefined) ?? null;
  const items = await service.lowStock(storeId);
  res.json({ success: true, items });
});

// ---- Purchase orders --------------------------------------------------------

export const listPurchaseOrders = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, status, supplierId, search } = req.query as unknown as {
    page: number;
    limit: number;
    status?: PurchaseOrderStatus;
    supplierId?: string;
    search?: string;
  };
  const storeId = await storeScope(req);
  const data = await service.listPurchaseOrders({ page, limit, status, supplierId, search, storeId });
  res.json({ success: true, ...data });
});

export const getPurchaseOrder = asyncHandler(async (req: Request, res: Response) => {
  const po = await service.getPurchaseOrder(req.params.id);
  await assertScope(req, po.storeId);
  res.json({ success: true, data: po });
});

export const createPurchaseOrder = asyncHandler(async (req: Request, res: Response) => {
  const storeId = await getStaffStoreId(req.auth!.sub);
  const data = await service.createPurchaseOrder(req.body, { id: req.auth!.sub, storeId });
  res.status(201).json({ success: true, data });
});

export const updatePurchaseOrder = asyncHandler(async (req: Request, res: Response) => {
  const po = await service.getPurchaseOrder(req.params.id);
  await assertScope(req, po.storeId);
  const data = await service.updatePurchaseOrder(req.params.id, req.body);
  res.json({ success: true, data });
});

export const setPurchaseOrderStatus = asyncHandler(async (req: Request, res: Response) => {
  const po = await service.getPurchaseOrder(req.params.id);
  await assertScope(req, po.storeId);
  const data = await service.setStatus(req.params.id, req.body.status);
  res.json({ success: true, data });
});

export const receivePurchaseOrder = asyncHandler(async (req: Request, res: Response) => {
  const po = await service.getPurchaseOrder(req.params.id);
  await assertScope(req, po.storeId);
  const data = await service.receivePurchaseOrder(req.params.id, req.body.lines, req.auth!.sub);
  res.json({ success: true, data });
});
