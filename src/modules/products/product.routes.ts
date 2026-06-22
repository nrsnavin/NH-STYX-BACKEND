import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createProductSchema,
  listProductsSchema,
  productIdSchema,
  updateProductSchema,
} from './product.validation';
import * as productController from './product.controller';

const router = Router();

router.get('/', authenticate, validate(listProductsSchema), productController.list);
router.get('/:id', authenticate, validate(productIdSchema), productController.getOne);

router.post(
  '/',
  authenticate,
  authorize('ADMIN'),
  validate(createProductSchema),
  productController.create,
);
router.patch(
  '/:id',
  authenticate,
  authorize('ADMIN'),
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
