import { Request, Response, Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { getStaffStoreId } from '../../utils/storeContext';
import * as statsService from './stats.service';

const router = Router();
const staff = [authenticate, authorize('ADMIN', 'AGENT')] as const;

async function scope(req: Request): Promise<string | null> {
  return req.auth?.role === 'ADMIN' ? null : getStaffStoreId(req.auth!.sub);
}

router.get(
  '/dashboard',
  ...staff,
  asyncHandler(async (req: Request, res: Response) => {
    const data = await statsService.dashboard(await scope(req));
    res.json({ success: true, data });
  }),
);

router.get(
  '/low-stock',
  ...staff,
  asyncHandler(async (req: Request, res: Response) => {
    const threshold = req.query.threshold ? Number(req.query.threshold) : undefined;
    const items = await statsService.lowStock(await scope(req), threshold);
    res.json({ success: true, items });
  }),
);

router.get(
  '/receivables',
  ...staff,
  asyncHandler(async (req: Request, res: Response) => {
    const data = await statsService.receivables(await scope(req));
    res.json({ success: true, data });
  }),
);

// Agent sales performance — admins see every agent, an agent sees only self.
router.get(
  '/agent-performance',
  ...staff,
  asyncHandler(async (req: Request, res: Response) => {
    const selfId = req.auth?.role === 'ADMIN' ? null : req.auth!.sub;
    const data = await statsService.agentPerformance(selfId);
    res.json({ success: true, data });
  }),
);

export default router;
