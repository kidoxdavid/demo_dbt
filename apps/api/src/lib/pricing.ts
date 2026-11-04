import type pg from 'pg';
import { HttpError } from './errors.js';
import { taxFor, type TaxLine } from './tax.js';

export interface PriceLine { variantId: string; qty: number; priceCents: number; weightGrams: number | null }
export interface PriceInput {
  fulfilment: 'pickup' | 'delivery'; destRegion?: string; sellerRegion: string | null; federal: boolean; provincial: string[];
  flatDeliveryFeeCents: number; lines: PriceLine[]; code?: string; email?: string;
  /** Checkout locks the discount row so two simultaneous orders cannot both use the last redemption. Quotes do not lock. */
  lockDiscount?: boolean;
}
export interface Priced {
  subtotalCents: number; discountCents: number; discountCode: string | null; discountId: string | null;
  shippingCents: number; shippingRule: string | null; taxCents: number; taxLines: TaxLine[]; taxRegion: string | null; totalCents: number;
}

/**
 * The ONE place an order total is worked out. The cart's quote and the real checkout both call it, so the price a shopper sees is the price they pay.
 *   subtotal  = prices from the database x quantities
 *   shipping  = pickup 0; delivery: the first matching shipping rule (province, weight, price band), else the store's flat fee;
 *               if rules exist but none match, the seller does not ship there (422), it is never silently free
 *   discount  = percent / fixed amount off the subtotal, or free shipping; validated for dates, minimum spend, total uses and uses per email
 *   tax       = on (subtotal - discount + shipping), by destination or seller province
 * Platform fees are charged on (subtotal - discount): the seller is not charged a fee on money they gave away.
 */
export async function priceCart(c: pg.PoolClient, i: PriceInput): Promise<Priced> {
  const subtotal = i.lines.reduce((n, l) => n + l.priceCents * l.qty, 0);
  const weight = i.lines.reduce((n, l) => n + (l.weightGrams ?? 0) * l.qty, 0);

  let shipping = 0; let shippingRule: string | null = null;
  if (i.fulfilment === 'delivery') {
    const rules = (await c.query('SELECT * FROM shipping_rules ORDER BY position, created_at')).rows;
    if (rules.length) {
      const region = (i.destRegion ?? '').trim().toUpperCase();
      const hit = rules.find(r =>
        (r.regions.length === 0 || r.regions.includes(region)) &&
        weight >= r.min_weight_g && (r.max_weight_g == null || weight <= r.max_weight_g) &&
        subtotal >= r.min_subtotal_cents && (r.max_subtotal_cents == null || subtotal <= r.max_subtotal_cents));
      if (!hit) throw new HttpError(422, 'no_shipping_option');
      shipping = hit.price_cents; shippingRule = hit.name;
    } else shipping = i.flatDeliveryFeeCents;
  }

  let discount = 0; let discountCode: string | null = null; let discountId: string | null = null;
  const code = i.code?.trim();
  if (code) {
    const d = (await c.query(`SELECT * FROM discounts WHERE code=$1 ${i.lockDiscount ? 'FOR UPDATE' : ''}`, [code])).rows[0];
    const bad = (why: string) => { throw new HttpError(422, `discount_invalid:${why}`); };
    if (!d) bad('not_found');
    if (!d.active) bad('inactive');
    const now = Date.now();
    if (d.starts_at && new Date(d.starts_at).getTime() > now) bad('not_started');
    if (d.ends_at && new Date(d.ends_at).getTime() < now) bad('expired');
    if (subtotal < d.min_subtotal_cents) bad(`min_subtotal:${d.min_subtotal_cents}`);
    if (d.max_uses != null) {
      const used = Number((await c.query(`SELECT count(*) n FROM discount_redemptions r JOIN orders o ON o.id=r.order_id WHERE r.discount_id=$1 AND o.status<>'cancelled'`, [d.id])).rows[0].n);
      if (used >= d.max_uses) bad('used_up');
    }
    if (d.max_uses_per_email != null && i.email) {
      const mine = Number((await c.query(`SELECT count(*) n FROM discount_redemptions r JOIN orders o ON o.id=r.order_id WHERE r.discount_id=$1 AND lower(r.email)=lower($2) AND o.status<>'cancelled'`, [d.id, i.email])).rows[0].n);
      if (mine >= d.max_uses_per_email) bad('used_by_you');
    }
    if (d.kind === 'percent') discount = Math.floor((subtotal * d.value) / 100);
    else if (d.kind === 'fixed') discount = Math.min(d.value, subtotal);
    else { if (i.fulfilment !== 'delivery' || shipping === 0) bad('not_applicable'); shipping = 0; }       // free shipping needs a delivery fee to waive
    discountCode = d.code; discountId = d.id;
  }

  const taxable = subtotal - discount + shipping;
  const tax = await taxFor(c, { fulfilment: i.fulfilment, destRegion: i.destRegion, sellerRegion: i.sellerRegion, federal: i.federal, provincial: i.provincial, taxableCents: taxable });
  return { subtotalCents: subtotal, discountCents: discount, discountCode, discountId, shippingCents: shipping, shippingRule, taxCents: tax.cents, taxLines: tax.lines, taxRegion: tax.region, totalCents: taxable + tax.cents };
}
