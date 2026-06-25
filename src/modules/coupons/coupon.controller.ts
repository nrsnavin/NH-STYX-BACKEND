import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import * as couponService from './coupon.service';

/** Customer previews a code against their current cart. */
export const validate = asyncHandler(async (req: Request, res: Response) => {
  const data = await couponService.previewForCart(req.auth!.sub, req.body.code);
  res.json({ success: true, data });
});

// ---- Admin management --------------------------------------------------------

export const list = asyncHandler(async (_req: Request, res: Response) => {
  const data = await couponService.listCoupons();
  res.json({ success: true, data });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await couponService.createCoupon(req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'coupon.create',
    entity: 'Coupon',
    entityId: data.id,
    meta: { code: data.code, type: data.type, value: data.value },
  });
  res.status(201).json({ success: true, data });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = await couponService.updateCoupon(req.params.id, req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'coupon.update',
    entity: 'Coupon',
    entityId: req.params.id,
  });
  res.json({ success: true, data });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await couponService.deleteCoupon(req.params.id);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'coupon.delete',
    entity: 'Coupon',
    entityId: req.params.id,
  });
  res.json({ success: true, message: 'Coupon deactivated' });
});
