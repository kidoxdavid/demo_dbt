import type pg from 'pg';
import { HttpError } from './errors.js';

export interface TaxComponent { name: string; kind: 'federal' | 'provincial'; ppm: number }
export interface TaxLine { name: string; ppm: number; cents: number }
export interface TaxResult { cents: number; lines: TaxLine[]; region: string | null }

/** Integer maths only, rounding half up per component: no floating point drift on money. */
export const taxCents = (taxableCents: number, ppm: number) => Math.floor((taxableCents * ppm + 500_000) / 1_000_000);

export function applyTax(taxableCents: number, components: TaxComponent[], opts: { federal: boolean; provincialApplies: boolean }): TaxLine[] {
  return components
    .filter(c => (c.kind === 'federal' ? opts.federal : opts.provincialApplies))
    .map(c => ({ name: c.name, ppm: c.ppm, cents: taxCents(taxableCents, c.ppm) }))
    .filter(l => l.cents > 0);
}

/**
 * Which tax applies to an order.
 *  - Jurisdiction follows the destination for delivery, and the seller's own province for pickup.
 *  - GST/HST (federal kind) applies when the seller is registered for it, at the destination's rate.
 *  - PST/QST/RST (provincial kind) applies only where the seller is registered for that province's tax.
 *  - Delivery fees are taxable. Per-product exemptions (zero-rated goods) are NOT supported.
 * Not legal or accounting advice; see docs.
 */
export async function taxFor(c: pg.PoolClient, a: {
  fulfilment: 'pickup' | 'delivery'; destRegion?: string; sellerRegion: string | null; federal: boolean; provincial: string[]; taxableCents: number;
}): Promise<TaxResult> {
  if (!a.federal && a.provincial.length === 0) return { cents: 0, lines: [], region: null };
  const region = (a.fulfilment === 'delivery' ? a.destRegion : a.sellerRegion)?.trim().toUpperCase() ?? '';
  const row = region ? (await c.query(`SELECT components FROM tax_rates WHERE country='CA' AND region=$1`, [region])).rows[0] : undefined;
  if (!row) throw new HttpError(422, 'tax_region_unknown');
  const lines = applyTax(a.taxableCents, row.components as TaxComponent[], { federal: a.federal, provincialApplies: a.provincial.includes(region) });
  return { cents: lines.reduce((n, l) => n + l.cents, 0), lines, region };
}
