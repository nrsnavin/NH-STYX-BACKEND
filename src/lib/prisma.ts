import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config/env';
import { currentCustomerId } from './tenantContext';

/**
 * Single shared Prisma client. In development we cache it on `globalThis`
 * so hot-reloads (tsx watch) don't exhaust the connection pool.
 *
 * The exported `prisma` is extended to enforce per-customer row-level security:
 * when a customer is signed in (see lib/tenantContext), every operation runs
 * inside a one-shot transaction that first sets the `app.customer_id` Postgres
 * GUC, so the RLS policies (migration `enable_rls`) restrict rows to that
 * customer. With no customer context the GUC stays empty and policies grant
 * full access — the trusted path for staff, system jobs and migrations.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Unextended client — used for migrations-style raw access and transactions. */
export const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction ? ['error'] : ['warn', 'error'],
  });

if (!isProduction) {
  globalForPrisma.prisma = basePrisma;
}

const SET_TENANT = `SELECT set_config('app.customer_id', $1, true)`;

export const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ operation, args, query }) {
      const customerId = currentCustomerId();
      // Raw ops (incl. our own set_config) must not be wrapped — that would
      // recurse. No customer context -> run normally (full-access path).
      if (!customerId || operation.includes('Raw')) {
        return query(args);
      }
      // Set the tenant GUC and run the operation in the SAME transaction so
      // RLS sees the customer id. `true` scopes the setting to this tx.
      const [, result] = await basePrisma.$transaction([
        basePrisma.$executeRawUnsafe(SET_TENANT, customerId),
        query(args),
      ]);
      return result;
    },
  },
});

/**
 * Runs an interactive transaction with the current customer's RLS context
 * applied. Use this instead of `prisma.$transaction` for any multi-step write
 * so the tenant GUC is set for every statement in the transaction. With no
 * customer context it behaves like a plain transaction (full access).
 */
export function tenantTransaction<T>(
  fn: (tx: Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0]) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  const customerId = currentCustomerId();
  return basePrisma.$transaction(async (tx) => {
    if (customerId) {
      await tx.$executeRawUnsafe(SET_TENANT, customerId);
    }
    return fn(tx);
  }, options);
}
