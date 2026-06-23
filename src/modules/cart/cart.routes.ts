import { Router } from 'express';
import { authenticate, requireCustomer } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { addItemSchema, itemParamSchema, updateItemSchema } from './cart.validation';
import * as cartController from './cart.controller';

const router = Router();

// The cart belongs to the authenticated customer.
router.use(authenticate, requireCustomer);

router.get('/', cartController.get);
router.post('/items', validate(addItemSchema), cartController.addItem);
router.patch('/items/:productId', validate(updateItemSchema), cartController.updateItem);
router.delete('/items/:productId', validate(itemParamSchema), cartController.removeItem);
router.delete('/', cartController.clear);

export default router;
