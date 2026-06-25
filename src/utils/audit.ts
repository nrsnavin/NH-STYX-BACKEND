import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../config/logger';

interface AuditInput {
  actorType: 'STAFF' | 'CUSTOMER' | 'SYSTEM';
  actorId?: string | null;
  action: string; // e.g. customer.approve, order.status, product.delete
  entity: string; // Customer | Order | Product | Category | Store | Payment
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Best-effort audit-trail write. Never throws — auditing must not break the
 * action it records. Fire-and-forget (no await needed) from controllers.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, action: input.action }, 'audit log write failed');
  }
}
