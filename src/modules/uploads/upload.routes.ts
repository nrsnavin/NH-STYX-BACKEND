import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';

/** Where uploaded images live on disk (served statically at /uploads). */
export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPG, WEBP or GIF images are allowed'));
  },
});

const router = Router();

// Staff upload a product image. Returns a RELATIVE path (`/uploads/<file>`) so
// every client — web console, Android emulator, a phone — resolves it against
// its OWN configured API host. (An absolute URL baked with the uploader's host,
// e.g. http://localhost:4000, is unreachable from other devices.)
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'AGENT'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No image uploaded (field name must be "file")');
    res.status(201).json({ success: true, data: { url: `/uploads/${req.file.filename}` } });
  }),
);

export default router;
