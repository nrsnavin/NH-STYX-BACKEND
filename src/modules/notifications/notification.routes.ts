import { Router } from 'express';
import { authenticate, requireCustomer, authorize } from '../../middlewares/auth.middleware';
import * as controller from './notification.controller';

const router = Router();

// Customer in-app feed.
router.get('/mine', authenticate, requireCustomer, controller.mine);
router.post('/mine/read-all', authenticate, requireCustomer, controller.readAll);
router.post('/:id/read', authenticate, requireCustomer, controller.readOne);

// Staff activity stream (ops console).
router.get('/', authenticate, authorize('ADMIN', 'AGENT'), controller.staffList);

export default router;
