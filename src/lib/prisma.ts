import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config/env';

/**
 * Single shared Prisma client. In development we cache it on `globalThis`
 * so hot-reloads (tsx watch) don't exhaust the connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction ? ['error'] : ['query', 'warn', 'error'],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
