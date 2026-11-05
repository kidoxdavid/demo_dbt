import type { Client } from '../db.js';
import { pool } from '../db.js';
import { allSettings } from '../settings.js';
import { mediaUrl } from './media.js';
import { allocate, percentOf } from './money.js';
import { now as clockNow } from './clock.js';
import { DEFAULT_PROFILE, deliveryWindow, shippingCents, type Profile } from './shipping.js';

export type Issue = 'unavailable' | 'vacation' | 'out_of_stock';
export interface PricedLine { itemId: string; variantId: string; productId: string; title: string; variantLabel: string | null; options: Record<string, string>; sku: string | null; quantity: number; unitCents: number; compareAtCents: number | null; lineCents: number;
  taxable: boolean; weightG: number; tracksStock: boolean; available: number | null; issue: Issue | null; personalisation: Record<string, string>; image: string | null; imageMediaId: string | null; art: { kind: string; tone: string } | null; oneOfAKind: boolean; profileId: string | null }
export interface PricedGroup { sellerId: string; shopId: string; shop: { name: string; slug: string; logo: string | null }; commissionBps: number; lines: PricedLine[]; itemsCents: number; shippingCents: number; taxCents: number; itemsTaxCents: number; shippingTaxCents: number; totalCents: number;
  eta: { min: string; max: string; shipBy: string }; freeShipping: boolean; gift: { isGift: boolean; message: string } | null; processing: { min: number; max: number } }
export interface PricedCart { groups: PricedGroup[]; itemsCents: number; shippingCents: number; taxCents: number; totalCents: number; count: number; blocked: boolean }

/** Price a cart from the database (never from anything the browser sent): current prices, availability, per-seller shipping, delivery window, GST and commission. */
export async function priceCart(c: Client | typeof pool, cartId: string, now = clockNow()): Promise<PricedCart> {
  const settings = await allSettings(c); const gst = settings.gst_bps as number; const defaultCommission = settings.commission_bps as number;
  const rows = (await c.query(`SELECT ci.id AS item_id, ci.quantity, ci.personalisation, v.id AS variant_id, v.price_cents, v.compare_at_cents, v.options, v.sku, v.weight_g, v.tracks_stock, v.status AS vstatus, v.image_media_id,
      v.stock_on_hand - v.stock_reserved AS avail, p.id AS product_id, p.title, p.status AS pstatus, p.moderation_status, p.tax_class, p.one_of_a_kind, p.shipping_profile_id, p.art_kind, p.art_tone,
      s.id AS shop_id, s.name AS shop_name, s.slug AS shop_slug, s.status AS shop_status, s.vacation_mode, s.processing_days_min, s.processing_days_max, s.logo_media_id, se.id AS seller_id, se.status AS seller_status, se.commission_bps,
      (SELECT pm.media_id FROM product_media pm JOIN media m ON m.id=pm.media_id AND m.kind='image' WHERE pm.product_id=p.id ORDER BY pm.position LIMIT 1) AS photo
    FROM cart_items ci JOIN variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id JOIN shops s ON s.id=p.shop_id JOIN sellers se ON se.id=p.seller_id
    WHERE ci.cart_id=$1 ORDER BY ci.created_at, ci.id`, [cartId])).rows;
  const sellerIds = [...new Set(rows.map(r => r.seller_id as string))];
  const profiles = sellerIds.length ? (await c.query('SELECT * FROM shipping_profiles WHERE seller_id = ANY($1::uuid[])', [sellerIds])).rows : [];
  const gifts = new Map((await c.query('SELECT seller_id, is_gift, message FROM cart_gifts WHERE cart_id=$1', [cartId])).rows.map(g => [g.seller_id as string, { isGift: g.is_gift as boolean, message: (g.message ?? '') as string }]));
  const groups = new Map<string, PricedGroup>();
  for (const r of rows) {
    const visible = r.pstatus === 'published' && r.moderation_status !== 'removed' && r.vstatus === 'active' && r.shop_status === 'live' && r.seller_status === 'active';
    const issue: Issue | null = !visible ? 'unavailable' : r.vacation_mode ? 'vacation' : r.tracks_stock && r.quantity > r.avail ? 'out_of_stock' : null;
    let g = groups.get(r.seller_id);
    if (!g) groups.set(r.seller_id, g = { sellerId: r.seller_id, shopId: r.shop_id, shop: { name: r.shop_name, slug: r.shop_slug, logo: mediaUrl(r.logo_media_id, 'w320') }, commissionBps: r.commission_bps ?? defaultCommission, lines: [], itemsCents: 0, shippingCents: 0, taxCents: 0, itemsTaxCents: 0, shippingTaxCents: 0, totalCents: 0,
      eta: { min: '', max: '', shipBy: '' }, freeShipping: false, gift: gifts.get(r.seller_id) ?? null, processing: { min: r.processing_days_min, max: r.processing_days_max } });
    const label = Object.values(r.options as Record<string, string>).join(' · ');
    g.lines.push({ itemId: r.item_id, variantId: r.variant_id, productId: r.product_id, title: r.title, variantLabel: label || null, options: r.options, sku: r.sku, quantity: r.quantity, unitCents: r.price_cents, compareAtCents: r.compare_at_cents, lineCents: r.price_cents * r.quantity,
      taxable: r.tax_class === 'standard', weightG: r.weight_g ?? 0, tracksStock: r.tracks_stock, available: r.tracks_stock ? Math.max(0, r.avail) : null, issue, personalisation: r.personalisation, image: mediaUrl(r.photo, 'w320'), imageMediaId: r.photo ?? null,
      art: r.art_kind ? { kind: r.art_kind, tone: r.art_tone ?? 'warm' } : null, oneOfAKind: r.one_of_a_kind, profileId: r.shipping_profile_id });
  }
  for (const g of groups.values()) {
    g.itemsCents = g.lines.reduce((n, l) => n + l.lineCents, 0);
    const mine = profiles.filter(p => p.seller_id === g.sellerId); const def: Profile = (mine.find(p => p.is_default) ?? DEFAULT_PROFILE) as Profile;
    const byProfile = new Map<string, PricedLine[]>(); for (const l of g.lines) { const k = l.profileId && mine.some(p => p.id === l.profileId) ? l.profileId : 'default'; byProfile.set(k, [...(byProfile.get(k) ?? []), l]); }
    // One parcel per seller: the dearest of the profiles that apply. Free-over looks at the seller's whole items total.
    let ship = 0, tmin = 0, tmax = 0;
    for (const [k, ls] of byProfile) { const p: Profile = k === 'default' ? def : (mine.find(x => x.id === k) as Profile); const free = p.free_over_cents !== null && g.itemsCents >= p.free_over_cents;
      ship = Math.max(ship, shippingCents(p, ls.map(l => ({ quantity: l.quantity, weightG: l.weightG })), g.itemsCents)); tmin = Math.max(tmin, p.transit_days_min); tmax = Math.max(tmax, p.transit_days_max); if (free && ship === 0) g.freeShipping = true; }
    g.shippingCents = ship; g.freeShipping = ship === 0 && [...byProfile.keys()].some(k => (k === 'default' ? def : (mine.find(x => x.id === k) as Profile)).free_over_cents !== null);
    const w = deliveryWindow(now, g.processing, { transit_days_min: tmin, transit_days_max: tmax }); g.eta = { min: w.min, max: w.max, shipBy: w.shipBy };
    const taxableItems = g.lines.filter(l => l.taxable).reduce((n, l) => n + l.lineCents, 0); g.itemsTaxCents = percentOf(taxableItems, gst);
    g.shippingTaxCents = taxableItems > 0 ? percentOf(g.shippingCents, gst) : 0;                                   // shipping is taxed only when the order has taxable goods
    g.taxCents = g.itemsTaxCents + g.shippingTaxCents; g.totalCents = g.itemsCents + g.shippingCents + g.taxCents;
  }
  const list = [...groups.values()]; const sum = (f: (g: PricedGroup) => number) => list.reduce((n, g) => n + f(g), 0);
  return { groups: list, itemsCents: sum(g => g.itemsCents), shippingCents: sum(g => g.shippingCents), taxCents: sum(g => g.taxCents), totalCents: sum(g => g.totalCents), count: sum(g => g.lines.reduce((n, l) => n + l.quantity, 0)), blocked: list.some(g => g.lines.some(l => l.issue)) };
}
/** Spread a seller order's GST and commission over its lines so a partial refund returns exactly the right share. */
export function allocateToLines(g: PricedGroup) {
  const taxable = g.lines.map(l => (l.taxable ? l.lineCents : 0)); const tax = allocate(g.itemsTaxCents, taxable); const comm = allocate(percentOf(g.itemsCents, g.commissionBps), g.lines.map(l => l.lineCents));
  return g.lines.map((l, i) => ({ line: l, taxCents: tax[i], commissionCents: comm[i] }));
}
