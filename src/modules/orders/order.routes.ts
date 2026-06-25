import { Router } from 'express';
import {
  authenticate,
  authorize,
  requireCustomer,
} from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createOrderSchema,
  listOrdersSchema,
  orderIdSchema,
  razorpayVerifySchema,
  recordPaymentSchema,
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

// Listing/detail — role-aware (customer → own, staff → all).
router.get('/', authenticate, validate(listOrdersSchema), orderController.list);
router.get('/:id', authenticate, validate(orderIdSchema), orderController.getOne);
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
router.post(
  '/:id/payments',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(recordPaymentSchema),
  orderController.recordPayment,
);

export default router;
