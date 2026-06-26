import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  addActivitySchema,
  createLeadSchema,
  leadIdSchema,
  listActivitiesSchema,
  listLeadsSchema,
  listVisitsSchema,
  updateLeadSchema,
} from './lead.validation';
import * as crm from './lead.controller';

const router = Router();
const staff = [authenticate, authorize('ADMIN', 'AGENT')] as const;

// Leads pipeline.
router.get('/leads', ...staff, validate(listLeadsSchema), crm.list);
router.get('/analytics/sources', ...staff, crm.sourceAnalytics);
router.post('/leads', ...staff, validate(createLeadSchema), crm.create);
router.get('/leads/:id', ...staff, validate(leadIdSchema), crm.getOne);
router.patch('/leads/:id', ...staff, validate(updateLeadSchema), crm.update);
router.post('/leads/:id/convert', ...staff, validate(leadIdSchema), crm.convert);

// Activities (notes / calls / visits) on a lead or customer.
router.get('/activities', ...staff, validate(listActivitiesSchema), crm.listActivities);
router.post('/activities', ...staff, validate(addActivitySchema), crm.addActivity);

// Field-visit log (GPS check-ins).
router.get('/visits', ...staff, validate(listVisitsSchema), crm.listVisits);

export default router;
