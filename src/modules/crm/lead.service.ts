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

const OPEN_STAGES: LeadStage[] = [LeadStage.NEW, LeadStage.CONTACTED, LeadStage.QUALIFIED];

/**
 * Pipeline-oriented analytics for the CRM dashboard: value by stage, an agent
 * leaderboard, monthly new-vs-won conversion, and a follow-up ageing breakdown.
 * Everything respects the agent's store scope (null = admin, all stores).
 */
export async function crmDashboard(storeId: string | null) {
  const scope: Prisma.LeadWhereInput = storeId ? { storeId } : {};
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const weekAhead = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [stageRows, totalsByAgent, wonByAgent, recent, openFollowups] = await Promise.all([
    prisma.lead.groupBy({ by: ['stage'], where: scope, _count: { _all: true }, _sum: { estValuePaise: true } }),
    prisma.lead.groupBy({
      by: ['assignedToId'],
      where: { ...scope, assignedToId: { not: null } },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ['assignedToId'],
      where: { ...scope, assignedToId: { not: null }, stage: LeadStage.WON },
      _count: { _all: true },
      _sum: { estValuePaise: true },
    }),
    prisma.lead.findMany({
      where: { ...scope, createdAt: { gte: sixMonthsAgo } },
      select: { createdAt: true, stage: true },
    }),
    prisma.lead.findMany({
      where: { ...scope, stage: { in: OPEN_STAGES } },
      select: { nextFollowUpAt: true },
    }),
  ]);

  // Pipeline value by stage (every stage present, even at zero).
  const stageMap = new Map(stageRows.map((r) => [r.stage, r]));
  const pipeline = (['NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST'] as LeadStage[]).map((stage) => ({
    stage,
    count: stageMap.get(stage)?._count._all ?? 0,
    valuePaise: stageMap.get(stage)?._sum.estValuePaise ?? 0,
  }));

  // Agent leaderboard (name resolved from User).
  const wonMap = new Map(wonByAgent.map((w) => [w.assignedToId, w]));
  const agentIds = totalsByAgent.map((t) => t.assignedToId!).filter(Boolean);
  const users = await prisma.user.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const leaderboard = totalsByAgent
    .map((t) => ({
      agentId: t.assignedToId!,
      name: nameById.get(t.assignedToId!) ?? 'Unknown',
      total: t._count._all,
      won: wonMap.get(t.assignedToId!)?._count._all ?? 0,
      wonValuePaise: wonMap.get(t.assignedToId!)?._sum.estValuePaise ?? 0,
    }))
    .sort((a, b) => b.won - a.won || b.total - a.total);

  // Monthly new-vs-won (cohort: of leads created in a month, how many are WON).
  const months: { month: string; created: number; won: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, created: 0, won: 0 });
  }
  const monthIndex = new Map(months.map((m, i) => [m.month, i]));
  for (const l of recent) {
    const key = `${l.createdAt.getFullYear()}-${String(l.createdAt.getMonth() + 1).padStart(2, '0')}`;
    const idx = monthIndex.get(key);
    if (idx === undefined) continue;
    months[idx].created += 1;
    if (l.stage === LeadStage.WON) months[idx].won += 1;
  }

  // Follow-up ageing for the open pipeline.
  const aging = { overdue: 0, today: 0, upcoming: 0, later: 0, none: 0 };
  for (const l of openFollowups) {
    const f = l.nextFollowUpAt;
    if (!f) aging.none += 1;
    else if (f < startOfToday) aging.overdue += 1;
    else if (f < endOfToday) aging.today += 1;
    else if (f < weekAhead) aging.upcoming += 1;
    else aging.later += 1;
  }

  return { pipeline, leaderboard, conversion: months, aging };
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
  input: {
    type: ActivityType;
    body: string;
    leadId?: string;
    customerId?: string;
    followUpAt?: string | null;
    latitude?: number;
    longitude?: number;
  },
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
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
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

/**
 * Recent field visits (VISIT activities) with a GPS check-in, for the beat /
 * field-visit log. Scoped to the agent's store via the linked lead/customer.
 */
export async function listVisits(storeId: string | null, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where: Prisma.ActivityWhereInput = {
    type: ActivityType.VISIT,
    createdAt: { gte: since },
    ...(storeId ? { OR: [{ lead: { storeId } }, { customer: { storeId } }] } : {}),
  };
  return prisma.activity.findMany({
    where,
    include: {
      createdBy: { select: { id: true, name: true } },
      lead: { select: { id: true, shopName: true, city: true } },
      customer: { select: { id: true, shopName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
