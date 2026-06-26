import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
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
