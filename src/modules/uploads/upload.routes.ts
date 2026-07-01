import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { persistUpload, uploadMiddleware, UPLOAD_DIR } from './upload.storage';

// Re-exported so app.ts can serve the local /uploads directory (disk mode).
export { UPLOAD_DIR };

const router = Router();

// Staff upload a product image. The storage adapter writes it to S3 (returning
// an absolute CDN/bucket URL) when a bucket is configured, otherwise to local
// disk (returning a relative /uploads/<file> path that each client resolves
// against its own API host).
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  uploadMiddleware.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No image uploaded (field name must be "file")');
    const url = await persistUpload(req.file);
    res.status(201).json({ success: true, data: { url } });
  }),
);

export default router;
