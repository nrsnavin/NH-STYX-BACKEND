import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { updateSettingsSchema } from './settings.validation';
import * as settingsController from './settings.controller';

const router = Router();

// Any staff can read settings; only admins can change them.
router.get('/', authenticate, authorize('ADMIN', 'AGENT'), settingsController.get);
router.put('/', authenticate, authorize('ADMIN'), validate(updateSettingsSchema), settingsController.update);

export default router;
