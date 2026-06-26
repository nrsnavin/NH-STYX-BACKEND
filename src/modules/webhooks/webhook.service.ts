import crypto from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { settleRazorpayWebhookPayment } from '../orders/order.service';

/**
 * Verifies the Razorpay webhook signature over the RAW request body. Razorpay
 * signs the exact bytes it posted, so the route must hand us the unparsed
 * Buffer (see app.ts — mounted before the JSON body parser).
 */
export function verifyRazorpaySignature(rawBody: Buffer, signature?: string): boolean {
  // No secret configured (dev/scaffold) — accept so local testing works.
  if (!env.RAZORPAY_WEBHOOK_SECRET) return true;
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string } };
  };
}

/** Routes a verified Razorpay webhook event to the right handler. */
export async function handleRazorpayEvent(body: RazorpayWebhookBody): Promise<void> {
  const event = body.event;
  if (event === 'payment.captured' || event === 'order.paid') {
    const payment = body.payload?.payment?.entity;
    if (payment?.order_id && payment?.id) {
      await settleRazorpayWebhookPayment({
        razorpayOrderId: payment.order_id,
        razorpayPaymentId: payment.id,
      });
    } else {
      logger.warn({ event }, 'razorpay webhook: missing payment ids');
    }
    return;
  }
  // payment.failed / refund.* etc. are acknowledged but not yet acted on.
  logger.info({ event }, 'razorpay webhook: no handler for event');
}
