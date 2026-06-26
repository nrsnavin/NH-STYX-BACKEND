import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createPurchaseOrderSchema,
  createSupplierSchema,
  listPurchaseOrdersSchema,
  listSuppliersSchema,
  lowStockSchema,
  purchaseOrderIdSchema,
  receivePurchaseOrderSchema,
  setPurchaseOrderStatusSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
} from './purchasing.validation';
import * as purchasing from './purchasing.controller';

const router = Router();
const staff = [authenticate, authorize('ADMIN', 'AGENT')] as const;

// Replenishment work list.
router.get('/low-stock', ...staff, validate(lowStockSchema), purchasing.lowStock);

// Suppliers.
router.get('/suppliers', ...staff, validate(listSuppliersSchema), purchasing.listSuppliers);
router.post('/suppliers', ...staff, validate(createSupplierSchema), purchasing.createSupplier);
router.patch('/suppliers/:id', ...staff, validate(updateSupplierSchema), purchasing.updateSupplier);

// Purchase orders.
router.get('/orders', ...staff, validate(listPurchaseOrdersSchema), purchasing.listPurchaseOrders);
router.post('/orders', ...staff, validate(createPurchaseOrderSchema), purchasing.createPurchaseOrder);
router.get('/orders/:id', ...staff, validate(purchaseOrderIdSchema), purchasing.getPurchaseOrder);
router.patch('/orders/:id', ...staff, validate(updatePurchaseOrderSchema), purchasing.updatePurchaseOrder);
router.post('/orders/:id/status', ...staff, validate(setPurchaseOrderStatusSchema), purchasing.setPurchaseOrderStatus);
router.post('/orders/:id/receive', ...staff, validate(receivePurchaseOrderSchema), purchasing.receivePurchaseOrder);

export default router;
