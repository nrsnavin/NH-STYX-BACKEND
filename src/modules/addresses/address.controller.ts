import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as addressService from './address.service';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const data = await addressService.listAddresses(req.auth!.sub);
  res.json({ success: true, data });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await addressService.createAddress(req.auth!.sub, req.body);
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await addressService.updateAddress(req.auth!.sub, req.params.id, req.body);
  res.json({ success: true, data });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await addressService.deleteAddress(req.auth!.sub, req.params.id);
  res.json({ success: true, message: 'Address deleted' });
});
