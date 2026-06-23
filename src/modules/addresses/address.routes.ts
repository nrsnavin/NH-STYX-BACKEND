import { Router } from 'express';
import { authenticate, requireCustomer } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { addressIdSchema, createAddressSchema, updateAddressSchema } from './address.validation';
import * as addressController from './address.controller';

const router = Router();

router.use(authenticate, requireCustomer);

router.get('/', addressController.list);
router.post('/', validate(createAddressSchema), addressController.create);
router.patch('/:id', validate(updateAddressSchema), addressController.update);
router.delete('/:id', validate(addressIdSchema), addressController.remove);

export default router;
