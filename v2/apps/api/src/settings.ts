import { z } from 'zod';
import { q } from './db.js';

/** Every platform setting: schema, default and whether the storefront may read it. Business rules are settings, never constants. */
export const SETTINGS = {
  commission_bps: { schema: z.number().int().min(0).max(5000), default: 1000, public: false, help: 'Platform commission on item value, in basis points (1000 = 10%).' },
  payout_hold_days: { schema: z.number().int().min(0).max(60), default: 5, public: false, help: 'Days after delivery before a seller is paid.' },
  reservation_minutes: { schema: z.number().int().min(1).max(120), default: 15, public: false, help: 'How long stock is held during checkout.' },
  free_shipping_threshold_cents: { schema: z.number().int().min(0).max(1_000_000), default: 7500, public: true, help: 'Order value for the "free shipping" announcement.' },
  gst_bps: { schema: z.number().int().min(0).max(3000), default: 500, public: false, help: 'GST in basis points (500 = 5%).' },
  platform_look: { schema: z.enum(['atelier', 'noir', 'sage']), default: 'atelier', public: true, help: 'The look of the storefront.' },
  home_section_order: { schema: z.array(z.enum(['hero', 'categories', 'new', 'spotlight', 'trust', 'guides', 'recent'])).min(1).max(8), default: ['hero', 'categories', 'new', 'spotlight', 'trust'], public: true, help: 'Order of the home page sections.' },
  currency: { schema: z.literal('CAD'), default: 'CAD', public: true, help: 'All money is integer cents in this currency.' },
} as const;
export type SettingKey = keyof typeof SETTINGS;
export const isSettingKey = (k: string): k is SettingKey => k in SETTINGS;

export async function allSettings(): Promise<Record<string, unknown>> {
  const rows = (await q('SELECT key, value FROM app_settings')).rows as { key: string; value: unknown }[]; const stored = new Map(rows.map(r => [r.key, r.value]));
  return Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map(k => { const v = stored.get(k); const ok = v !== undefined && SETTINGS[k].schema.safeParse(v).success; return [k, ok ? v : SETTINGS[k].default]; }));
}

/** Feature flags the app knows about. A flag with no row is ON. */
export const FLAGS = ['wishlists', 'reviews', 'gift_options', 'order_chat', 'local_delivery', 'ads', 'ai_descriptions', 'bulk_import'] as const;
export const FLAG_DEFAULTS: Record<string, boolean> = { ai_descriptions: false };      // AI-assisted descriptions are off unless staff turn them on
export async function allFlags(): Promise<Record<string, boolean>> {
  const rows = (await q('SELECT key, enabled FROM feature_flags')).rows as { key: string; enabled: boolean }[]; const stored = new Map(rows.map(r => [r.key, r.enabled]));
  return Object.fromEntries(FLAGS.map(k => [k, stored.get(k) ?? FLAG_DEFAULTS[k] ?? true]));
}
