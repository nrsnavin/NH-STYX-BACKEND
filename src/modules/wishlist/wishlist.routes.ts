import { Router } from 'express';
import { authenticate, requireCustomer } from '../../middlewares/auth.middleware';
import * as wishlistController from './wishlist.controller';

const router = Router();

// Wishlist is a customer-only feature.
router.use(authenticate, requireCustomer);

router.get('/', wishlistController.list);
router.get('/ids', wishlistController.ids);
router.post('/:productId', wishlistController.add);
router.delete('/:productId', wishlistController.remove);

export default router;
