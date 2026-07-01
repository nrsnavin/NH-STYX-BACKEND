import { Router } from 'express';
import {
  authenticate,
  authorize,
  requireCustomer,
} from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  bulkOrderStatusSchema,
  cancelOrderSchema,
  createOrderSchema,
  listOrdersSchema,
  orderIdSchema,
  razorpayVerifySchema,
  recordPaymentSchema,
  shipOrderSchema,
  staffOrderSchema,
  updateOrderStatusSchema,
} from './order.validation';
import * as orderController from './order.controller';

const router = Router();

// Checkout — customers only (uses their server-side cart).
router.post('/', authenticate, requireCustomer, validate(createOrderSchema), orderController.create);

// Agent/admin places an order on behalf of a customer (explicit line items).
router.post(
  '/staff',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(staffOrderSchema),
  orderController.createForCustomer,
);

// Bulk fulfilment status change (literal path — before /:id routes).
router.post(
  '/bulk-status',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(bulkOrderStatusSchema),
  orderController.bulkStatus,
);

// Listing/detail — role-aware (customer → own, staff → all).
router.get('/', authenticate, validate(listOrdersSchema), orderController.list);
router.get('/:id', authenticate, validate(orderIdSchema), orderController.getOne);
router.get('/:id/tracking', authenticate, validate(orderIdSchema), orderController.tracking);
router.get('/:id/invoice', authenticate, validate(orderIdSchema), orderController.invoice);

// (Re)issue a Razorpay checkout for an existing unpaid online order (pay-now
// from the Orders screen — e.g. an agent-placed order).
router.post(
  '/:id/pay/razorpay',
  authenticate,
  validate(orderIdSchema),
  orderController.payRazorpay,
);

// Customer pays an online order (Razorpay).
router.post(
  '/:id/pay/razorpay/verify',
  authenticate,
  requireCustomer,
  validate(razorpayVerifySchema),
  orderController.verifyRazorpay,
);

// Staff operations.
router.patch(
  '/:id/status',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(updateOrderStatusSchema),
  orderController.updateStatus,
);

// Record a dispatch (courier + AWB) → SHIPPED, and mark delivered.
router.post(
  '/:id/ship',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(shipOrderSchema),
  orderController.ship,
);
router.post(
  '/:id/book-shipment',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(orderIdSchema),
  orderController.bookShipment,
);
router.post(
  '/:id/deliver',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(orderIdSchema),
  orderController.deliver,
);
router.post(
  '/:id/cancel',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(cancelOrderSchema),
  orderController.cancel,
);
router.post(
  '/:id/payments',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(recordPaymentSchema),
  orderController.recordPayment,
);

export default router;
