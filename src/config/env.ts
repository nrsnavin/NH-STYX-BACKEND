import 'dotenv/config';
import { z } from 'zod';

/**
 * Validate and expose environment variables in a single typed object.
 * The app refuses to boot if required variables are missing/invalid.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // GST: your (seller) state. Decides CGST+SGST (intra-state) vs IGST (inter-state).
  SELLER_STATE_CODE: z.string().default('27'), // 27 = Maharashtra
  SELLER_STATE_NAME: z.string().default('Maharashtra'),

  // Delivery fee applied at checkout (integer paise). 0 = free.
  DELIVERY_FEE_PAISE: z.coerce.number().int().nonnegative().default(0),

  // Razorpay (optional — gateway calls are stubbed when unset).
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  // Webhook signing secret (Razorpay dashboard → Webhooks). When unset the
  // webhook accepts unsigned posts so local testing works.
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Image storage. When AWS_S3_BUCKET is set, uploads go to S3 and the API
  // returns an absolute (bucket or CDN) URL; otherwise images are written to
  // local disk and served from /uploads. Credentials come from the standard
  // AWS chain (env vars or the instance IAM role) — no need to hardcode them.
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_S3_BUCKET: z.string().optional(),
  // Optional CDN/base to serve objects from (e.g. a CloudFront domain). When
  // unset, the bucket's regional S3 URL is used.
  S3_PUBLIC_BASE_URL: z.string().optional(),

  // Shipping partner tracking (optional). When SHIPPING_API_URL is set, the
  // order tracking endpoint fetches live checkpoints from the courier for a
  // shipped order (GET {url}?awb=<awb>, optional bearer token); otherwise it
  // returns the order's own lifecycle timeline.
  SHIPPING_API_URL: z.string().optional(),
  SHIPPING_API_TOKEN: z.string().optional(),

  // Courier booking (optional). When COURIER_API_URL is set, staff can auto-book
  // a shipment (POST order + consignee → AWB / label); otherwise they enter the
  // AWB manually. COURIER_NAME labels the shipment when the API omits it.
  COURIER_API_URL: z.string().optional(),
  COURIER_API_TOKEN: z.string().optional(),
  COURIER_NAME: z.string().default('Delhivery'),

  // Anthropic (optional — AI search falls back to keyword search when unset).
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_SEARCH_MODEL: z.string().default('claude-opus-4-8'),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration. See errors above.');
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
