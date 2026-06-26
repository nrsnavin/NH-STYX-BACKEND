import { Router } from 'express';
import { authenticate, authorize, requireCustomer } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  convertQuotationSchema,
  createQuotationSchema,
  listQuotationsSchema,
  quotationIdSchema,
  respondQuotationSchema,
  setQuotationStatusSchema,
  updateQuotationSchema,
} from './quotation.validation';
import * as quotation from './quotation.controller';

const router = Router();
const staff = [authenticate, authorize('ADMIN', 'AGENT')] as const;
const customer = [authenticate, requireCustomer] as const;

// Staff: list + create.
router.get('/', ...staff, validate(listQuotationsSchema), quotation.list);
router.post('/', ...staff, validate(createQuotationSchema), quotation.create);

// Customer self-service. Registered before '/:id' so 'mine' isn't read as an id.
router.get('/mine', ...customer, quotation.listMine);
router.get('/mine/:id', ...customer, validate(quotationIdSchema), quotation.getMine);
router.post('/mine/:id/respond', ...customer, validate(respondQuotationSchema), quotation.respond);

// PDF — staff (store-scoped) or the owning customer.
router.get('/:id/pdf', authenticate, validate(quotationIdSchema), quotation.pdf);

// Staff: detail + edit + lifecycle.
router.get('/:id', ...staff, validate(quotationIdSchema), quotation.getOne);
router.patch('/:id', ...staff, validate(updateQuotationSchema), quotation.update);
router.post('/:id/status', ...staff, validate(setQuotationStatusSchema), quotation.setStatus);
router.post('/:id/convert', ...staff, validate(convertQuotationSchema), quotation.convert);

export default router;
