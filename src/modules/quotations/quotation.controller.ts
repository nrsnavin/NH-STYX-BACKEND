import { Request, Response } from 'express';
import { PaymentMethod, QuotationStatus } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { getStaffStoreId } from '../../utils/storeContext';
import * as service from './quotation.service';
import { streamQuotationPdf } from './quotation.pdf';

/** Agents are scoped to their store; admins (null) see all. */
async function storeScope(req: Request): Promise<string | null> {
  return req.auth?.role === 'ADMIN' ? null : getStaffStoreId(req.auth!.sub);
}

async function assertScope(req: Request, quoteStoreId: string | null): Promise<void> {
  if (req.auth?.role === 'ADMIN') return;
  const storeId = await getStaffStoreId(req.auth!.sub);
  if (storeId && quoteStoreId !== storeId) {
    throw ApiError.forbidden('This quotation belongs to another store');
  }
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, status, search, customerId } = req.query as unknown as {
    page: number;
    limit: number;
    status?: QuotationStatus;
    search?: string;
    customerId?: string;
  };
  const storeId = await storeScope(req);
  const data = await service.listQuotations({ page, limit, status, search, customerId, storeId });
  res.json({ success: true, ...data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const quote = await service.getQuotation(req.params.id);
  await assertScope(req, quote.storeId);
  res.json({ success: true, data: quote });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const storeId = await getStaffStoreId(req.auth!.sub);
  const data = await service.createQuotation(req.body, { id: req.auth!.sub, storeId });
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const quote = await service.getQuotation(req.params.id);
  await assertScope(req, quote.storeId);
  const data = await service.updateQuotation(req.params.id, req.body);
  res.json({ success: true, data });
});

export const setStatus = asyncHandler(async (req: Request, res: Response) => {
  const quote = await service.getQuotation(req.params.id);
  await assertScope(req, quote.storeId);
  const data = await service.setStatus(req.params.id, req.body.status as QuotationStatus);
  res.json({ success: true, data });
});

export const convert = asyncHandler(async (req: Request, res: Response) => {
  const quote = await service.getQuotation(req.params.id);
  await assertScope(req, quote.storeId);
  const data = await service.convertQuotation(
    req.params.id,
    { paymentMethod: req.body.paymentMethod as PaymentMethod, addressId: req.body.addressId },
    req.auth!.sub,
  );
  res.status(201).json({ success: true, data });
});

/** Quotation PDF — staff (store-scoped) or the owning customer. */
export const pdf = asyncHandler(async (req: Request, res: Response) => {
  await streamQuotationPdf(req.params.id, req.auth!, res);
});

// ---- Customer self-service --------------------------------------------------

export const listMine = asyncHandler(async (req: Request, res: Response) => {
  const items = await service.listForCustomer(req.auth!.sub);
  res.json({ success: true, items });
});

export const getMine = asyncHandler(async (req: Request, res: Response) => {
  const data = await service.getForCustomer(req.auth!.sub, req.params.id);
  res.json({ success: true, data });
});

export const respond = asyncHandler(async (req: Request, res: Response) => {
  const data = await service.respondToQuote(req.auth!.sub, req.params.id, req.body.action);
  res.json({ success: true, data });
});
