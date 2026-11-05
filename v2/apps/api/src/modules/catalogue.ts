import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { microcache } from '../lib/microcache.js';
import { pool, q } from '../db.js';
import { HttpError } from '../errors.js';
import { categoryInfo } from '../lib/attributes.js';
import { CARD_COLUMNS, CARD_FROM, VISIBLE, toCard } from '../lib/cards.js';
import { mediaUrl, readMedia } from '../lib/media.js';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const bool = z.enum(['true', 'false', '1', '0']).transform(v => v === 'true' || v === '1');
const listQuery = z.object({
  q: z.string().trim().max(80).optional(), category: z.string().regex(SLUG).optional(), shop: z.string().regex(SLUG).optional(),
  minPrice: z.coerce.number().int().min(0).optional(), maxPrice: z.coerce.number().int().min(0).optional(),
  handmade: bool.optional(), oneOfAKind: bool.optional(), madeToOrder: bool.optional(), freeShipping: bool.optional(), inStock: bool.optional(), rating: z.coerce.number().min(1).max(5).optional(),
  sort: z.enum(['featured', 'new', 'price_asc', 'price_desc', 'popular', 'relevance']).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24), offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).passthrough();

const esc = (s: string) => s.replace(/[\\%_]/g, c => '\\' + c);
/** Verified synonyms, loaded per request (a tiny table). A word is searched together with the words a human confirmed mean the same thing. */
async function synonymMap() { const m = new Map<string, string[]>(); for (const r of (await q('SELECT term::text AS term, related FROM synonyms')).rows) m.set(r.term.toLowerCase(), r.related); return m; }

interface Built { where: string; params: unknown[]; fuzzy: boolean }
async function buildWhere(f: z.infer<typeof listQuery>, raw: Record<string, unknown>, fuzzy: boolean): Promise<Built> {
  const params: unknown[] = []; const add = (v: unknown) => { params.push(v); return `$${params.length}`; }; const w: string[] = [VISIBLE];
  if (f.category) {
    const ids = (await q(`WITH RECURSIVE tree AS (SELECT id FROM categories WHERE slug=$1 AND status='active' UNION ALL SELECT c.id FROM categories c JOIN tree t ON c.parent_id=t.id WHERE c.status='active') SELECT id FROM tree`, [f.category])).rows.map(r => r.id);
    if (!ids.length) throw new HttpError(404, 'category_not_found');
    w.push(`p.id IN (SELECT product_id FROM product_categories WHERE category_id = ANY(${add(ids)}::uuid[]))`);     // every category it legitimately belongs to, not one optional tag
  }
  if (f.shop) w.push(`s.slug = ${add(f.shop)}`);
  if (f.minPrice !== undefined) w.push(`v.price_cents >= ${add(f.minPrice)}`); if (f.maxPrice !== undefined) w.push(`v.price_cents <= ${add(f.maxPrice)}`);
  if (f.handmade) w.push('p.handmade'); if (f.oneOfAKind) w.push('p.one_of_a_kind'); if (f.madeToOrder) w.push('p.made_to_order');
  if (f.freeShipping) w.push(`EXISTS (SELECT 1 FROM shipping_profiles sp WHERE sp.seller_id=p.seller_id AND sp.is_default AND (sp.base_cents=0 OR sp.free_over_cents <= v.price_cents))`);       // ships free for this piece on its own
  if (f.inStock) w.push(`EXISTS (SELECT 1 FROM variants x WHERE x.product_id=p.id AND x.status='active' AND (NOT x.tracks_stock OR x.stock_on_hand - x.stock_reserved > 0))`);
  if (f.rating) w.push(`s.rating_avg >= ${add(f.rating)}`);
  for (const [k, v] of Object.entries(raw)) {                                   // attribute filters: ?attr.material=wood,pla&attr.handmade=true
    if (!k.startsWith('attr.')) continue; const key = k.slice(5); if (!/^[a-z][a-z0-9_]*$/.test(key) || typeof v !== 'string') continue; const vals = v.split(',').slice(0, 10);
    w.push(`EXISTS (SELECT 1 FROM product_attribute_values av WHERE av.product_id=p.id AND av.key=${add(key)} AND (${vals.map(x => {
      const val = x === 'true' ? true : x === 'false' ? false : x; const p1 = add(JSON.stringify(val)); const p2 = add(JSON.stringify([val]));
      return `av.value = ${p1}::jsonb OR av.value @> ${p2}::jsonb`; }).join(' OR ')}))`);
  }
  if (f.q) {
    const syn = await synonymMap(); const tokens = f.q.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
    if (tokens.length) {
      const field = (p: string) => `(p.search_text ILIKE ${p} ESCAPE '\\' OR p.shop_id IN (SELECT id FROM shops WHERE name ILIKE ${p} ESCAPE '\\'))`;
      const phrase = tokens.join(' '); const phraseAlts = syn.get(phrase) ?? [];
      if (!fuzzy) {
        const groups = tokens.map(t => `(${[t, ...(syn.get(t) ?? [])].map(a => field(add(`%${esc(a)}%`))).join(' OR ')})`);
        const alt = phraseAlts.length ? ` OR (${phraseAlts.map(a => field(add(`%${esc(a)}%`))).join(' OR ')})` : '';
        w.push(`((${groups.join(' AND ')})${alt})`);
      } else { const qq = add(phrase); w.push(`(word_similarity(${qq}, p.title) > 0.45 OR similarity(s.name, ${qq}) > 0.4)`); }       // typo tolerance only as a fallback
    }
  }
  return { where: w.join(' AND '), params, fuzzy };
}

export function registerCatalogue(app: FastifyInstance) {
  /** Listing and search. Same cards everywhere. Exact matches win; typo-tolerant matching only runs when nothing matches exactly. */
  const listProducts = async (req: { query: unknown }) => {
    const raw = req.query as Record<string, unknown>; const f = listQuery.parse(raw);
    // Counting and facets do not need each piece's cheapest variant unless a price or shipping filter does, so that join is left out when it is not needed.
    const needsV = f.minPrice !== undefined || f.maxPrice !== undefined || !!f.freeShipping;
    const fromC = needsV ? CARD_FROM : `FROM products p JOIN shops s ON s.id=p.shop_id JOIN sellers se ON se.id=p.seller_id`; const whereC = (b: Built) => (needsV ? b.where : `${b.where} AND EXISTS (SELECT 1 FROM variants x0 WHERE x0.product_id=p.id AND x0.status='active')`);
    const count = async (b: Built) => (await pool.query(`SELECT count(*)::int AS n, count(DISTINCT s.id)::int AS makers ${fromC} WHERE ${whereC(b)}`, b.params)).rows[0] as { n: number; makers: number };
    let b = await buildWhere(f, raw, false); let c = await count(b);
    if (c.n === 0 && f.q) { b = await buildWhere(f, raw, true); c = await count(b); }
    const sort = f.sort ?? (f.q ? 'relevance' : 'featured'); const params = [...b.params];
    const rel = f.q && sort === 'relevance' ? (() => { params.push(f.q!.toLowerCase()); return `(CASE WHEN lower(p.title) = $${params.length} THEN 4 WHEN lower(p.title) LIKE $${params.length} || '%' THEN 3 WHEN lower(p.title) LIKE '%' || $${params.length} || '%' THEN 2 ELSE 0 END) DESC, `; })() : '';
    const order = { featured: 'p.created_at DESC', new: 'p.created_at DESC', relevance: 'p.created_at DESC', price_asc: 'v.price_cents ASC, p.created_at DESC', price_desc: 'v.price_cents DESC, p.created_at DESC', popular: 'p.sales_count DESC, p.created_at DESC' }[sort];
    params.push(f.limit, f.offset);
    const rowsP = pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${b.where} ORDER BY ${rel}${order}, p.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const facetsP = f.category ? (async () => {                                // facets for the category's filterable attributes, counted over what currently matches, in one query
      const cat = await categoryInfo(pool, (await q('SELECT id FROM categories WHERE slug=$1', [f.category])).rows[0].id); const defs = (cat?.defs ?? []).filter(d => d.filterable && ['select', 'multiselect', 'boolean'].includes(d.type)); if (!defs.length) return [];
      const fp = [...b.params, defs.map(d => d.key)]; const vals = (await pool.query(`SELECT av.key, av.value, count(*)::int n FROM product_attribute_values av WHERE av.key = ANY($${fp.length}::text[]) AND av.product_id IN (SELECT p.id ${fromC} WHERE ${whereC(b)}) GROUP BY av.key, av.value`, fp)).rows;
      const facets: any[] = [];
      for (const d of defs) { const counts = new Map<string, number>(); for (const r of vals.filter(v => v.key === d.key)) for (const v of Array.isArray(r.value) ? r.value : [r.value]) counts.set(String(v), (counts.get(String(v)) ?? 0) + r.n);
        facets.push({ key: d.key, label: d.label, type: d.type, options: d.type === 'boolean' ? [{ value: 'true', label: 'Yes', count: counts.get('true') ?? 0 }] : (d.options ?? []).map(o => ({ value: o.value, label: o.label, count: counts.get(o.value) ?? 0 })).filter(o => o.count > 0) });
      }
      return facets.filter(x => x.options.length);
    })() : Promise.resolve(undefined);
    const [rows, facets] = await Promise.all([rowsP, facetsP]);
    const out: any = { total: c.n, makers: c.makers, fuzzy: b.fuzzy, items: rows.rows.map(toCard) }; if (facets) out.facets = facets;
    return out;
  };
  /** The same answer for everyone, so identical requests within a few seconds share one query. */
  app.get('/api/products', async (req, reply) => { reply.header('cache-control', config.listCacheMs > 0 ? `public, max-age=${Math.round(config.listCacheMs / 2000)}` : 'no-store'); return microcache(`products:${req.url}`, () => listProducts(req)); });

  app.get('/api/search/suggest', async (req) => {
    const { q: term } = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query); const like = `%${esc(term)}%`;
    const [products, shops, cats] = await Promise.all([
      pool.query(`SELECT p.id, p.title, s.name AS shop_name ${CARD_FROM} WHERE ${VISIBLE} AND p.title ILIKE $1 ESCAPE '\\' ORDER BY p.sales_count DESC, p.created_at DESC LIMIT 5`, [like]),
      pool.query(`SELECT slug, name FROM shops WHERE status='live' AND name ILIKE $1 ESCAPE '\\' ORDER BY name LIMIT 3`, [like]),
      pool.query(`SELECT slug, name FROM categories WHERE status='active' AND name ILIKE $1 ESCAPE '\\' ORDER BY sort LIMIT 3`, [like])]);
    return { products: products.rows.map(r => ({ id: r.id, title: r.title, seller: r.shop_name })), shops: shops.rows, categories: cats.rows };
  });

  app.get('/api/products/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = (await pool.query(`SELECT p.*, s.name AS shop_name, s.slug AS shop_slug, s.city, s.region, s.rating_avg, s.rating_count, s.processing_days_min, s.processing_days_max, s.policies, s.badges, s.vacation_mode, s.logo_media_id, s.look, se.verification_tier
      FROM products p JOIN shops s ON s.id=p.shop_id JOIN sellers se ON se.id=p.seller_id WHERE p.id=$1 AND ${VISIBLE}`, [id])).rows[0]; if (!p) throw new HttpError(404, 'not_found');
    const cat = p.category_id ? await categoryInfo(pool, p.category_id) : null;
    const options = (await pool.query(`SELECT o.id, o.name, o.position, coalesce(json_agg(json_build_object('value',v.value,'swatch',v.swatch,'default',v.is_default) ORDER BY v.position) FILTER (WHERE v.value IS NOT NULL),'[]') AS values
      FROM product_options o LEFT JOIN product_option_values v ON v.option_id=o.id WHERE o.product_id=$1 GROUP BY o.id ORDER BY o.position`, [id])).rows;
    const variants = (await pool.query(`SELECT id, sku, options, price_cents, compare_at_cents, tracks_stock, stock_on_hand - stock_reserved AS left, image_media_id, position FROM variants WHERE product_id=$1 AND status='active' ORDER BY position, price_cents`, [id])).rows;
    const media = (await pool.query(`SELECT m.id, m.kind, m.width, m.height, m.blur, m.duration_s FROM product_media pm JOIN media m ON m.id=pm.media_id WHERE pm.product_id=$1 ORDER BY pm.position`, [id])).rows;
    const attrs = (await pool.query('SELECT key, value FROM product_attribute_values WHERE product_id=$1', [id])).rows; const defs = new Map((cat?.defs ?? []).map(d => [d.key, d]));
    const attributes = attrs.map(a => { const d = defs.get(a.key); const lab = (v: string) => d?.options?.find(o => o.value === v)?.label ?? v;
      const display = d?.type === 'boolean' ? (a.value ? 'Yes' : 'No') : Array.isArray(a.value) ? a.value.map(lab).join(', ') : d?.type === 'select' ? lab(a.value) : d?.type === 'number' && d.unit ? `${a.value} ${d.unit}` : String(a.value);
      return { key: a.key, label: d?.label ?? a.key.replace(/_/g, ' '), value: a.value, display }; });
    const [more, similar] = await Promise.all([
      pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${VISIBLE} AND p.shop_id=$1 AND p.id<>$2 ORDER BY p.created_at DESC LIMIT 4`, [p.shop_id, id]),
      pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${VISIBLE} AND p.id<>$2 AND p.id IN (SELECT product_id FROM product_categories WHERE category_id = $1) ORDER BY p.sales_count DESC, p.created_at DESC LIMIT 4`, [p.category_id, id])]);
    const oneLeft = p.one_of_a_kind && variants.some(v => v.left > 0);
    return {
      id: p.id, title: p.title, description: p.description, chip: p.chip_override ?? (p.one_of_a_kind ? 'One of a kind' : p.handmade ? (p.made_in ? `Handmade · Made in ${p.made_in}` : 'Handmade') : null), handmade: p.handmade, madeIn: p.made_in, condition: p.condition,
      oneOfAKind: p.one_of_a_kind, onlyOne: oneLeft, madeToOrder: p.made_to_order, leadTimeDays: p.lead_time_days, dangerousGoods: p.dangerous_goods, personalisation: p.personalisation, art: p.art_kind ? { kind: p.art_kind, tone: p.art_tone ?? 'warm' } : null,
      category: cat ? { slug: cat.slug, name: cat.name, breadcrumbs: cat.chain.map(x => ({ slug: x.slug, name: x.name })) } : null,
      shop: { name: p.shop_name, slug: p.shop_slug, city: p.city, region: p.region, logo: mediaUrl(p.logo_media_id, 'w320'), rating: p.rating_count > 0 ? { avg: Number(p.rating_avg), count: p.rating_count } : null, look: p.look, verifiedMaker: p.verification_tier === 'verified_maker', badges: p.badges, vacation: p.vacation_mode },
      processing: { minDays: p.processing_days_min, maxDays: p.processing_days_max }, returns: (p.policies as any)?.returns ?? null,
      options: options.map(o => ({ name: o.name, values: o.values })), defaultOptions: Object.fromEntries(options.map((o: any) => [o.name, (o.values.find((x: any) => x.default) ?? o.values[0])?.value])),
      variants: variants.map(v => ({ id: v.id, sku: v.sku, options: v.options, priceCents: v.price_cents, compareAtCents: v.compare_at_cents, available: !v.tracks_stock || v.left > 0, left: v.tracks_stock && v.left > 0 && (v.left <= 5 || p.one_of_a_kind) ? v.left : null, image: mediaUrl(v.image_media_id, 'w640') })),
      media: media.map(m => m.kind === 'image' ? { id: m.id, kind: 'image', width: m.width, height: m.height, blur: m.blur, w320: mediaUrl(m.id, 'w320'), w640: mediaUrl(m.id, 'w640'), w1280: mediaUrl(m.id, 'w1280') } : { id: m.id, kind: 'video', duration: Number(m.duration_s), src: mediaUrl(m.id, 'video'), poster: mediaUrl(m.id, 'poster') }),
      attributes, moreFromShop: more.rows.map(toCard), similar: similar.rows.map(toCard),
    };
  });

  app.get('/api/shops/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    const s = (await pool.query(`SELECT s.*, se.verification_tier, (SELECT count(*) FROM products p WHERE p.shop_id=s.id AND p.status='published' AND p.moderation_status<>'removed')::int AS product_count
      FROM shops s JOIN sellers se ON se.id=s.seller_id WHERE s.slug=$1 AND s.status='live' AND se.status='active'`, [slug])).rows[0]; if (!s) throw new HttpError(404, 'not_found');
    void pool.query('INSERT INTO shop_views(shop_id,day,views) VALUES ($1,current_date,1) ON CONFLICT (shop_id,day) DO UPDATE SET views=shop_views.views+1', [s.id]).catch(() => {});       // page views for the studio
    return { name: s.name, slug: s.slug, tagline: s.tagline, story: s.story, city: s.city, region: s.region, look: s.look, logo: mediaUrl(s.logo_media_id, 'w320'), banner: mediaUrl(s.banner_media_id, 'w1280'),
      badges: s.badges, verifiedMaker: s.verification_tier === 'verified_maker', rating: s.rating_count > 0 ? { avg: Number(s.rating_avg), count: s.rating_count } : null, vacation: s.vacation_mode,
      policies: s.policies, processing: { minDays: s.processing_days_min, maxDays: s.processing_days_max }, productCount: s.product_count };
  });

  // Public media: only what is attached to something live (a published product, a live shop's logo or banner). Owners see drafts through /api/studio/media.
  app.get('/api/media/:id/:label', async (req, reply) => {
    const { id, label } = z.object({ id: z.string().uuid(), label: z.enum(['w320', 'w640', 'w1280', 'video', 'poster']) }).parse(req.params);
    const ok = (await pool.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM product_media pm JOIN products p ON p.id=pm.product_id JOIN shops s ON s.id=p.shop_id WHERE pm.media_id=$1 AND p.status='published' AND p.moderation_status<>'removed' AND s.status='live')
      OR EXISTS (SELECT 1 FROM shops s WHERE s.status='live' AND (s.logo_media_id=$1 OR s.banner_media_id=$1))
      OR EXISTS (SELECT 1 FROM variants v JOIN products p ON p.id=v.product_id WHERE v.image_media_id=$1 AND p.status='published')`, [id])).rowCount; if (!ok) throw new HttpError(404, 'not_found');
    return sendMedia(req, reply, id, label);
  });
}

/** Serves bytes with long-lived caching and HTTP Range support (video scrubbing, resumable downloads). */
export async function sendMedia(req: any, reply: any, id: string, label: string) {
  const m = await readMedia(id, label); if (!m) throw new HttpError(404, 'not_found');
  reply.header('content-type', m.mime).header('accept-ranges', 'bytes').header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff');
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '')); const size = m.data.length;
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]); let end = range[1] && range[2] ? Number(range[2]) : size - 1; end = Math.min(end, size - 1);
    if (start < 0 || start >= size || start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(m.data.subarray(start, end + 1));
  }
  return reply.header('content-length', size).send(m.data);
}
