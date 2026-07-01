import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { getCustomerStoreId, getStaffStoreId } from '../../utils/storeContext';
import { aiSearch, globalSearch } from './search.service';

// Ops console quick search across orders / customers / products / leads.
export const global = asyncHandler(async (req: Request, res: Response) => {
  const storeId = req.auth?.role === 'ADMIN' ? null : await getStaffStoreId(req.auth!.sub);
  const data = await globalSearch(storeId, String(req.query.q ?? ''));
  res.json({ success: true, data });
});

export const ai = asyncHandler(async (req: Request, res: Response) => {
  // Search is store-scoped: a customer searches their store, an agent searches
  // theirs. No store linked → empty result (admins have no single store).
  const storeId =
    req.auth?.type === 'CUSTOMER'
      ? await getCustomerStoreId(req.auth.sub)
      : req.auth?.type === 'STAFF'
        ? await getStaffStoreId(req.auth.sub)
        : null;

  if (!storeId) {
    res.json({
      success: true,
      reply: 'No store is linked to your account yet.',
      aiPowered: false,
      filters: { keywords: [], categorySlug: null, maxPricePaise: null, minQty: null },
      categories: [],
      items: [],
    });
    return;
  }

  const data = await aiSearch(storeId, req.body.query);
  res.json({ success: true, ...data });
});
