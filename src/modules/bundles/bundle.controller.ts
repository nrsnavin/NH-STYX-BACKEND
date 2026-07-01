import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import { getCustomerStoreId, getStaffStoreId } from '../../utils/storeContext';
import * as bundleService from './bundle.service';

// List bundles. Customers (and agents) get them priced for their store;
// admins get the raw definitions for management.
export const list = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth?.type === 'CUSTOMER') {
    const storeId = await getCustomerStoreId(req.auth.sub);
    const items = storeId ? await bundleService.listBundlesForStore(storeId) : [];
    res.json({ success: true, items });
    return;
  }
  const storeId = req.auth?.role === 'ADMIN' ? null : await getStaffStoreId(req.auth!.sub);
  if (storeId) {
    res.json({ success: true, items: await bundleService.listBundlesForStore(storeId) });
    return;
  }
  res.json({ success: true, items: await bundleService.listBundles() });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth?.type === 'CUSTOMER') {
    const storeId = await getCustomerStoreId(req.auth.sub);
    if (!storeId) throw new Error('No store linked');
    res.json({ success: true, data: await bundleService.getBundleForStore(req.params.id, storeId) });
    return;
  }
  res.json({ success: true, data: await bundleService.getBundle(req.params.id) });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await bundleService.createBundle(req.body);
  await audit({ actorType: req.auth!.type, actorId: req.auth!.sub, action: 'bundle.create', entity: 'Bundle', entityId: data.id, meta: { name: data.name } });
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await bundleService.updateBundle(req.params.id, req.body);
  await audit({ actorType: req.auth!.type, actorId: req.auth!.sub, action: 'bundle.update', entity: 'Bundle', entityId: req.params.id });
  res.json({ success: true, data });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await bundleService.deleteBundle(req.params.id);
  await audit({ actorType: req.auth!.type, actorId: req.auth!.sub, action: 'bundle.delete', entity: 'Bundle', entityId: req.params.id });
  res.json({ success: true, message: 'Bundle deleted' });
});

// Customer expands a bundle into their cart.
export const addToCart = asyncHandler(async (req: Request, res: Response) => {
  const data = await bundleService.addBundleToCart(req.auth!.sub, req.params.id);
  res.json({ success: true, data });
});
