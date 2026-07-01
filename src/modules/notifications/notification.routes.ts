import { Router } from 'express';
import { authenticate, requireCustomer, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { broadcastSchema } from './notification.validation';
import * as controller from './notification.controller';

const router = Router();

// Customer in-app feed.
router.get('/mine', authenticate, requireCustomer, controller.mine);
router.post('/mine/read-all', authenticate, requireCustomer, controller.readAll);
router.post('/:id/read', authenticate, requireCustomer, controller.readOne);

// Staff activity stream (ops console).
router.get('/', authenticate, authorize('ADMIN', 'AGENT'), controller.staffList);

// Staff broadcasts a message to a segment of customers.
router.post(
  '/broadcast',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(broadcastSchema),
  controller.broadcast,
);

export default router;
