import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import { getStaffStoreId } from '../../utils/storeContext';
import * as service from './notification.service';

/** Customer in-app feed + unread badge count. */
export const mine = asyncHandler(async (req: Request, res: Response) => {
  const [items, unread] = await Promise.all([
    service.listMine(req.auth!.sub),
    service.unreadCount(req.auth!.sub),
  ]);
  res.json({ success: true, items, unread });
});

export const readOne = asyncHandler(async (req: Request, res: Response) => {
  await service.markRead(req.auth!.sub, req.params.id);
  res.json({ success: true });
});

export const readAll = asyncHandler(async (req: Request, res: Response) => {
  await service.markAllRead(req.auth!.sub);
  res.json({ success: true });
});

/** Staff activity stream for the ops console. */
export const staffList = asyncHandler(async (_req: Request, res: Response) => {
  const items = await service.listStaff();
  res.json({ success: true, items });
});

/** Staff broadcasts a message to a segment of customers. */
export const broadcast = asyncHandler(async (req: Request, res: Response) => {
  // Agents may only message their own store's customers; admins target any/all.
  const storeId =
    req.auth?.role === 'ADMIN'
      ? (req.body.storeId ?? null)
      : await getStaffStoreId(req.auth!.sub);
  const data = await service.broadcastToCustomers(
    { storeId, status: req.body.status },
    { title: req.body.title.trim(), body: req.body.body.trim() },
  );
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'notification.broadcast',
    entity: 'Notification',
    meta: { sent: data.sent, storeId, status: req.body.status },
  });
  res.json({ success: true, data });
});
