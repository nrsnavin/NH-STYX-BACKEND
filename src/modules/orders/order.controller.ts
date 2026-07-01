import { Request, Response } from 'express';
import { OrderStatus } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import * as orderService from './order.service';
import { streamInvoice } from './invoice.service';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.createOrder(req.auth!.sub, req.body);
  res.status(201).json({ success: true, data });
});

// Agent/admin places an order on behalf of a customer (phoned-in bulk order).
export const createForCustomer = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.createStaffOrder(req.auth!.sub, req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'order.staff_create',
    entity: 'Order',
    entityId: data.order.id,
    meta: { customerId: req.body.customerId, paymentMethod: req.body.paymentMethod },
  });
  res.status(201).json({ success: true, data });
});

// (Re)issue a Razorpay checkout for an existing unpaid online order (pay-now).
export const payRazorpay = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.reissueRazorpay(
    { sub: req.auth!.sub, type: req.auth!.type },
    req.params.id,
  );
  res.json({ success: true, data });
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

// Shipment tracking timeline (live from the courier when configured).
export const tracking = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.getOrderTracking(
    { sub: req.auth!.sub, type: req.auth!.type },
    req.params.id,
  );
  res.json({ success: true, data });
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.updateOrderStatus(req.params.id, req.body.status, req.auth!.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'order.status',
    entity: 'Order',
    entityId: req.params.id,
    meta: { status: req.body.status },
  });
  res.json({ success: true, data });
});

// Apply a fulfilment status to many orders at once.
export const bulkStatus = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.bulkUpdateOrderStatus(req.body.ids, req.body.status, req.auth!.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'order.bulk_status',
    entity: 'Order',
    meta: { status: req.body.status, count: data.updated },
  });
  res.json({ success: true, data });
});

export const recordPayment = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.recordPayment(req.params.id, req.body);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'payment.record',
    entity: 'Order',
    entityId: req.params.id,
    meta: { method: req.body.method, amountPaise: req.body.amountPaise },
  });
  res.status(201).json({ success: true, data });
});

export const verifyRazorpay = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.verifyRazorpay(req.auth!.sub, req.params.id, req.body);
  res.json({ success: true, data });
});

// Staff records a dispatch (courier + AWB) and flips the order to SHIPPED.
export const ship = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.shipOrder(req.params.id, req.body, req.auth!.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'order.ship',
    entity: 'Order',
    entityId: req.params.id,
    meta: { courierName: req.body.courierName, trackingNumber: req.body.trackingNumber },
  });
  res.json({ success: true, data });
});

// Staff auto-books a shipment with the configured courier → SHIPPED.
export const bookShipment = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.bookShipment(req.params.id, req.auth!.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'order.book_shipment',
    entity: 'Order',
    entityId: req.params.id,
    meta: { trackingNumber: data.order.trackingNumber, courierName: data.order.courierName },
  });
  res.json({ success: true, data });
});

// Staff cancels an order (restock + refund).
export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.cancelOrder(req.params.id, req.body?.reason, req.auth!.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'order.cancel',
    entity: 'Order',
    entityId: req.params.id,
    meta: { reason: req.body?.reason, refundedPaise: data.refundedPaise },
  });
  res.json({ success: true, data });
});

// Staff marks the order delivered.
export const deliver = asyncHandler(async (req: Request, res: Response) => {
  const data = await orderService.markDelivered(req.params.id, req.auth!.sub);
  await audit({
    actorType: req.auth!.type,
    actorId: req.auth!.sub,
    action: 'order.deliver',
    entity: 'Order',
    entityId: req.params.id,
  });
  res.json({ success: true, data });
});
