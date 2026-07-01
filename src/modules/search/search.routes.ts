import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { aiSearchSchema, globalSearchSchema } from './search.validation';
import * as searchController from './search.controller';

const router = Router();

// Natural-language product search (any authenticated user).
router.post('/ai', authenticate, validate(aiSearchSchema), searchController.ai);

// Ops console quick search across entities (staff only).
router.get(
  '/global',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  validate(globalSearchSchema),
  searchController.global,
);

export default router;
