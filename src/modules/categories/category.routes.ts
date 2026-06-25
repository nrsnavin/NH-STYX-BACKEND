import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  categoryIdSchema,
  createCategorySchema,
  updateCategorySchema,
} from './category.validation';
import * as categoryController from './category.controller';

const router = Router();

// All authenticated users can browse categories.
router.get('/', authenticate, categoryController.list);
router.get('/:id', authenticate, validate(categoryIdSchema), categoryController.getOne);

// Staff (admins + agents) can add and edit categories; only admins delete.
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(createCategorySchema),
  categoryController.create,
);
router.patch(
  '/:id',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(updateCategorySchema),
  categoryController.update,
);
router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN'),
  validate(categoryIdSchema),
  categoryController.remove,
);

export default router;
