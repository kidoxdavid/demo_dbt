import { z } from 'zod';
import { q } from './db.js';
import { HttpError } from './errors.js';

/** Every platform setting: schema, default and whether the storefront may read it. Business rules are settings, never constants. */
export const SETTINGS = {
  commission_bps: { unit: 'bps', label: 'Commission', schema: z.number().int().min(0).max(5000), default: 1000, public: false, help: 'Platform commission on item value, in basis points (1000 = 10%).' },
  payout_hold_days: { unit: 'days', label: 'Payout hold', schema: z.number().int().min(0).max(60), default: 5, public: false, help: 'Days after delivery before a seller is paid.' },
  reservation_minutes: { unit: 'minutes', label: 'Checkout stock hold', schema: z.number().int().min(1).max(120), default: 15, public: false, help: 'How long stock is held during checkout.' },
  free_shipping_threshold_cents: { unit: 'cents', label: 'Free shipping from', schema: z.number().int().min(0).max(1_000_000), default: 7500, public: true, help: 'Order value for the "free shipping" announcement.' },
  gst_bps: { unit: 'bps', label: 'GST', schema: z.number().int().min(0).max(3000), default: 500, public: false, help: 'GST in basis points (500 = 5%).' },
  platform_look: { unit: 'choice', label: 'Storefront look', schema: z.enum(['atelier', 'noir', 'sage']), default: 'atelier', public: true, help: 'The look of the storefront.' },
  home_section_order: { schema: z.array(z.enum(['hero', 'categories', 'new', 'spotlight', 'trust', 'guides', 'recent'])).min(1).max(8), default: ['hero', 'categories', 'new', 'spotlight', 'trust'], public: true, help: 'Order of the home page sections.' },
  home_categories: { schema: z.array(z.object({ slug: z.string().max(60), label: z.string().max(30), kind: z.enum(['pottery', 'perfume', 'print', 'toy', 'print3d', 'hair', 'candle', 'jewel', 'planter', 'scarf']), tone: z.enum(['warm', 'sand', 'blush', 'sage', 'sky', 'butter', 'stone', 'ink']) })).max(12),
    default: [{ slug: 'art-prints', label: 'Art & prints', kind: 'print', tone: 'warm' }, { slug: 'pottery-ceramics', label: 'Pottery', kind: 'pottery', tone: 'blush' }, { slug: 'perfume-fragrance', label: 'Perfume', kind: 'perfume', tone: 'butter' }, { slug: 'hair-wigs', label: 'Hair', kind: 'hair', tone: 'stone' },
      { slug: 'toys-games', label: 'Toys', kind: 'toy', tone: 'butter' }, { slug: '3d-printing', label: '3D printed', kind: 'print3d', tone: 'sky' }, { slug: 'jewellery', label: 'Jewellery', kind: 'jewel', tone: 'sage' }, { slug: 'candles-home-fragrance', label: 'Candles', kind: 'candle', tone: 'sand' }], public: true, help: 'Category tiles on the home page and in the phone pill row.' },
  ads_min_bid_cents: { unit: 'cents', label: 'Lowest ad bid', schema: z.number().int().min(1).max(5000), default: 20, public: false, help: 'The lowest per-click bid a seller may set, and the least a click ever costs.' },
  ads_slots_per_page: { unit: 'count', label: 'Sponsored pieces per page', schema: z.number().int().min(0).max(4), default: 2, public: false, help: 'How many sponsored pieces a category or search page shows. 0 shows none.' },
  store_promotions_require_approval: { unit: 'toggle', label: 'Approve store promotions first', schema: z.boolean(), default: true, public: false, help: 'On: a maker\'s store promotion waits for staff approval before visitors see it, and edits go back for approval. Off: promotions go live at once.' },
  promo_bar: { unit: 'text', label: 'Promo bar text', schema: z.string().trim().max(140), default: 'Free shipping on orders over $75 from Canadian makers', public: true, help: 'The line in the bar above the desktop header. Empty hides the bar.' },
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

/**
 * Every feature toggle: where it shows up, what it does in plain words, and its starting state. A toggle with no stored row uses `default`.
 * Each one is enforced by the server (a switched-off feature answers "feature_off" or a specific closed message) and read by the website to hide its buttons.
 */
export type FlagPortal = 'shop' | 'studio' | 'platform';
export const FLAG_META = {
  guest_checkout: { portal: 'shop', label: 'Guest checkout', help: 'Buyers may pay without an account. Off: checkout asks them to sign in first.', default: true },
  buyer_signups: { portal: 'shop', label: 'Buyer sign-ups', help: 'New buyers may create accounts. Off: only existing accounts can sign in.', default: true },
  wishlists: { portal: 'shop', label: 'Saved pieces (hearts)', help: 'Buyers may save pieces. Off: the heart disappears and the Saved page is empty.', default: true },
  shop_follows: { portal: 'shop', label: 'Following shops', help: 'Buyers may follow shops. Off: the Follow button disappears.', default: true },
  gift_options: { portal: 'shop', label: 'Gift options', help: 'Buyers may mark a seller\'s items as a gift and add a message. Off: the gift option disappears from the basket.', default: true },
  reviews: { portal: 'shop', label: 'Reviews', help: 'Buyers may review delivered pieces and makers may reply. Off: reviews are hidden and cannot be written.', default: true },
  order_chat: { portal: 'shop', label: 'Order messages', help: 'Buyers and makers may message each other about an order. Off: messaging closes.', default: true },
  ads: { portal: 'platform', label: 'Sponsored pieces', help: 'Makers may run paid ads and sponsored pieces show in categories and search. Off: no ads are shown or can be created.', default: true },
  store_promotions: { portal: 'studio', label: 'Store promotions', help: 'Makers may run a promotion on their own store page. Off: promotions are hidden and cannot be created.', default: true },
  maker_signups: { portal: 'studio', label: 'New maker sign-ups', help: 'New makers may open a shop. Off: the sign-up is closed (existing makers are not affected).', default: true },
} as const satisfies Record<string, { portal: FlagPortal; label: string; help: string; default: boolean }>;
export type FlagKey = keyof typeof FLAG_META;
export const FLAGS = Object.keys(FLAG_META) as FlagKey[];
export async function allFlags(): Promise<Record<FlagKey, boolean>> {
  const rows = (await q('SELECT key, enabled FROM feature_flags')).rows as { key: string; enabled: boolean }[]; const stored = new Map(rows.map(r => [r.key, r.enabled]));
  return Object.fromEntries(FLAGS.map(k => [k, stored.get(k) ?? FLAG_META[k].default])) as Record<FlagKey, boolean>;
}

/** Stop a request when its feature is switched off. `code` is what the website and tests see. */
export async function requireFlag(key: FlagKey, code = 'feature_off', status = 404): Promise<void> { if (!(await allFlags())[key]) throw new HttpError(status, code); }
