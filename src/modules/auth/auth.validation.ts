import { z } from 'zod';

const phone = z
  .string()
  .regex(/^\d{10}$/, 'Phone must be a 10-digit number (without +91)');

export const staffLoginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1, 'Password is required'),
  }),
});

export const customerRegisterSchema = z.object({
  body: z.object({
    shopName: z.string().min(2),
    ownerName: z.string().min(2).optional(),
    phone,
    password: z.string().min(8, 'Password must be at least 8 characters'),
    email: z.string().email().optional(),
    // City decides which store serves this shop (catalog, pricing, fulfilment).
    city: z.string().min(2, 'City is required'),
    gstin: z
      .string()
      .length(15, 'GSTIN must be 15 characters')
      .optional(),
  }),
});

export const customerLoginSchema = z.object({
  body: z.object({
    phone,
    password: z.string().min(1, 'Password is required'),
  }),
});

// A shop owner editing their own profile (GST details screen, etc). Phone is
// their identity and city/store routing is approval-gated, so neither is
// editable here. Empty strings clear the optional fields.
export const customerUpdateSelfSchema = z.object({
  body: z.object({
    shopName: z.string().min(2).optional(),
    ownerName: z.string().min(2).or(z.literal('')).optional(),
    email: z.string().email().or(z.literal('')).optional(),
    gstin: z.string().length(15, 'GSTIN must be 15 characters').or(z.literal('')).optional(),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(10),
  }),
});
