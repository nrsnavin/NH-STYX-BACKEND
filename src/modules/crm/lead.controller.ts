import { Request, Response } from 'express';
import { ActivityType, LeadStage } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { getStaffStoreId } from '../../utils/storeContext';
import * as leadService from './lead.service';

/** Agents are scoped to their store; admins (null) see all. */
async function storeScope(req: Request): Promise<string | null> {
  return req.auth?.role === 'ADMIN' ? null : getStaffStoreId(req.auth!.sub);
}

async function assertScope(req: Request, leadStoreId: string | null): Promise<void> {
  if (req.auth?.role === 'ADMIN') return;
  const storeId = await getStaffStoreId(req.auth!.sub);
  if (storeId && leadStoreId !== storeId) {
    throw ApiError.forbidden('This lead belongs to another store');
  }
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search, stage, due } = req.query as unknown as {
    page: number;
    limit: number;
    search?: string;
    stage?: LeadStage;
    due?: boolean;
  };
  const storeId = await storeScope(req);
  const [data, counts] = await Promise.all([
    leadService.listLeads({ page, limit, search, stage, due, storeId }),
    leadService.leadStageCounts(storeId),
  ]);
  res.json({ success: true, ...data, counts });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const data = await leadService.getLead(req.params.id);
  await assertScope(req, data.storeId);
  res.json({ success: true, data });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const storeId = await getStaffStoreId(req.auth!.sub);
  const data = await leadService.createLead(req.body, { id: req.auth!.sub, storeId });
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const lead = await leadService.getLead(req.params.id);
  await assertScope(req, lead.storeId);
  const data = await leadService.updateLead(req.params.id, req.body);
  res.json({ success: true, data });
});

export const convert = asyncHandler(async (req: Request, res: Response) => {
  const lead = await leadService.getLead(req.params.id);
  await assertScope(req, lead.storeId);
  const data = await leadService.convertLead(req.params.id);
  res.json({ success: true, data });
});

export const listActivities = asyncHandler(async (req: Request, res: Response) => {
  const { leadId, customerId } = req.query as { leadId?: string; customerId?: string };
  const data = await leadService.listActivities({ leadId, customerId });
  res.json({ success: true, items: data });
});

export const addActivity = asyncHandler(async (req: Request, res: Response) => {
  const data = await leadService.addActivity(
    req.body as { type: ActivityType; body: string; leadId?: string; customerId?: string; followUpAt?: string | null },
    req.auth!.sub,
  );
  res.status(201).json({ success: true, data });
});
