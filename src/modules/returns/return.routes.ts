import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { createReturnSchema, rejectReturnSchema, returnIdSchema } from './return.validation';
import * as controller from './return.controller';

const router = Router();

// Customers and staff can raise a return; listing/detail is role-aware
// (customer → own returns, staff → their store's).
router.post('/', authenticate, validate(createReturnSchema), controller.create);
router.get('/', authenticate, controller.list);
router.get('/:id', authenticate, validate(returnIdSchema), controller.getOne);

// Processing is staff-only.
router.post(
  '/:id/refund',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(returnIdSchema),
  controller.refund,
);
router.post(
  '/:id/reject',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(rejectReturnSchema),
  controller.reject,
);

export default router;
