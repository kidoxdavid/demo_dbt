import type { Client } from '../db.js';

/** A shop's displayed rating = its base (the demo seed, zero for real shops) blended with its published reviews. Called whenever a review is added, hidden or restored. */
export async function recomputeShopRating(c: Client, shopId: string) {
  await c.query(`UPDATE shops s SET rating_count = s.rating_base_count + r.n,
      rating_avg = CASE WHEN s.rating_base_count + r.n = 0 THEN NULL ELSE round(((s.rating_base_avg * s.rating_base_count + r.total)::numeric / (s.rating_base_count + r.n)), 1) END
    FROM (SELECT count(*)::int AS n, coalesce(sum(rating),0)::int AS total FROM reviews WHERE shop_id=$1 AND status='published') r WHERE s.id=$1`, [shopId]);
}
