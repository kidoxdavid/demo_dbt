import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => '\\' + c);

/**
 * Public marketplace reads span tenants, so they run with platform context. Safety comes from the SQL itself:
 * only ACTIVE products of PUBLISHED stores whose tenant is ACTIVE, and only explicitly selected public columns
 * (never cost, stock counts, or customer data). Tests assert both the visibility rules and the absence of internals.
 */
const VISIBLE = `p.status='active' AND s.status='published' AND t.status='active'`;

export function registerMarketplace(app: FastifyInstance) {
  app.get('/api/public/marketplace', async (req) => {
    const q = z.object({
      q: z.string().trim().max(80).optional(), category: z.string().trim().max(80).optional(),
      sort: z.enum(['new', 'price_asc', 'price_desc']).default('new'),
      limit: z.coerce.number().int().min(1).max(60).default(24), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const like = q.q ? `%${escapeLike(q.q)}%` : null;
    const order = q.sort === 'price_asc' ? 'price_from ASC, p.id' : q.sort === 'price_desc' ? 'price_from DESC, p.id' : 'p.created_at DESC, p.id';

    return withTx({ platform: true }, async c => {
      // Exact matches win. Typo-tolerant matching is only a fallback, otherwise a search for "Item 07" would also return Item 17, Item 27...
      const exactExists = !like || (await c.query(
        `SELECT 1 FROM products p JOIN stores s ON s.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id JOIN businesses b ON b.tenant_id=p.tenant_id
         WHERE ${VISIBLE} AND ($1::text IS NULL OR lower(b.category)=lower($1))
           AND (p.name ILIKE $2 ESCAPE '\\' OR p.brand ILIKE $2 ESCAPE '\\' OR s.name ILIKE $2 ESCAPE '\\' OR b.category ILIKE $2 ESCAPE '\\') LIMIT 1`, [q.category ?? null, like])).rowCount! > 0;
      const fuzzy = !exactExists;
      const products = (await c.query(
        `SELECT p.id, p.name, p.brand, p.made_to_order AS "madeToOrder", p.available_from AS "availableFrom", (p.available_from > now()) AS "comingSoon", s.slug AS "storeSlug", s.name AS "storeName",
                b.category, b.currency,
                (SELECT min(v.price_cents) FROM product_variants v WHERE v.product_id=p.id) AS price_from,
                (SELECT max(v.price_cents) FROM product_variants v WHERE v.product_id=p.id) AS "priceTo",
                (SELECT '/media/'||m.storage_key FROM product_media m WHERE m.product_id=p.id ORDER BY m.position LIMIT 1) AS image,
                (SELECT '/media/'||m.storage_key FROM product_media m WHERE m.product_id=p.id ORDER BY m.position OFFSET 1 LIMIT 1) AS image2,
                EXISTS (SELECT 1 FROM product_variants v JOIN inventory_levels l ON l.variant_id=v.id
                        WHERE v.product_id=p.id AND (NOT v.track_inventory OR l.on_hand-l.reserved>0)) AS available,
                (SELECT json_build_object('avg', round(avg(r.rating)::numeric,1)::float, 'count', count(*)::int) FROM product_reviews r WHERE r.product_id=p.id AND r.status='published') AS rating,
                count(*) OVER()::int AS total
         FROM products p JOIN stores s ON s.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id JOIN businesses b ON b.tenant_id=p.tenant_id
         WHERE ${VISIBLE}
           AND ($1::text IS NULL OR lower(b.category)=lower($1))
           AND ($2::text IS NULL OR p.name ILIKE $2 ESCAPE '\\' OR p.brand ILIKE $2 ESCAPE '\\' OR s.name ILIKE $2 ESCAPE '\\' OR b.category ILIKE $2 ESCAPE '\\'
                OR ($6::boolean AND word_similarity($3, p.name) > 0.45))
         ORDER BY ${order} LIMIT $4 OFFSET $5`, [q.category ?? null, like, q.q ?? '', q.limit, q.offset, fuzzy])).rows;

      const stores = (await c.query(
        `SELECT s.slug, s.name, s.tagline, s.theme, b.category, b.city, b.region, (b.verification_status='verified') AS verified,
                (SELECT count(*)::int FROM products p WHERE p.tenant_id=s.tenant_id AND p.status='active') AS "productCount",
                (SELECT coalesce(json_agg(img), '[]'::json) FROM (
                   SELECT '/media/'||m.storage_key AS img FROM product_media m JOIN products p ON p.id=m.product_id
                   WHERE p.tenant_id=s.tenant_id AND p.status='active' ORDER BY p.created_at DESC, m.position LIMIT 3) x) AS covers
         FROM stores s JOIN tenants t ON t.id=s.tenant_id JOIN businesses b ON b.tenant_id=s.tenant_id
         WHERE s.status='published' AND t.status='active'
           AND EXISTS (SELECT 1 FROM products p WHERE p.tenant_id=s.tenant_id AND p.status='active')
           AND ($1::text IS NULL OR lower(b.category)=lower($1))
           AND ($2::text IS NULL OR s.name ILIKE $2 ESCAPE '\\' OR b.category ILIKE $2 ESCAPE '\\' OR s.tagline ILIKE $2 ESCAPE '\\')
         ORDER BY s.published_at DESC LIMIT 12`, [q.category ?? null, like])).rows;

      // Editorial pick: when browsing without filters, the admin-chosen featured store leads (if still published and active).
      if (!q.q && !q.category) {
        const slug = (await c.query(`SELECT value->>'slug' AS slug FROM platform_settings WHERE key='featured_store'`)).rows[0]?.slug as string | undefined;
        if (slug) {
          let f = stores.find(s => s.slug === slug);
          if (!f) f = (await c.query(
            `SELECT s.slug, s.name, s.tagline, s.theme, b.category, b.city, b.region, (b.verification_status='verified') AS verified,
                    (SELECT count(*)::int FROM products p WHERE p.tenant_id=s.tenant_id AND p.status='active') AS "productCount",
                    (SELECT coalesce(json_agg(img), '[]'::json) FROM (SELECT '/media/'||m.storage_key AS img FROM product_media m JOIN products p ON p.id=m.product_id
                       WHERE p.tenant_id=s.tenant_id AND p.status='active' ORDER BY p.created_at DESC, m.position LIMIT 3) x) AS covers
             FROM stores s JOIN tenants t ON t.id=s.tenant_id JOIN businesses b ON b.tenant_id=s.tenant_id
             WHERE s.slug=$1 AND s.status='published' AND t.status='active' AND EXISTS (SELECT 1 FROM products p WHERE p.tenant_id=s.tenant_id AND p.status='active')`, [slug])).rows[0];
          if (f) { const i = stores.findIndex(s => s.slug === f!.slug); if (i >= 0) stores.splice(i, 1); stores.unshift(f); }
        }
      }

      const categories = (await c.query(
        `SELECT b.category AS name, count(DISTINCT s.id)::int AS stores
         FROM stores s JOIN tenants t ON t.id=s.tenant_id JOIN businesses b ON b.tenant_id=s.tenant_id
         WHERE s.status='published' AND t.status='active' AND b.category IS NOT NULL AND b.category<>''
           AND EXISTS (SELECT 1 FROM products p WHERE p.tenant_id=s.tenant_id AND p.status='active')
         GROUP BY b.category ORDER BY stores DESC, b.category`)).rows;

      return { categories, stores, products: products.map(({ total: _t, price_from, ...r }) => ({ ...r, priceFrom: price_from })), total: products[0]?.total ?? 0 };
    });
  });

  app.get('/api/public/stores/:slug/products/:id', async (req) => {
    const { slug, id } = z.object({ slug: z.string().regex(SLUG), id: z.string().uuid() }).parse(req.params);
    const s = await withTx({}, async c => (await c.query('SELECT tenant_id FROM stores WHERE slug=$1', [slug])).rows[0]); // RLS: published only
    if (!s) throw new HttpError(404, 'not_found');
    const p = await withTx({ tenantId: s.tenant_id }, async c => (await c.query(
      `SELECT p.id, p.name, p.description, p.brand, p.attributes, p.made_to_order AS "madeToOrder", p.custom_fields AS "customFields", p.available_from AS "availableFrom", (p.available_from > now()) AS "comingSoon",
        (SELECT json_agg(json_build_object('id',v.id,'title',v.title,'options',v.options,'priceCents',v.price_cents,
           'available',(NOT v.track_inventory) OR (l.on_hand-l.reserved>0)) ORDER BY v.created_at)
         FROM product_variants v JOIN inventory_levels l ON l.variant_id=v.id WHERE v.product_id=p.id) AS variants,
        (SELECT coalesce(json_agg('/media/'||m.storage_key ORDER BY m.position),'[]'::json) FROM product_media m WHERE m.product_id=p.id) AS images,
        (SELECT json_build_object('avg', round(avg(r.rating)::numeric,1)::float, 'count', count(*)::int) FROM product_reviews r WHERE r.product_id=p.id AND r.status='published') AS rating
       FROM products p WHERE p.id=$1 AND p.status='active'`, [id])).rows[0]);
    if (!p) throw new HttpError(404, 'not_found');
    return p;
  });
}
