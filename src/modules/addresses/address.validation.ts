import { z } from 'zod';

export const createAddressSchema = z.object({
  body: z.object({
    label: z.string().optional(),
    line1: z.string().min(3),
    line2: z.string().optional(),
    city: z.string().min(2),
    state: z.string().min(2),
    stateCode: z.string().regex(/^\d{2}$/, 'GST state code is 2 digits').optional(),
    pincode: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits'),
    isDefault: z.boolean().optional(),
  }),
});

export const updateAddressSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: createAddressSchema.shape.body.partial(),
});

export const addressIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});
