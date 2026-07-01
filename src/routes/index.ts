import { Router } from 'express';
import { prisma } from '../lib/prisma';
import authRoutes from '../modules/auth/auth.routes';
import categoryRoutes from '../modules/categories/category.routes';
import productRoutes from '../modules/products/product.routes';
import cartRoutes from '../modules/cart/cart.routes';
import addressRoutes from '../modules/addresses/address.routes';
import orderRoutes from '../modules/orders/order.routes';
import customerRoutes from '../modules/customers/customer.routes';
import searchRoutes from '../modules/search/search.routes';
import storeRoutes from '../modules/stores/store.routes';
import uploadRoutes from '../modules/uploads/upload.routes';
import crmRoutes from '../modules/crm/lead.routes';
import statsRoutes from '../modules/stats/stats.routes';
import userRoutes from '../modules/users/user.routes';
import auditRoutes from '../modules/audit/audit.routes';
import wishlistRoutes from '../modules/wishlist/wishlist.routes';
import couponRoutes from '../modules/coupons/coupon.routes';
import variantRoutes from '../modules/variants/variant.routes';
import quotationRoutes from '../modules/quotations/quotation.routes';
import purchasingRoutes from '../modules/purchasing/purchasing.routes';
import returnRoutes from '../modules/returns/return.routes';
import notificationRoutes from '../modules/notifications/notification.routes';
import reportRoutes from '../modules/reports/report.routes';
import settingsRoutes from '../modules/settings/settings.routes';
import bundleRoutes from '../modules/bundles/bundle.routes';

const router = Router();

/** Liveness/readiness probe. Verifies the DB connection. */
router.get('/health', async (_req, res) => {
  let database = 'down';
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = 'up';
  } catch {
    database = 'down';
  }
  res.status(database === 'up' ? 200 : 503).json({
    status: database === 'up' ? 'ok' : 'degraded',
    service: 'nh-styx-backend',
    database,
    timestamp: new Date().toISOString(),
  });
});

router.use('/auth', authRoutes);
router.use('/categories', categoryRoutes);
router.use('/products', productRoutes);
router.use('/cart', cartRoutes);
router.use('/addresses', addressRoutes);
router.use('/orders', orderRoutes);
router.use('/customers', customerRoutes);
router.use('/search', searchRoutes);
router.use('/stores', storeRoutes);
router.use('/uploads', uploadRoutes);
router.use('/crm', crmRoutes);
router.use('/stats', statsRoutes);
router.use('/users', userRoutes);
router.use('/audit', auditRoutes);
router.use('/wishlist', wishlistRoutes);
router.use('/coupons', couponRoutes);
router.use('/variants', variantRoutes);
router.use('/quotations', quotationRoutes);
router.use('/purchasing', purchasingRoutes);
router.use('/returns', returnRoutes);
router.use('/notifications', notificationRoutes);
router.use('/reports', reportRoutes);
router.use('/settings', settingsRoutes);
router.use('/bundles', bundleRoutes);

export default router;
