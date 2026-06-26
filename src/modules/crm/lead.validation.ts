import { z } from 'zod';
import { ActivityType, LeadStage } from '@prisma/client';

const phone = z.string().min(6).max(15);

export const listLeadsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().optional(),
    stage: z.nativeEnum(LeadStage).optional(),
    assignedToId: z.string().uuid().optional(),
    due: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),
});

export const leadIdSchema = z.object({ params: z.object({ id: z.string().uuid() }) });

export const createLeadSchema = z.object({
  body: z.object({
    shopName: z.string().min(2),
    contactName: z.string().optional(),
    phone,
    email: z.string().email().optional(),
    city: z.string().optional(),
    estValuePaise: z.number().int().nonnegative().optional(),
    nextFollowUpAt: z.string().datetime().nullable().optional(),
    storeId: z.string().uuid().nullable().optional(),
    assignedToId: z.string().uuid().nullable().optional(),
  }),
});

export const updateLeadSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    shopName: z.string().min(2).optional(),
    contactName: z.string().nullable().optional(),
    phone: phone.optional(),
    email: z.string().email().nullable().optional(),
    city: z.string().nullable().optional(),
    estValuePaise: z.number().int().nonnegative().optional(),
    stage: z.nativeEnum(LeadStage).optional(),
    lostReason: z.string().nullable().optional(),
    assignedToId: z.string().uuid().nullable().optional(),
    nextFollowUpAt: z.string().datetime().nullable().optional(),
  }),
});

export const listActivitiesSchema = z.object({
  query: z
    .object({
      leadId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
    })
    .refine((q) => q.leadId || q.customerId, { message: 'leadId or customerId is required' }),
});

export const addActivitySchema = z.object({
  body: z
    .object({
      type: z.nativeEnum(ActivityType).default(ActivityType.NOTE),
      body: z.string().min(1).max(2000),
      leadId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
      followUpAt: z.string().datetime().nullable().optional(),
    })
    .refine((b) => b.leadId || b.customerId, { message: 'leadId or customerId is required' }),
});
