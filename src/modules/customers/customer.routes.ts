import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  approveCustomerSchema,
  customerIdSchema,
  listCustomersSchema,
  rejectCustomerSchema,
  updateCustomerSchema,
} from './customer.validation';
import * as customerController from './customer.controller';

const router = Router();

// Staff-only customer management.
router.get('/', authenticate, authorize('ADMIN', 'AGENT'), validate(listCustomersSchema), customerController.list);
router.get('/:id', authenticate, authorize('ADMIN', 'AGENT'), validate(customerIdSchema), customerController.getOne);
router.patch('/:id', authenticate, authorize('ADMIN'), validate(updateCustomerSchema), customerController.update);

// Registration approval — the serving store's agent (or an admin) decides.
router.post('/:id/approve', authenticate, authorize('ADMIN', 'AGENT'), validate(approveCustomerSchema), customerController.approve);
router.post('/:id/reject', authenticate, authorize('ADMIN', 'AGENT'), validate(rejectCustomerSchema), customerController.reject);

export default router;
