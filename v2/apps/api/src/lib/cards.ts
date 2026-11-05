import { mediaUrl } from './media.js';

/**
 * THE shared product-card query: every listing (home, category, shop page, similar, more-from) uses these fragments, so a card looks and behaves the same everywhere.
 * The search route builds on the same fragments and only adds ranking. Keep them in step.
 */
export const VISIBLE = `p.status='published' AND p.moderation_status<>'removed' AND s.status='live' AND se.status='active'`;
export const CARD_FROM = `FROM products p JOIN shops s ON s.id=p.shop_id JOIN sellers se ON se.id=p.seller_id
  JOIN LATERAL (SELECT price_cents, compare_at_cents FROM variants WHERE product_id=p.id AND status='active' ORDER BY price_cents, position LIMIT 1) v ON true`;
export const CARD_COLUMNS = `p.id, p.title, p.chip_override, p.handmade, p.one_of_a_kind, p.made_to_order, p.art_kind, p.art_tone, p.created_at,
  s.name AS shop_name, s.slug AS shop_slug, s.rating_avg, s.rating_count, v.price_cents, v.compare_at_cents,
  (NOT s.vacation_mode AND EXISTS (SELECT 1 FROM variants x WHERE x.product_id=p.id AND x.status='active' AND (NOT x.tracks_stock OR x.stock_on_hand - x.stock_reserved > 0))) AS available,
  (SELECT pm.media_id FROM product_media pm JOIN media m ON m.id=pm.media_id AND m.kind='image' WHERE pm.product_id=p.id ORDER BY pm.position LIMIT 1) AS photo_id,
  (SELECT m.blur FROM product_media pm JOIN media m ON m.id=pm.media_id AND m.kind='image' WHERE pm.product_id=p.id ORDER BY pm.position LIMIT 1) AS photo_blur`;

export interface Card { id: string; title: string; seller: { name: string; slug: string }; priceCents: number; wasCents: number | null; chip: string | null; photo: string | null; photoBlur: string | null; art: { kind: string; tone: string } | null; oneOfAKind: boolean; madeToOrder: boolean; available: boolean; rating: { avg: number; count: number } | null }
export function toCard(r: any): Card {
  const chip = r.chip_override ?? (r.one_of_a_kind ? 'One of a kind' : r.handmade ? 'Handmade' : null);
  return { id: r.id, title: r.title, seller: { name: r.shop_name, slug: r.shop_slug }, priceCents: r.price_cents, wasCents: r.compare_at_cents ?? null, chip, photo: mediaUrl(r.photo_id, 'w640'), photoBlur: r.photo_blur ?? null,
    art: r.art_kind ? { kind: r.art_kind, tone: r.art_tone ?? 'warm' } : null, oneOfAKind: r.one_of_a_kind, madeToOrder: r.made_to_order, available: r.available, rating: r.rating_count > 0 ? { avg: Number(r.rating_avg), count: r.rating_count } : null };
}
