import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request tenant context. When a customer is signed in, their id is stored
 * here for the lifetime of the request so the Prisma layer (see lib/prisma.ts)
 * can set the `app.customer_id` Postgres GUC that drives row-level security.
 *
 * When no customer id is present (staff, system jobs, migrations, login/
 * register) RLS is effectively bypassed — the policies treat a NULL/empty GUC
 * as "full access", so nothing breaks for trusted, app-authorized callers.
 */
interface TenantContext {
  customerId?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Runs `fn` with the given tenant context bound to the async call tree. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Runs `fn` with the tenant context cleared, i.e. with full (privileged)
 * database access even inside a customer request. Use ONLY for legitimately
 * cross-tenant reads — e.g. store-wide "best selling" analytics — never to
 * sidestep a customer's own-data boundary.
 */
export function runWithoutTenant<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** The current request's tenant context, if any. */
export function getTenant(): TenantContext | undefined {
  return storage.getStore();
}

/** The signed-in customer id for the current request, or null. */
export function currentCustomerId(): string | null {
  return storage.getStore()?.customerId ?? null;
}
