import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { runWithTenant } from '../lib/tenantContext';

/**
 * Best-effort tenant binding for the whole request. If the caller presents a
 * valid CUSTOMER access token, their id is bound to the async context so the
 * Prisma layer applies row-level security for the rest of the request.
 *
 * It never rejects: a missing/invalid/staff token simply leaves the context
 * empty (the trusted, full-access path). Real authorization is still enforced
 * by `authenticate`/`requireCustomer`/`authorize` on each route.
 */
export function tenantContext(req: Request, _res: Response, next: NextFunction): void {
  let customerId: string | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(header.slice('Bearer '.length).trim());
      if (payload.type === 'CUSTOMER') customerId = payload.sub;
    } catch {
      // Invalid token — leave context empty; the route guards will 401 later.
    }
  }
  runWithTenant({ customerId }, () => next());
}
