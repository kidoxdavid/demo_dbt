export interface Profile { rate_type: 'flat' | 'per_item' | 'weight'; base_cents: number; extra_item_cents: number; per_kg_cents: number; free_over_cents: number | null; transit_days_min: number; transit_days_max: number }
export const POSTAL = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i;
export const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
export const normalisePostal = (p: string) => p.replace(/\s|-/g, '').toUpperCase().replace(/^(.{3})(.{3})$/, '$1 $2');

/** Shipping for one seller's part of an order. Free when that seller's item total reaches their free-over amount. */
export function shippingCents(p: Profile, items: { quantity: number; weightG: number }[], itemsTotalCents: number): number {
  if (p.free_over_cents !== null && itemsTotalCents >= p.free_over_cents) return 0;
  const count = items.reduce((n, i) => n + i.quantity, 0); const grams = items.reduce((n, i) => n + i.quantity * i.weightG, 0);
  switch (p.rate_type) { case 'flat': return p.base_cents; case 'per_item': return p.base_cents + p.extra_item_cents * Math.max(0, count - 1); case 'weight': return p.base_cents + p.per_kg_cents * Math.ceil(grams / 1000); }
}
/** Delivery window in calendar days from today: the shop's processing time plus the profile's transit time. */
export function deliveryWindow(from: Date, processing: { min: number; max: number }, p: Pick<Profile, 'transit_days_min' | 'transit_days_max'>) {
  const add = (d: number) => { const x = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + d)); return x.toISOString().slice(0, 10); };
  return { min: add(processing.min + p.transit_days_min), max: add(processing.max + p.transit_days_max), shipBy: add(processing.max) };
}
export const DEFAULT_PROFILE: Profile = { rate_type: 'flat', base_cents: 900, extra_item_cents: 0, per_kg_cents: 0, free_over_cents: null, transit_days_min: 5, transit_days_max: 8 };
export const CARRIERS: Record<string, (n: string) => string> = {
  canada_post: n => `https://www.canadapost-postescanada.ca/track-reperage/en#/details/${encodeURIComponent(n)}`, purolator: n => `https://www.purolator.com/en/shipping/tracker?pin=${encodeURIComponent(n)}`,
  ups: n => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`, fedex: n => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`, dhl: n => `https://www.dhl.com/ca-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`, other: () => '',
};
