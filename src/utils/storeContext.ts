import { prisma } from '../lib/prisma';
import { ApiError } from './ApiError';

/** The store that serves a customer, or null if their city isn't covered yet. */
export async function getCustomerStoreId(customerId: string): Promise<string | null> {
  const c = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { storeId: true },
  });
  return c?.storeId ?? null;
}

/** Same, but throws a clear error when the customer has no store assigned. */
export async function requireCustomerStoreId(customerId: string): Promise<string> {
  const storeId = await getCustomerStoreId(customerId);
  if (!storeId) {
    throw ApiError.badRequest(
      'Your shop is not linked to a store yet. Please update your city or contact support.',
    );
  }
  return storeId;
}

/** A staff member's store. ADMIN has null (sees everything); AGENT has one. */
export async function getStaffStoreId(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { storeId: true } });
  return u?.storeId ?? null;
}

/** Normalize a city/area name for routing lookups (lower-case, collapse spaces). */
export function normalizeCity(city: string): string {
  return city.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Find the store serving a given city via its ServiceArea mapping. */
export async function findStoreForCity(city: string): Promise<string | null> {
  if (!city || !city.trim()) return null;
  const area = await prisma.serviceArea.findUnique({
    where: { city: normalizeCity(city) },
    select: { storeId: true },
  });
  return area?.storeId ?? null;
}
