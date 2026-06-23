import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { aiSearch } from './search.service';

export const ai = asyncHandler(async (req: Request, res: Response) => {
  const data = await aiSearch(req.body.query);
  res.json({ success: true, ...data });
});
