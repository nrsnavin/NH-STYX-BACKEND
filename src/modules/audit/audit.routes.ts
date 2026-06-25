import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// Audit trail — admin only.
router.get(
  '/',
  authenticate,
  authorize('ADMIN'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const where: Prisma.AuditLogWhereInput = {
      ...(req.query.entity ? { entity: String(req.query.entity) } : {}),
      ...(req.query.action ? { action: { contains: String(req.query.action) } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Resolve staff actor names for display.
    const staffIds = [
      ...new Set(items.filter((i) => i.actorType === 'STAFF' && i.actorId).map((i) => i.actorId!)),
    ];
    const users = staffIds.length
      ? await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    res.json({
      success: true,
      items: items.map((i) => ({
        ...i,
        actorName: i.actorId ? (nameById.get(i.actorId) ?? null) : null,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }),
);

export default router;
