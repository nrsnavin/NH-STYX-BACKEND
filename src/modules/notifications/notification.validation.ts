import { z } from 'zod';
import { CustomerStatus } from '@prisma/client';

export const broadcastSchema = z.object({
  body: z.object({
    title: z.string().min(2).max(120),
    body: z.string().min(2).max(500),
    status: z.nativeEnum(CustomerStatus).optional(),
    storeId: z.string().uuid().optional(),
  }),
});
