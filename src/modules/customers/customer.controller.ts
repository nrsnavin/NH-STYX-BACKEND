import { Request, Response } from 'express';
import { CustomerStatus } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { audit } from '../../utils/audit';
import { getStaffStoreId } from '../../utils/storeContext';
import * as customerService from './customer.service';
import { customerInsights } from './customer.insights';
import { createWinbackOffer } from './customer.winback';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search, status } = req.query as unknown as {
    page: number;
    limit: number;
    search?: string;
    status?: CustomerStatus;
  };
  // Agents are scoped to their store; admins (storeId null) see all customers.
  const storeId = req.auth?.type === 'STAFF' ? await getStaffStoreId(req.auth.sub) : null;
  const data = await customerService.listCustomers({ page, limit, search, status, storeId });
  res.json({ success: true, ...data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const data = await customerService.getCustomer(req.params.id);
  await assertStoreScope(req, data.storeId);
  res.json({ success: true, data });
});

export const insights = asyncHandler(async (req: Request, res: Response) => {
  const customer = await customerService.getCustomer(req.params.id);
  await assertStoreScope(req, customer.storeId);
  const data = await customerInsights(req.params.id);
  res.json({ success: true, data });
});

/** One-click reactivation: mints a single-use coupon to win the shop back. */
export const winback = asyncHandler(async (req: Request, res: Response) => {
  const customer = await customerService.getCustomer(req.params.id);
  await assertStoreScope(req, customer.storeId);
  const data = await createWinbackOffer(req.params.id, req.body ?? {});
  await audit({
    actorType: 'STAFF',
    actorId: req.auth!.sub,
    action: 'customer.winback',
    entity: 'Customer',
    entityId: req.params.id,
    meta: { code: data.code, percent: data.percent },
  });
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await customerService.updateCustomer(req.params.id, req.body);
  res.json({ success: true, data });
});

export const approve = asyncHandler(async (req: Request, res: Response) => {
  await assertOwnStoreCustomer(req, req.params.id);
  const data = await customerService.approveCustomer(req.params.id, req.auth!.sub, req.body ?? {});
  await audit({
    actorType: 'STAFF',
    actorId: req.auth!.sub,
    action: 'customer.approve',
    entity: 'Customer',
    entityId: req.params.id,
    meta: { creditApproved: req.body?.creditApproved, creditLimitPaise: req.body?.creditLimitPaise },
  });
  res.json({ success: true, data });
});

export const reject = asyncHandler(async (req: Request, res: Response) => {
  await assertOwnStoreCustomer(req, req.params.id);
  const data = await customerService.rejectCustomer(req.params.id, req.auth!.sub, req.body?.reason);
  await audit({
    actorType: 'STAFF',
    actorId: req.auth!.sub,
    action: 'customer.reject',
    entity: 'Customer',
    entityId: req.params.id,
    meta: { reason: req.body?.reason },
  });
  res.json({ success: true, data });
});

/** Agents may only see/act on customers of their own store; admins on any. */
async function assertStoreScope(req: Request, customerStoreId: string | null): Promise<void> {
  if (req.auth?.role === 'ADMIN') return;
  const storeId = req.auth?.type === 'STAFF' ? await getStaffStoreId(req.auth.sub) : null;
  if (storeId && customerStoreId !== storeId) {
    throw ApiError.forbidden('This customer belongs to another store');
  }
}

async function assertOwnStoreCustomer(req: Request, customerId: string): Promise<void> {
  const customer = await customerService.getCustomer(customerId);
  await assertStoreScope(req, customer.storeId);
}
