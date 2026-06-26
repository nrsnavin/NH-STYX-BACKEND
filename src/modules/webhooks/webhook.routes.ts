import { Router, Request, Response } from 'express';
import { logger } from '../../config/logger';
import { handleRazorpayEvent, verifyRazorpaySignature } from './webhook.service';

const router = Router();

/**
 * Razorpay webhook receiver. Mounted with `express.raw` (see app.ts) so the
 * body is the raw Buffer needed for HMAC verification. We acknowledge with 2xx
 * as soon as the event is accepted; processing errors are logged and reconciled
 * separately rather than 500'd (which would make Razorpay retry indefinitely).
 */
router.post('/razorpay', async (req: Request, res: Response) => {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const signature = req.header('x-razorpay-signature');

  if (!verifyRazorpaySignature(raw, signature)) {
    res.status(400).json({ success: false, message: 'Invalid signature' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ success: false, message: 'Invalid JSON body' });
    return;
  }

  try {
    await handleRazorpayEvent(parsed as Parameters<typeof handleRazorpayEvent>[0]);
  } catch (err) {
    logger.error({ err }, 'razorpay webhook processing failed');
  }
  res.json({ success: true });
});

export default router;
