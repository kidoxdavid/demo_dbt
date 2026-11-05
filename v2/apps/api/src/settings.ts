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
  home_categories: { schema: z.array(z.object({ slug: z.string().max(60), label: z.string().max(30), kind: z.enum(['pottery', 'perfume', 'print', 'toy', 'print3d', 'hair', 'candle', 'jewel', 'planter', 'scarf']), tone: z.enum(['warm', 'sand', 'blush', 'sage', 'sky', 'butter', 'stone', 'ink']) })).max(12),
    default: [{ slug: 'art-prints', label: 'Art & prints', kind: 'print', tone: 'warm' }, { slug: 'pottery-ceramics', label: 'Pottery', kind: 'pottery', tone: 'blush' }, { slug: 'perfume-fragrance', label: 'Perfume', kind: 'perfume', tone: 'butter' }, { slug: 'hair-wigs', label: 'Hair', kind: 'hair', tone: 'stone' },
      { slug: 'toys-games', label: 'Toys', kind: 'toy', tone: 'butter' }, { slug: '3d-printing', label: '3D printed', kind: 'print3d', tone: 'sky' }, { slug: 'jewellery', label: 'Jewellery', kind: 'jewel', tone: 'sage' }, { slug: 'candles-home-fragrance', label: 'Candles', kind: 'candle', tone: 'sand' }], public: true, help: 'Category tiles on the home page and in the phone pill row.' },
  ads_min_bid_cents: { schema: z.number().int().min(1).max(5000), default: 20, public: false, help: 'The lowest per-click bid a seller may set, and the least a click ever costs.' },
  ads_slots_per_page: { schema: z.number().int().min(0).max(4), default: 2, public: false, help: 'How many sponsored pieces a category or search page shows. 0 shows none.' },
  promo_bar: { schema: z.string().trim().max(140), default: 'Free shipping on orders over $75 from Canadian makers', public: true, help: 'The line in the bar above the desktop header. Empty hides the bar.' },
  home_picks_phone: { schema: z.array(z.string().uuid()).max(12), default: [], public: false, help: 'Curated "New from makers" on phones (product ids). Empty = newest.' },
  home_picks_desktop: { schema: z.array(z.string().uuid()).max(12), default: [], public: false, help: 'Curated "New from makers" on desktop (product ids). Empty = newest.' },
  home_spotlight: { schema: z.object({ shop: z.string().max(60), quote: z.string().max(400), art: z.object({ kind: z.string().max(20), tone: z.string().max(20) }).optional() }).nullable(), default: null, public: false, help: 'Maker spotlight: shop slug and a short quote.' },
  currency: { schema: z.literal('CAD'), default: 'CAD', public: true, help: 'All money is integer cents in this currency.' },
} as const;
export type SettingKey = keyof typeof SETTINGS;
export const isSettingKey = (k: string): k is SettingKey => k in SETTINGS;

export async function allSettings(c?: { query: (sql: string) => Promise<{ rows: any[] }> }): Promise<Record<string, unknown>> {
  const rows = (c ? await c.query('SELECT key, value FROM app_settings') : await q('SELECT key, value FROM app_settings')).rows as { key: string; value: unknown }[]; const stored = new Map(rows.map(r => [r.key, r.value]));
  return Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map(k => { const v = stored.get(k); const ok = v !== undefined && SETTINGS[k].schema.safeParse(v).success; return [k, ok ? v : SETTINGS[k].default]; }));
}

/** Feature flags the app knows about. A flag with no row is ON. */
export const FLAGS = ['wishlists', 'reviews', 'gift_options', 'order_chat', 'local_delivery', 'ads', 'ai_descriptions', 'bulk_import'] as const;
export const FLAG_DEFAULTS: Record<string, boolean> = { ai_descriptions: false };      // AI-assisted descriptions are off unless staff turn them on
export async function allFlags(): Promise<Record<string, boolean>> {
  const rows = (await q('SELECT key, enabled FROM feature_flags')).rows as { key: string; enabled: boolean }[]; const stored = new Map(rows.map(r => [r.key, r.enabled]));
  return Object.fromEntries(FLAGS.map(k => [k, stored.get(k) ?? FLAG_DEFAULTS[k] ?? true]));
}
