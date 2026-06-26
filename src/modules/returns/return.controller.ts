import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import * as returnService from './return.service';

// Customer or staff raises a return against an order.
export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await returnService.createReturn(
    { sub: req.auth!.sub, type: req.auth!.type },
    req.body,
  );
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'return.create',
    entity: 'OrderReturn',
    entityId: data.id,
    meta: { orderId: req.body.orderId, refundAmountPaise: data.refundAmountPaise },
  });
  res.status(201).json({ success: true, data });
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const items = await returnService.listReturns({ sub: req.auth!.sub, type: req.auth!.type });
  res.json({ success: true, items });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const data = await returnService.getReturn(
    { sub: req.auth!.sub, type: req.auth!.type },
    req.params.id,
  );
  res.json({ success: true, data });
});

// Staff processes the refund (restock + Razorpay/manual refund).
export const refund = asyncHandler(async (req: Request, res: Response) => {
  const data = await returnService.refundReturn(req.params.id, req.auth!.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'return.refund',
    entity: 'OrderReturn',
    entityId: req.params.id,
  });
  res.json({ success: true, data });
});

// Staff declines a return.
export const reject = asyncHandler(async (req: Request, res: Response) => {
  const data = await returnService.rejectReturn(req.params.id, req.body.reason, req.auth!.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'return.reject',
    entity: 'OrderReturn',
    entityId: req.params.id,
  });
  res.json({ success: true, data });
});
