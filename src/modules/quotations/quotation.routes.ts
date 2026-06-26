import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  convertQuotationSchema,
  createQuotationSchema,
  listQuotationsSchema,
  quotationIdSchema,
  setQuotationStatusSchema,
  updateQuotationSchema,
} from './quotation.validation';
import * as quotation from './quotation.controller';

const router = Router();
const staff = [authenticate, authorize('ADMIN', 'AGENT')] as const;

router.get('/', ...staff, validate(listQuotationsSchema), quotation.list);
router.post('/', ...staff, validate(createQuotationSchema), quotation.create);
router.get('/:id', ...staff, validate(quotationIdSchema), quotation.getOne);
router.patch('/:id', ...staff, validate(updateQuotationSchema), quotation.update);
router.post('/:id/status', ...staff, validate(setQuotationStatusSchema), quotation.setStatus);
router.post('/:id/convert', ...staff, validate(convertQuotationSchema), quotation.convert);

export default router;
