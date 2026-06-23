import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { aiSearchSchema } from './search.validation';
import * as searchController from './search.controller';

const router = Router();

// Natural-language product search (any authenticated user).
router.post('/ai', authenticate, validate(aiSearchSchema), searchController.ai);

export default router;
