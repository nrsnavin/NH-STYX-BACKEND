import { Router } from 'express';
import { authenticate, authorize, requireCustomer } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  couponIdSchema,
  createCouponSchema,
  updateCouponSchema,
  validateCouponSchema,
} from './coupon.validation';
import * as couponController from './coupon.controller';

const router = Router();

// Customer: preview a coupon against their cart.
router.post(
  '/validate',
  authenticate,
  requireCustomer,
  validate(validateCouponSchema),
  couponController.validate,
);

// Staff: view all coupons. Admin: create / edit / deactivate.
router.get('/', authenticate, authorize('ADMIN', 'AGENT'), couponController.list);
router.post('/', authenticate, authorize('ADMIN'), validate(createCouponSchema), couponController.create);
router.patch('/:id', authenticate, authorize('ADMIN'), validate(updateCouponSchema), couponController.update);
router.delete('/:id', authenticate, authorize('ADMIN'), validate(couponIdSchema), couponController.remove);

export default router;
