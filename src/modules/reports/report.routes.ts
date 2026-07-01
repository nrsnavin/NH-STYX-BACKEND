import { Request, Response, Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { getStaffStoreId } from '../../utils/storeContext';
import * as reports from './report.service';

const router = Router();
const staff = [authenticate, authorize('ADMIN', 'AGENT')] as const;

async function scope(req: Request): Promise<string | null> {
  return req.auth?.role === 'ADMIN' ? null : getStaffStoreId(req.auth!.sub);
}

function parseRange(req: Request) {
  const parse = (v: unknown) => {
    if (typeof v !== 'string' || !v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  // `to` defaults to end-of-day so a same-day range is inclusive.
  const to = parse(req.query.to);
  if (to) to.setHours(23, 59, 59, 999);
  return { from: parse(req.query.from), to };
}

function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

router.get(
  '/sales',
  ...staff,
  asyncHandler(async (req: Request, res: Response) => {
    const csv = await reports.salesRegisterCsv(await scope(req), parseRange(req));
    sendCsv(res, `sales-register-${Date.now()}.csv`, csv);
  }),
);

router.get(
  '/gst',
  ...staff,
  asyncHandler(async (req: Request, res: Response) => {
    const csv = await reports.gstSummaryCsv(await scope(req), parseRange(req));
    sendCsv(res, `gst-summary-${Date.now()}.csv`, csv);
  }),
);

router.get(
  '/inventory',
  ...staff,
  asyncHandler(async (req: Request, res: Response) => {
    const csv = await reports.inventoryValuationCsv(await scope(req));
    sendCsv(res, `inventory-valuation-${Date.now()}.csv`, csv);
  }),
);

export default router;
