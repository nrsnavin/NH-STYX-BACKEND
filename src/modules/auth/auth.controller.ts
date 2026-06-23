import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as authService from './auth.service';

export const staffLogin = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.staffLogin(req.body);
  res.json({ success: true, data: result });
});

export const staffMe = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.staffProfile(req.auth!.sub);
  res.json({ success: true, data: result });
});

export const customerRegister = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.customerRegister(req.body);
  res.status(201).json({ success: true, data: result });
});

export const customerLogin = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.customerLogin(req.body);
  res.json({ success: true, data: result });
});

export const customerMe = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.customerProfile(req.auth!.sub);
  res.json({ success: true, data: result });
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.refresh(req.body.refreshToken);
  res.json({ success: true, data: result });
});

// Stateless tokens — logout is a client-side discard. Endpoint kept for parity.
export const logout = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ success: true, message: 'Logged out' });
});
