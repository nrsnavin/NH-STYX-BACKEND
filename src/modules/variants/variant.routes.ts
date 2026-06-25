import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createVariantSchema,
  productIdParamSchema,
  storeVariantIdSchema,
  storeVariantsQuerySchema,
  updateVariantSchema,
  upsertStoreVariantSchema,
  variantIdSchema,
} from './variant.validation';
import * as variantController from './variant.controller';

const router = Router();

// Per-store variant inventory (admins + the store's agent). Declared before the
// catalog `/:id` routes so "/store/..." isn't captured as an id.
router.get(
  '/store/:storeId',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(storeVariantsQuerySchema),
  variantController.listStore,
);
router.put(
  '/store/:storeId/:variantId',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(upsertStoreVariantSchema),
  variantController.upsertStore,
);
router.delete(
  '/store/:storeId/:variantId',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(storeVariantIdSchema),
  variantController.removeStore,
);

// Catalog variant management.
router.get(
  '/product/:productId',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(productIdParamSchema),
  variantController.list,
);
router.post(
  '/product/:productId',
  authenticate,
  authorize('ADMIN'),
  validate(createVariantSchema),
  variantController.create,
);
router.patch('/:id', authenticate, authorize('ADMIN'), validate(updateVariantSchema), variantController.update);
router.delete('/:id', authenticate, authorize('ADMIN'), validate(variantIdSchema), variantController.remove);

export default router;
