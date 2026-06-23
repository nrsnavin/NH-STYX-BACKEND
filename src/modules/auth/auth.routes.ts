import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { authenticate, requireCustomer, requireStaff } from '../../middlewares/auth.middleware';
import {
  customerLoginSchema,
  customerRegisterSchema,
  refreshSchema,
  staffLoginSchema,
} from './auth.validation';
import * as authController from './auth.controller';

const router = Router();

// Staff (operations console)
router.post('/staff/login', validate(staffLoginSchema), authController.staffLogin);
router.get('/staff/me', authenticate, requireStaff, authController.staffMe);

// Customers (mobile app)
router.post('/customer/register', validate(customerRegisterSchema), authController.customerRegister);
router.post('/customer/login', validate(customerLoginSchema), authController.customerLogin);
router.get('/customer/me', authenticate, requireCustomer, authController.customerMe);

// Shared
router.post('/refresh', validate(refreshSchema), authController.refresh);
router.post('/logout', authController.logout);

export default router;
