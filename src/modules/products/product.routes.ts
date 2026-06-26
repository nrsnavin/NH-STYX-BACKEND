import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createProductSchema,
  listProductsSchema,
  productIdSchema,
  productMovementsSchema,
  updateProductSchema,
} from './product.validation';
import * as productController from './product.controller';

const router = Router();

router.get('/', authenticate, validate(listProductsSchema), productController.list);
// Specific routes must precede the `/:id` param route.
router.get('/best-selling', authenticate, productController.bestSelling);
router.get('/recently-ordered', authenticate, productController.recentlyOrdered);
router.get(
  '/:id/movements',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(productMovementsSchema),
  productController.movements,
);
router.get('/:id', authenticate, validate(productIdSchema), productController.getOne);

// Staff (admins + agents) can add and edit catalog products; only admins delete.
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(createProductSchema),
  productController.create,
);
router.patch(
  '/:id',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(updateProductSchema),
  productController.update,
);
router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN'),
  validate(productIdSchema),
  productController.remove,
);

export default router;
