import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';

/** Where uploaded images live on disk (served statically at /uploads) when S3
 *  is not configured. */
export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Production image hosting goes to S3 when a bucket is configured. */
export const s3Enabled = Boolean(env.AWS_S3_BUCKET);

const s3 = s3Enabled ? new S3Client({ region: env.AWS_REGION }) : null;

// Map the (already-validated) image mimetype to a safe extension. The client's
// original filename is never trusted for the on-disk name, so it can't smuggle
// a foreign extension (e.g. .php/.html) or path segments onto the server.
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function generatedName(mimetype: string): string {
  const ext = EXT_BY_MIME[mimetype] ?? '.img';
  return `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
}

// S3 → buffer the file in memory so we can PutObject; disk → write it straight
// to UPLOAD_DIR with a generated name derived from the validated mimetype.
const storage = s3Enabled
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
      filename: (_req, file, cb) => cb(null, generatedName(file.mimetype)),
    });

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPG, WEBP or GIF images are allowed'));
  },
});

/**
 * Persists an uploaded file and returns the URL to store on the product.
 * - S3: uploads the buffer and returns an ABSOLUTE url (the CloudFront/base
 *   domain when configured, otherwise the bucket's regional S3 URL).
 * - Disk: the file is already written; returns a RELATIVE `/uploads/<name>`
 *   path that each client resolves against its own API host.
 */
export async function persistUpload(file: Express.Multer.File): Promise<string> {
  if (s3Enabled && s3) {
    const key = `products/${generatedName(file.mimetype)}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: env.AWS_S3_BUCKET!,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    const base =
      env.S3_PUBLIC_BASE_URL?.replace(/\/$/, '') ??
      `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com`;
    return `${base}/${key}`;
  }
  // Disk: multer already wrote the file under UPLOAD_DIR with a generated name.
  return `/uploads/${file.filename}`;
}
