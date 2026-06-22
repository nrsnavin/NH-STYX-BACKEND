import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createOrderSchema,
  listOrdersSchema,
  orderIdSchema,
  updateOrderStatusSchema,
} from './order.validation';
import * as orderController from './order.controller';

const router = Router();

// Any authenticated user can place an order (role decides on whose behalf).
router.post('/', authenticate, validate(createOrderSchema), orderController.create);

// Listing is role-aware (customer → own, agent → assigned, admin → all).
router.get('/', authenticate, validate(listOrdersSchema), orderController.list);
router.get('/:id', authenticate, validate(orderIdSchema), orderController.getOne);

// Only staff can move an order through its lifecycle.
router.patch(
  '/:id/status',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(updateOrderStatusSchema),
  orderController.updateStatus,
);

export default router;
