import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../middlewares/validate.middleware';
import { authenticate, requireCustomer, requireStaff } from '../../middlewares/auth.middleware';
import {
  customerLoginSchema,
  customerRegisterSchema,
  customerUpdateSelfSchema,
  refreshSchema,
  staffLoginSchema,
} from './auth.validation';
import * as authController from './auth.controller';

const router = Router();

// Tight throttle on credential-taking endpoints (login/register/refresh) to
// blunt brute-force / credential-stuffing. Successful logins don't count
// against the budget, so a legitimate user is never locked out by their own
// sign-ins. This is stricter than the API-wide limiter.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many attempts. Please try again in a few minutes.' },
});

// Staff (operations console)
router.post('/staff/login', authLimiter, validate(staffLoginSchema), authController.staffLogin);
router.get('/staff/me', authenticate, requireStaff, authController.staffMe);

// Customers (mobile app)
router.post(
  '/customer/register',
  authLimiter,
  validate(customerRegisterSchema),
  authController.customerRegister,
);
router.post('/customer/login', authLimiter, validate(customerLoginSchema), authController.customerLogin);
router.get('/customer/me', authenticate, requireCustomer, authController.customerMe);
router.patch(
  '/customer/me',
  authenticate,
  requireCustomer,
  validate(customerUpdateSelfSchema),
  authController.customerUpdateMe,
);

// Shared
router.post('/refresh', authLimiter, validate(refreshSchema), authController.refresh);
router.post('/logout', authController.logout);

export default router;
