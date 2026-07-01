import { prisma } from '../../lib/prisma';

/**
 * Editable business settings and their defaults. Only these keys are
 * recognised — reads merge stored values over the defaults, and writes are
 * restricted to this set.
 */
export const SETTING_DEFAULTS = {
  businessName: 'NH Styx',
  gstin: '',
  addressLine: '',
  city: '',
  state: '',
  stateCode: '',
  pincode: '',
  supportPhone: '',
  supportEmail: '',
  invoiceFooter: 'Thank you for your business.',
  invoiceTerms: '',
  bankName: '',
  bankAccount: '',
  bankIfsc: '',
  bankUpi: '',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type BusinessSettings = Record<SettingKey, string>;

const KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

export async function getSettings(): Promise<BusinessSettings> {
  const rows = await prisma.setting.findMany({ where: { key: { in: KEYS } } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as BusinessSettings;
  for (const k of KEYS) {
    const v = stored.get(k);
    out[k] = typeof v === 'string' ? v : SETTING_DEFAULTS[k];
  }
  return out;
}

export async function updateSettings(patch: Partial<BusinessSettings>): Promise<BusinessSettings> {
  const entries = (Object.entries(patch) as [SettingKey, string | undefined][]).filter(
    ([k, v]) => KEYS.includes(k) && v !== undefined,
  );
  await Promise.all(
    entries.map(([key, value]) =>
      prisma.setting.upsert({
        where: { key },
        create: { key, value: value ?? '' },
        update: { value: value ?? '' },
      }),
    ),
  );
  return getSettings();
}
