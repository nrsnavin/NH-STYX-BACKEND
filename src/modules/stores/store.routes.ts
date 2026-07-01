import { Router } from 'express';
import multer from 'multer';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  addServiceAreaSchema,
  adjustStockSchema,
  agentUserIdSchema,
  areaIdSchema,
  assignAgentSchema,
  createStoreSchema,
  listInventorySchema,
  listMovementsSchema,
  listStoresSchema,
  stockTakeSchema,
  storeIdSchema,
  storeProductIdSchema,
  transferStockSchema,
  updateStoreSchema,
  upsertStoreProductSchema,
} from './store.validation';
import * as storeController from './store.controller';

const router = Router();
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

// Public — serviceable cities for the registration screen (no auth).
router.get('/cities', storeController.cities);

// Agents may read (their own store) and manage their inventory; everything
// structural (store CRUD, areas, agent assignment) is admin-only.

// Staff list of agents — used by admin to assign them to stores.
router.get('/agents', authenticate, authorize('ADMIN'), storeController.agents);

router.get('/', authenticate, authorize('ADMIN', 'AGENT'), validate(listStoresSchema), storeController.list);
router.post('/', authenticate, authorize('ADMIN'), validate(createStoreSchema), storeController.create);
router.get('/:id', authenticate, authorize('ADMIN', 'AGENT'), validate(storeIdSchema), storeController.getOne);
router.patch('/:id', authenticate, authorize('ADMIN'), validate(updateStoreSchema), storeController.update);

// Service areas (city routing)
router.post('/:id/areas', authenticate, authorize('ADMIN'), validate(addServiceAreaSchema), storeController.addArea);
router.delete('/areas/:areaId', authenticate, authorize('ADMIN'), validate(areaIdSchema), storeController.removeArea);

// Inventory (per-store price + stock) — admin or the store's own agent
router.get('/:id/inventory', authenticate, authorize('ADMIN', 'AGENT'), validate(listInventorySchema), storeController.inventory);
// Stock movement ledger (audit / traceability).
router.get('/:id/movements', authenticate, authorize('ADMIN', 'AGENT'), validate(listMovementsSchema), storeController.movements);
router.post(
  '/:id/inventory/import',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(storeIdSchema),
  csvUpload.single('file'),
  storeController.importInventory,
);
// Stock adjustment (single product) + bulk stock-take (physical count).
router.post(
  '/:id/inventory/:productId/adjust',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(adjustStockSchema),
  storeController.adjustStock,
);
router.post(
  '/:id/stock-take',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(stockTakeSchema),
  storeController.stockTake,
);
// Inter-store transfer (admin coordinates across stores).
router.post(
  '/:id/transfer',
  authenticate,
  authorize('ADMIN'),
  validate(transferStockSchema),
  storeController.transfer,
);
router.put(
  '/:id/inventory/:productId',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(upsertStoreProductSchema),
  storeController.upsertProduct,
);
router.delete(
  '/:id/inventory/:productId',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(storeProductIdSchema),
  storeController.removeProduct,
);

// Agent assignment (admin only)
router.post('/:id/agents', authenticate, authorize('ADMIN'), validate(assignAgentSchema), storeController.assignAgent);
router.delete('/agents/:userId', authenticate, authorize('ADMIN'), validate(agentUserIdSchema), storeController.unassignAgent);

export default router;
