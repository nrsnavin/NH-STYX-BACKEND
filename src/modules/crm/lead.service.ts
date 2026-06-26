import { ActivityType, LeadSource, LeadStage, Prisma } from '@prisma/client';
import { prisma, tenantTransaction } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';

const leadInclude = {
  store: { select: { id: true, name: true, city: true } },
  assignedTo: { select: { id: true, name: true } },
  customer: { select: { id: true, status: true } },
  _count: { select: { activities: true } },
} satisfies Prisma.LeadInclude;

// ---- Leads ------------------------------------------------------------------

export async function listLeads(params: {
  page: number;
  limit: number;
  search?: string;
  stage?: LeadStage;
  assignedToId?: string;
  due?: boolean;
  storeId?: string | null; // agent scope; null = admin (all)
}) {
  const { page, limit, search, stage, assignedToId, due, storeId } = params;
  const where: Prisma.LeadWhereInput = {
    ...(storeId ? { storeId } : {}),
    ...(stage ? { stage } : {}),
    ...(assignedToId ? { assignedToId } : {}),
    ...(due ? { nextFollowUpAt: { lte: new Date(), not: null } } : {}),
    ...(search
      ? {
          OR: [
            { shopName: { contains: search, mode: Prisma.QueryMode.insensitive } },
            { contactName: { contains: search, mode: Prisma.QueryMode.insensitive } },
            { phone: { contains: search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      include: leadInclude,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.lead.count({ where }),
  ]);
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

/** Lead counts per stage (for the pipeline header), respecting store scope. */
export async function leadStageCounts(storeId?: string | null) {
  const rows = await prisma.lead.groupBy({
    by: ['stage'],
    where: storeId ? { storeId } : {},
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.stage] = r._count._all;
  return counts;
}

/** Per-source funnel: total leads, won, and win rate — "which sources convert". */
export async function sourceAnalytics(storeId?: string | null) {
  const scope: Prisma.LeadWhereInput = storeId ? { storeId } : {};
  const [totals, won] = await Promise.all([
    prisma.lead.groupBy({ by: ['source'], where: scope, _count: { _all: true } }),
    prisma.lead.groupBy({
      by: ['source'],
      where: { ...scope, stage: LeadStage.WON },
      _count: { _all: true },
    }),
  ]);
  const wonBySource = new Map(won.map((w) => [w.source, w._count._all]));
  return totals
    .map((t) => {
      const total = t._count._all;
      const wonCount = wonBySource.get(t.source) ?? 0;
      return {
        source: t.source,
        total,
        won: wonCount,
        conversionRate: total ? Math.round((wonCount / total) * 100) : 0,
      };
    })
    .sort((a, b) => b.total - a.total);
}

export async function getLead(id: string) {
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      ...leadInclude,
      activities: {
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!lead) throw ApiError.notFound('Lead not found');
  return lead;
}

interface LeadInput {
  shopName: string;
  contactName?: string;
  phone: string;
  email?: string;
  city?: string;
  estValuePaise?: number;
  nextFollowUpAt?: string | null;
  storeId?: string | null;
  assignedToId?: string | null;
}

export async function createLead(input: LeadInput, createdBy: { id: string; storeId: string | null }) {
  // Agents own their leads in their store; admins may target any store/agent.
  const storeId = createdBy.storeId ?? input.storeId ?? null;
  const assignedToId = createdBy.storeId ? createdBy.id : input.assignedToId ?? null;

  return prisma.lead.create({
    data: {
      shopName: input.shopName,
      contactName: input.contactName,
      phone: input.phone,
      email: input.email,
      city: input.city,
      estValuePaise: input.estValuePaise ?? 0,
      nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
      source: LeadSource.MANUAL,
      storeId,
      assignedToId,
    },
    include: leadInclude,
  });
}

export async function updateLead(
  id: string,
  input: Partial<LeadInput> & { stage?: LeadStage; lostReason?: string | null },
) {
  await prisma.lead.findUniqueOrThrow({ where: { id } }).catch(() => {
    throw ApiError.notFound('Lead not found');
  });
  return prisma.lead.update({
    where: { id },
    data: {
      shopName: input.shopName,
      contactName: input.contactName,
      phone: input.phone,
      email: input.email,
      city: input.city,
      estValuePaise: input.estValuePaise,
      stage: input.stage,
      lostReason: input.lostReason,
      assignedToId: input.assignedToId,
      nextFollowUpAt:
        input.nextFollowUpAt === undefined
          ? undefined
          : input.nextFollowUpAt
            ? new Date(input.nextFollowUpAt)
            : null,
    },
    include: leadInclude,
  });
}

/**
 * Convert a prospect to a shop account: create a PENDING customer from the
 * lead's details (so it enters the normal approval flow), link it, mark WON.
 * Leads that are already linked to a customer (sign-ups) just move to WON.
 */
export async function convertLead(id: string) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) throw ApiError.notFound('Lead not found');
  if (lead.customerId) {
    return prisma.lead.update({ where: { id }, data: { stage: LeadStage.WON }, include: leadInclude });
  }

  const existing = await prisma.customer.findUnique({ where: { phone: lead.phone } });
  if (existing) {
    throw ApiError.conflict('A customer with this phone already exists');
  }

  return tenantTransaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        shopName: lead.shopName,
        ownerName: lead.contactName,
        phone: lead.phone,
        email: lead.email,
        status: 'PENDING',
        storeId: lead.storeId,
        cart: { create: {} },
      },
    });
    return tx.lead.update({
      where: { id },
      data: { stage: LeadStage.WON, customerId: customer.id },
      include: leadInclude,
    });
  });
}

/** Create a pipeline lead from a shop sign-up (called on registration). */
export async function createSignupLead(input: {
  customerId: string;
  shopName: string;
  phone: string;
  contactName?: string | null;
  city?: string | null;
  storeId?: string | null;
}) {
  await prisma.lead.create({
    data: {
      shopName: input.shopName,
      phone: input.phone,
      contactName: input.contactName,
      city: input.city,
      source: LeadSource.SIGNUP,
      stage: LeadStage.NEW,
      storeId: input.storeId,
      customerId: input.customerId,
    },
  });
}

// ---- Activities (notes / calls / visits on a lead or customer) --------------

export async function listActivities(params: { leadId?: string; customerId?: string }) {
  if (!params.leadId && !params.customerId) {
    throw ApiError.badRequest('leadId or customerId is required');
  }
  return prisma.activity.findMany({
    where: { leadId: params.leadId, customerId: params.customerId },
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function addActivity(
  input: { type: ActivityType; body: string; leadId?: string; customerId?: string; followUpAt?: string | null },
  createdById: string,
) {
  if (!input.leadId && !input.customerId) {
    throw ApiError.badRequest('leadId or customerId is required');
  }
  const followUpAt = input.followUpAt ? new Date(input.followUpAt) : null;

  const activity = await prisma.activity.create({
    data: {
      type: input.type,
      body: input.body,
      followUpAt,
      leadId: input.leadId,
      customerId: input.customerId,
      createdById,
    },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  // Logging a follow-up date on a lead updates the lead's next-follow-up.
  if (input.leadId && followUpAt) {
    await prisma.lead.update({ where: { id: input.leadId }, data: { nextFollowUpAt: followUpAt } });
  }
  return activity;
}
