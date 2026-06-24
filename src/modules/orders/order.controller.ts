import { Request, Response } from 'express';
import { OrderStatus } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler';
import * as orderService from './order.service';
import { streamInvoice } from './invoice.service';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.createOrder(req.auth!.sub, req.body);
  res.status(201).json({ success: true, data });
});

export const invoice = asyncHandler(async (req: Request, res: Response) => {
  await streamInvoice(req.params.id, req.auth!, res);
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, status } = req.query as unknown as {
    page: number;
    limit: number;
    status?: OrderStatus;
  };
  const data = await orderService.listOrders(
    { sub: req.auth!.sub, type: req.auth!.type },
    { page, limit, status },
  );
  res.json({ success: true, ...data });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.getOrder(
    { sub: req.auth!.sub, type: req.auth!.type },
    req.params.id,
  );
  res.json({ success: true, data });
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.updateOrderStatus(req.params.id, req.body.status);
  res.json({ success: true, data });
});

export const recordPayment = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.recordPayment(req.params.id, req.body);
  res.status(201).json({ success: true, data });
});

export const verifyRazorpay = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.verifyRazorpay(req.auth!.sub, req.params.id, req.body);
  res.json({ success: true, data });
});
