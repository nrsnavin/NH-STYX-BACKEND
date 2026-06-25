import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { audit } from '../../utils/audit';
import { getStaffStoreId } from '../../utils/storeContext';
import * as variantService from './variant.service';

/** Agents may only touch their own store's variant stock; admins, any store. */
async function assertStoreScope(req: Request, storeId: string) {
  if (req.auth!.role === 'ADMIN') return;
  const own = await getStaffStoreId(req.auth!.sub);
  if (own && own !== storeId) throw ApiError.forbidden('This store belongs to another agent');
}

// ---- Catalog variant management ----------------------------------------------

export const list = asyncHandler(async (req: Request, res: Response) => {
  const data = await variantService.listVariants(req.params.productId);
  res.json({ success: true, data });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await variantService.createVariant(req.params.productId, req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'variant.create',
    entity: 'ProductVariant',
    entityId: data.id,
    meta: { productId: req.params.productId, name: data.name },
  });
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await variantService.updateVariant(req.params.id, req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'variant.update',
    entity: 'ProductVariant',
    entityId: req.params.id,
  });
  res.json({ success: true, data });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await variantService.deleteVariant(req.params.id);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'variant.delete',
    entity: 'ProductVariant',
    entityId: req.params.id,
  });
  res.json({ success: true, message: 'Variant removed' });
});

// ---- Per-store variant inventory ---------------------------------------------

export const listStore = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.storeId);
  const { productId } = req.query as unknown as { productId: string };
  const data = await variantService.listStoreVariants(req.params.storeId, productId);
  res.json({ success: true, data });
});

export const upsertStore = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.storeId);
  const data = await variantService.upsertStoreVariant(
    req.params.storeId,
    req.params.variantId,
    req.body,
    req.auth!.sub,
  );
  res.json({ success: true, data });
});

export const removeStore = asyncHandler(async (req: Request, res: Response) => {
  await assertStoreScope(req, req.params.storeId);
  await variantService.removeStoreVariant(req.params.storeId, req.params.variantId);
  res.json({ success: true, message: 'Variant delisted from store' });
});
