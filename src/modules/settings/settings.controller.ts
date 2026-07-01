import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import * as settingsService from './settings.service';

export const get = asyncHandler(async (_req: Request, res: Response) => {
  const data = await settingsService.getSettings();
  res.json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await settingsService.updateSettings(req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'settings.update',
    entity: 'Setting',
    meta: { keys: Object.keys(req.body ?? {}) },
  });
  res.json({ success: true, data });
});
