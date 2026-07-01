import { z } from 'zod';

const line = z.string().max(300).optional();

export const updateSettingsSchema = z.object({
  body: z.object({
    businessName: z.string().max(120).optional(),
    gstin: z.string().max(20).optional(),
    addressLine: line,
    city: z.string().max(80).optional(),
    state: z.string().max(80).optional(),
    stateCode: z.string().max(2).optional(),
    pincode: z.string().max(10).optional(),
    supportPhone: z.string().max(20).optional(),
    supportEmail: z.string().max(120).optional(),
    invoiceFooter: z.string().max(500).optional(),
    invoiceTerms: z.string().max(1000).optional(),
    bankName: z.string().max(120).optional(),
    bankAccount: z.string().max(40).optional(),
    bankIfsc: z.string().max(20).optional(),
    bankUpi: z.string().max(60).optional(),
  }),
});
