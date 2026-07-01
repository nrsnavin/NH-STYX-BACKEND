import { Router } from 'express';
import { authenticate, authorize, requireCustomer } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { bundleIdSchema, createBundleSchema, updateBundleSchema } from './bundle.validation';
import * as bundleController from './bundle.controller';

const router = Router();

// Browse (any authenticated user — customers see store pricing).
router.get('/', authenticate, bundleController.list);
router.get('/:id', authenticate, validate(bundleIdSchema), bundleController.getOne);

// Customer adds a whole bundle to their cart.
router.post('/:id/add-to-cart', authenticate, requireCustomer, validate(bundleIdSchema), bundleController.addToCart);

// Admin management.
router.post('/', authenticate, authorize('ADMIN'), validate(createBundleSchema), bundleController.create);
router.put('/:id', authenticate, authorize('ADMIN'), validate(updateBundleSchema), bundleController.update);
router.delete('/:id', authenticate, authorize('ADMIN'), validate(bundleIdSchema), bundleController.remove);

export default router;
