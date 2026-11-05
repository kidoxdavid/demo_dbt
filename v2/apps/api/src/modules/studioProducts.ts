import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, q, tx, type Client } from '../db.js';
import { HttpError } from '../errors.js';
import { categoryInfo, validateAttributes } from '../lib/attributes.js';
import { checkProhibited } from '../lib/prohibited.js';
import { sellerCtx } from './studio.js';

const idp = z.object({ id: z.string().uuid() });
const tags = z.array(z.string().trim().toLowerCase().min(1).max(30)).max(13);
const optionsIn = z.array(z.object({ name: z.string().trim().min(1).max(40), values: z.array(z.object({ value: z.string().trim().min(1).max(60), swatch: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), default: z.boolean().optional() }).strict()).min(1).max(30) }).strict()).max(3);
const productPatch = z.object({
  title: z.string().trim().max(140), description: z.string().max(10000), categorySlug: z.string().regex(/^[a-z0-9-]+$/), extraCategorySlugs: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(3),
  condition: z.enum(['new', 'used', 'vintage']), handmade: z.boolean(), madeIn: z.string().trim().max(60).nullable(), taxClass: z.enum(['standard', 'exempt']),
  oneOfAKind: z.boolean(), madeToOrder: z.boolean(), leadTimeDays: z.number().int().min(1).max(120).nullable(), weeklyCapacity: z.number().int().min(1).max(10000).nullable(),
  tags, attributes: z.record(z.string(), z.unknown()), mediaIds: z.array(z.string().uuid()).max(11),
  priceCents: z.number().int().min(0).max(100_000_000), compareAtCents: z.number().int().min(1).max(100_000_000).nullable(), stock: z.number().int().min(0).max(1_000_000), weightG: z.number().int().min(0).max(100_000).nullable(),
  personalisation: z.array(z.object({ label: z.string().trim().min(1).max(60), type: z.enum(['text', 'textarea']), required: z.boolean(), maxLength: z.number().int().min(1).max(500).optional() }).strict()).max(5),
}).partial().strict();

async function ownProduct(c: Client | typeof pool, id: string, sellerId: string, lock = false) {
  const p = (await c.query(`SELECT * FROM products WHERE id=$1 AND seller_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, sellerId])).rows[0]; if (!p) throw new HttpError(404, 'not_found'); return p;
}
const oneLeftError = (e: any) => { if (e?.message === 'one_of_a_kind_stock') throw new HttpError(422, 'one_of_a_kind_needs_single_item'); if (e?.message === 'one_of_a_kind_variants') throw new HttpError(422, 'one_of_a_kind_needs_single_variant'); throw e; };

/** Is this product ready to go live? One list of plain reasons, used for the live checklist AND to block publishing. */
async function readiness(c: Client | typeof pool, p: any, acknowledged = false) {
  const problems: { field: string; code: string; message: string; detail?: unknown }[] = []; const add = (field: string, code: string, message: string, detail?: unknown) => problems.push({ field, code, message, detail });
  if (p.title.trim().length < 3) add('title', 'title_required', 'Give it a title (at least 3 letters).');
  const media = (await c.query(`SELECT count(*) FILTER (WHERE m.kind='image')::int AS images FROM product_media pm JOIN media m ON m.id=pm.media_id WHERE pm.product_id=$1`, [p.id])).rows[0]; if (media.images < 1) add('photos', 'photo_required', 'Add at least one photo.');
  const vs = (await c.query(`SELECT price_cents, stock_on_hand, tracks_stock FROM variants WHERE product_id=$1 AND status='active'`, [p.id])).rows;
  if (!vs.length) add('price', 'variant_required', 'Add a price.'); else if (vs.some(v => v.price_cents <= 0)) add('price', 'price_required', 'Every option needs a price above $0.');
  if (!p.made_to_order && vs.length && vs.every(v => v.stock_on_hand === 0)) add('stock', 'stock_required', 'Add how many you have. Use made to order if you make it after it sells.');
  if (p.made_to_order && !p.lead_time_days) add('leadTime', 'lead_time_required', 'Say how many days it takes you to make it.');
  let cat = null; if (!p.category_id) add('category', 'category_required', 'Choose a category.'); else {
    cat = await categoryInfo(c, p.category_id); const have = Object.fromEntries((await c.query('SELECT key, value FROM product_attribute_values WHERE product_id=$1', [p.id])).rows.map(r => [r.key, r.value]));
    if (cat) { for (const x of validateAttributes(cat, have, { publish: true }).problems) add(`attr.${x.key}`, x.problem === 'required' ? 'attribute_required' : x.problem, x.problem === 'required' ? `${cat.defs.find(d => d.key === x.key)?.label ?? x.key} is needed for this category.` : 'Check this detail.');
      if (cat.slug === 'hair-wigs' && have.hair_type === 'human' && !have.origin) add('attr.origin', 'origin_required', 'Human hair needs a sourcing statement (where it came from).');
      if (cat.restricted && !acknowledged) add('acknowledgement', 'acknowledgement_required', `${cat.name} has extra rules. Please read them and confirm.`, { sellerTips: (await c.query('SELECT seller_tips FROM categories WHERE id=$1', [cat.id])).rows[0]?.seller_tips }); }
  }
  const bad = checkProhibited(p.title, p.description, (p.tags ?? []).join(' ')); if (bad) add('title', `prohibited_item:${bad.reason}`, bad.message, { match: bad.match });
  return { ready: problems.length === 0, problems, category: cat };
}

async function productView(c: Client | typeof pool, p: any) {
  const cat = p.category_id ? await categoryInfo(c, p.category_id) : null;
  const options = (await c.query(`SELECT o.name, coalesce(json_agg(json_build_object('value',v.value,'swatch',v.swatch,'default',v.is_default) ORDER BY v.position) FILTER (WHERE v.value IS NOT NULL),'[]') AS values FROM product_options o LEFT JOIN product_option_values v ON v.option_id=o.id WHERE o.product_id=$1 GROUP BY o.id ORDER BY o.position`, [p.id])).rows;
  const variants = (await c.query(`SELECT id, sku, options, price_cents AS "priceCents", compare_at_cents AS "compareAtCents", tracks_stock AS "tracksStock", stock_on_hand AS stock, stock_reserved AS reserved, image_media_id AS "imageMediaId", weight_g AS "weightG", position
    FROM variants WHERE product_id=$1 AND status='active' ORDER BY position, price_cents`, [p.id])).rows;
  const media = (await c.query(`SELECT m.id, m.kind, m.width, m.height, m.blur FROM product_media pm JOIN media m ON m.id=pm.media_id WHERE pm.product_id=$1 ORDER BY pm.position`, [p.id])).rows
    .map(m => ({ ...m, url: m.kind === 'image' ? `/api/studio/media/${m.id}/w640` : `/api/studio/media/${m.id}/poster` }));
  const attributes = Object.fromEntries((await c.query('SELECT key, value FROM product_attribute_values WHERE product_id=$1', [p.id])).rows.map(r => [r.key, r.value]));
  const extra = (await c.query(`SELECT c.slug FROM product_categories pc JOIN categories c ON c.id=pc.category_id WHERE pc.product_id=$1 AND pc.category_id IS DISTINCT FROM $2`, [p.id, p.category_id])).rows.map(r => r.slug);
  const r = await readiness(c, p, true);
  return { id: p.id, title: p.title, description: p.description, status: p.status, moderation: p.moderation_status, categorySlug: cat?.slug ?? null, extraCategorySlugs: extra, condition: p.condition, handmade: p.handmade, madeIn: p.made_in, taxClass: p.tax_class,
    oneOfAKind: p.one_of_a_kind, madeToOrder: p.made_to_order, leadTimeDays: p.lead_time_days, weeklyCapacity: p.weekly_capacity, tags: p.tags, personalisation: p.personalisation, dangerousGoods: p.dangerous_goods, attributes, media, options, variants,
    category: cat && { slug: cat.slug, name: cat.name, restricted: cat.restricted, attributes: cat.defs }, readiness: { ready: r.ready, problems: r.problems.filter(x => x.code !== 'acknowledgement_required') }, updatedAt: p.updated_at, publishedAt: p.published_at };
}

/** Rebuild a product's variant table from its options, keeping price and stock for combinations that already existed. */
async function rebuildVariants(c: Client, p: any, options: z.infer<typeof optionsIn>) {
  const names = options.map(o => o.name.toLowerCase()); if (new Set(names).size !== names.length) throw new HttpError(422, 'duplicate_option_name');
  for (const o of options) if (new Set(o.values.map(v => v.value.toLowerCase())).size !== o.values.length) throw new HttpError(422, 'duplicate_option_value');
  const combos = options.reduce<Record<string, string>[]>((acc, o) => acc.flatMap(a => o.values.map(v => ({ ...a, [o.name]: v.value }))), [{}]); if (combos.length > 100) throw new HttpError(422, 'too_many_variants');
  await c.query('DELETE FROM product_options WHERE product_id=$1', [p.id]);
  for (const [i, o] of options.entries()) { const r = await c.query('INSERT INTO product_options(product_id,position,name) VALUES ($1,$2,$3) RETURNING id', [p.id, i, o.name]);
    for (const [j, v] of o.values.entries()) await c.query('INSERT INTO product_option_values(option_id,position,value,swatch,is_default) VALUES ($1,$2,$3,$4,$5)', [r.rows[0].id, j, v.value, v.swatch ?? null, !!v.default && !o.values.slice(0, j).some(x => x.default)]); }
  const existing = (await c.query(`SELECT id, options, price_cents, compare_at_cents, stock_on_hand, tracks_stock, weight_g, status FROM variants WHERE product_id=$1 ORDER BY position`, [p.id])).rows;
  const seed = existing.find(v => v.status === 'active') ?? existing[0]; const keep = new Set<string>();
  for (const [i, combo] of combos.entries()) {
    const key = JSON.stringify(Object.fromEntries(Object.entries(combo).sort())); const hit = existing.find(v => JSON.stringify(Object.fromEntries(Object.entries(v.options).sort())) === key);
    if (hit) { keep.add(hit.id); await c.query(`UPDATE variants SET status='active', position=$2 WHERE id=$1`, [hit.id, i]); }
    else { const r = await c.query(`INSERT INTO variants(product_id,position,options,price_cents,compare_at_cents,stock_on_hand,tracks_stock,weight_g) VALUES ($1,$2,$3,$4,$5,0,$6,$7) RETURNING id`,
      [p.id, i, JSON.stringify(combo), seed?.price_cents ?? 0, seed?.compare_at_cents ?? null, !p.made_to_order, seed?.weight_g ?? null]).catch(oneLeftError); keep.add(r.rows[0].id); }
  }
  await c.query(`UPDATE variants SET status='archived' WHERE product_id=$1 AND NOT (id = ANY($2::uuid[]))`, [p.id, [...keep]]);
}

export function registerStudioProducts(app: FastifyInstance) {
  app.get('/api/studio/products', async (req) => {
    const s = await sellerCtx(req, 'seller.products.read'); const f = z.object({ status: z.enum(['draft', 'published', 'hidden']).optional(), q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, c => '\\' + c)}%` : null;
    const rows = (await q(`SELECT p.id, p.title, p.status, p.moderation_status, p.one_of_a_kind, p.made_to_order, p.updated_at, p.art_kind, p.art_tone,
        (SELECT min(price_cents) FROM variants v WHERE v.product_id=p.id AND v.status='active') AS min_price, (SELECT max(price_cents) FROM variants v WHERE v.product_id=p.id AND v.status='active') AS max_price,
        (SELECT coalesce(sum(stock_on_hand - stock_reserved),0)::int FROM variants v WHERE v.product_id=p.id AND v.status='active' AND tracks_stock) AS stock,
        (SELECT pm.media_id FROM product_media pm JOIN media m ON m.id=pm.media_id AND m.kind='image' WHERE pm.product_id=p.id ORDER BY pm.position LIMIT 1) AS cover, count(*) OVER()::int AS total
      FROM products p WHERE p.seller_id=$1 AND ($2::text IS NULL OR p.status=$2) AND ($3::text IS NULL OR p.title ILIKE $3 ESCAPE '\\') ORDER BY p.updated_at DESC LIMIT $4 OFFSET $5`, [s.sellerId, f.status ?? null, like, f.limit, f.offset])).rows;
    return { total: rows[0]?.total ?? 0, items: rows.map(r => ({ id: r.id, title: r.title || 'Untitled', status: r.status, moderation: r.moderation_status, oneOfAKind: r.one_of_a_kind, madeToOrder: r.made_to_order, minPriceCents: r.min_price, maxPriceCents: r.max_price, stock: r.stock, cover: r.cover ? `/api/studio/media/${r.cover}/w320` : null, art: r.art_kind ? { kind: r.art_kind, tone: r.art_tone } : null, updatedAt: r.updated_at })) };
  });

  app.get('/api/studio/products/:id', async (req) => { const s = await sellerCtx(req, 'seller.products.read'); const { id } = idp.parse(req.params); return productView(pool, await ownProduct(pool, id, s.sellerId)); });

  /** Create a draft. Every field is optional: photo-first sign-up saves a draft the moment there is anything to save. */
  app.post('/api/studio/products', async (req, reply) => {
    const s = await sellerCtx(req, 'seller.products.write'); const b = productPatch.parse(req.body ?? {});
    const id = await tx(async c => { const p = (await c.query('INSERT INTO products(shop_id,seller_id) VALUES ($1,$2) RETURNING *', [s.shopId, s.sellerId])).rows[0];
      await applyPatch(c, p, s.sellerId, b); await audit(c, { actor: s.user.id, area: 'studio', action: 'product.create', entityType: 'product', entityId: p.id, ip: req.ip }); return p.id as string; });
    return reply.code(201).send(await productView(pool, await ownProduct(pool, id, s.sellerId)));
  });

  /** Autosave: send any subset of fields. Price, stock and weight apply to the single default option; sizes and colours use the options endpoint. */
  async function applyPatch(c: Client, p: any, sellerId: string, b: z.infer<typeof productPatch>) {
    const oneOfAKind = b.oneOfAKind ?? p.one_of_a_kind, madeToOrder = b.madeToOrder ?? p.made_to_order;
    if (oneOfAKind && madeToOrder) throw new HttpError(422, 'one_of_a_kind_and_made_to_order');
    let categoryId = p.category_id as string | null;
    if (b.categorySlug) { const r = (await c.query(`SELECT id FROM categories WHERE slug=$1 AND status='active'`, [b.categorySlug])).rows[0]; if (!r) throw new HttpError(422, 'unknown_category'); categoryId = r.id; }
    await c.query(`UPDATE products SET title=coalesce($2,title), description=coalesce($3,description), category_id=$4, condition=coalesce($5,condition), handmade=coalesce($6,handmade), made_in=CASE WHEN $7::boolean THEN $8 ELSE made_in END, tax_class=coalesce($9,tax_class),
      one_of_a_kind=$10, made_to_order=$11, lead_time_days=CASE WHEN $12::boolean THEN $13::int ELSE lead_time_days END, weekly_capacity=CASE WHEN $14::boolean THEN $15::int ELSE weekly_capacity END, tags=coalesce($16,tags), personalisation=coalesce($17::jsonb,personalisation), updated_at=now() WHERE id=$1`,
      [p.id, b.title ?? null, b.description ?? null, categoryId, b.condition ?? null, b.handmade ?? null, 'madeIn' in b, b.madeIn ?? null, b.taxClass ?? null, oneOfAKind, madeToOrder, 'leadTimeDays' in b, b.leadTimeDays ?? null, 'weeklyCapacity' in b, b.weeklyCapacity ?? null, b.tags ? [...new Set(b.tags)] : null, b.personalisation ? JSON.stringify(b.personalisation) : null]);
    if (b.categorySlug || b.extraCategorySlugs) {
      const extra = b.extraCategorySlugs ? (await c.query(`SELECT id FROM categories WHERE slug = ANY($1) AND status='active'`, [b.extraCategorySlugs])).rows.map(r => r.id as string) : (await c.query('SELECT category_id FROM product_categories WHERE product_id=$1 AND category_id IS DISTINCT FROM $2', [p.id, p.category_id])).rows.map(r => r.category_id as string);
      if (b.extraCategorySlugs && extra.length !== new Set(b.extraCategorySlugs).size) throw new HttpError(422, 'unknown_category');
      await c.query('DELETE FROM product_categories WHERE product_id=$1', [p.id]); for (const cid of new Set([...(categoryId ? [categoryId] : []), ...extra])) await c.query('INSERT INTO product_categories(product_id,category_id) VALUES ($1,$2)', [p.id, cid]);
    }
    if (b.attributes) {
      if (!categoryId) throw new HttpError(422, 'category_first'); const info = (await categoryInfo(c, categoryId))!; const { values, problems } = validateAttributes(info, b.attributes);
      if (problems.length) throw new HttpError(422, 'invalid_attributes', problems);
      for (const [k, v] of Object.entries(b.attributes)) if (v === null || v === '' || (Array.isArray(v) && !v.length)) await c.query('DELETE FROM product_attribute_values WHERE product_id=$1 AND key=$2', [p.id, k]);
      for (const [k, v] of Object.entries(values)) await c.query('INSERT INTO product_attribute_values(product_id,key,value) VALUES ($1,$2,$3) ON CONFLICT (product_id,key) DO UPDATE SET value=EXCLUDED.value', [p.id, k, JSON.stringify(v)]);
      if (info.slug === 'perfume-fragrance' && 'flammable' in values) await c.query('UPDATE products SET dangerous_goods=$2 WHERE id=$1', [p.id, !!values.flammable]);
    }
    if (b.mediaIds) {
      const rows = (await c.query('SELECT id, kind FROM media WHERE id = ANY($1::uuid[]) AND seller_id=$2', [b.mediaIds, sellerId])).rows; if (rows.length !== new Set(b.mediaIds).size) throw new HttpError(422, 'media_invalid');
      if (rows.filter(r => r.kind === 'video').length > 1) throw new HttpError(422, 'one_video_only'); if (rows.filter(r => r.kind === 'image').length > 10) throw new HttpError(422, 'too_many_photos');
      await c.query('DELETE FROM product_media WHERE product_id=$1', [p.id]); for (const [i, id] of b.mediaIds.entries()) await c.query('INSERT INTO product_media(product_id,media_id,position) VALUES ($1,$2,$3)', [p.id, id, i]);
    }
    const touches = b.priceCents !== undefined || b.stock !== undefined || b.compareAtCents !== undefined || b.weightG !== undefined || 'oneOfAKind' in b || 'madeToOrder' in b;
    if (touches) {
      const hasOptions = Number((await c.query('SELECT count(*) n FROM product_options WHERE product_id=$1', [p.id])).rows[0].n) > 0;
      if (oneOfAKind && hasOptions) throw new HttpError(422, 'one_of_a_kind_needs_single_variant');
      let v = (await c.query(`SELECT * FROM variants WHERE product_id=$1 AND status='active' ORDER BY position LIMIT 1 FOR UPDATE`, [p.id])).rows[0];
      if (!v && (b.priceCents !== undefined || b.stock !== undefined)) { const cmp = b.compareAtCents ?? null; if (cmp !== null && cmp <= (b.priceCents ?? 0)) throw new HttpError(422, 'compare_at_must_exceed_price');
        v = (await c.query(`INSERT INTO variants(product_id,options,price_cents,compare_at_cents,stock_on_hand,tracks_stock,weight_g) VALUES ($1,'{}',$2,$3,$4,$5,$6) RETURNING *`, [p.id, b.priceCents ?? 0, cmp, Math.min(b.stock ?? 0, oneOfAKind ? 1 : 1_000_000), !madeToOrder, b.weightG ?? null]).catch(oneLeftError)).rows[0]; }
      else if (v) {
        const where = hasOptions ? 'product_id=$1 AND status=\'active\'' : 'id=$1'; const target = hasOptions ? p.id : v.id;     // price and stock edits on a product with options go through the variant endpoints
        if (!hasOptions) { const price = b.priceCents ?? v.price_cents; const cmp = b.compareAtCents !== undefined ? b.compareAtCents : v.compare_at_cents; if (cmp !== null && cmp <= price) throw new HttpError(422, 'compare_at_must_exceed_price');
          const stock = b.stock ?? v.stock_on_hand; if (stock < v.stock_reserved) throw new HttpError(409, 'stock_below_reserved');
          await c.query(`UPDATE variants SET price_cents=$2, compare_at_cents=$3, stock_on_hand=$4, tracks_stock=$5, weight_g=CASE WHEN $6::boolean THEN $7::int ELSE weight_g END WHERE id=$1`, [target, price, cmp, oneOfAKind ? Math.min(stock, 1) : stock, !madeToOrder, 'weightG' in b, b.weightG ?? null]).catch(oneLeftError); }
        else if ('madeToOrder' in b) await c.query(`UPDATE variants SET tracks_stock=$2 WHERE ${where}`, [target, !madeToOrder]);
      }
      if (oneOfAKind && Number((await c.query(`SELECT count(*) n FROM variants WHERE product_id=$1 AND status='active'`, [p.id])).rows[0].n) > 1) throw new HttpError(422, 'one_of_a_kind_needs_single_variant');
    }
  }

  app.patch('/api/studio/products/:id', async (req) => {
    const s = await sellerCtx(req, 'seller.products.write'); const { id } = idp.parse(req.params); const b = productPatch.parse(req.body ?? {});
    return tx(async c => { const p = await ownProduct(c, id, s.sellerId, true); await applyPatch(c, p, s.sellerId, b); await audit(c, { actor: s.user.id, area: 'studio', action: 'product.update', entityType: 'product', entityId: id, next: Object.keys(b), ip: req.ip });
      return productView(c, await ownProduct(c, id, s.sellerId)); });
  });

  app.put('/api/studio/products/:id/options', async (req) => {
    const s = await sellerCtx(req, 'seller.products.write'); const { id } = idp.parse(req.params); const b = z.object({ options: optionsIn }).strict().parse(req.body);
    return tx(async c => { const p = await ownProduct(c, id, s.sellerId, true); if (p.one_of_a_kind && b.options.length) throw new HttpError(422, 'one_of_a_kind_needs_single_variant');
      await rebuildVariants(c, p, b.options); await audit(c, { actor: s.user.id, area: 'studio', action: 'product.options', entityType: 'product', entityId: id, next: b.options.map(o => o.name), ip: req.ip }); return productView(c, await ownProduct(c, id, s.sellerId)); });
  });

  app.post('/api/studio/products/:id/publish', async (req) => {
    const s = await sellerCtx(req, 'seller.products.write'); const { id } = idp.parse(req.params); const b = z.object({ acknowledged: z.boolean().default(false) }).strict().parse(req.body ?? {});
    return tx(async c => {
      const p = await ownProduct(c, id, s.sellerId, true); const r = await readiness(c, p, b.acknowledged);
      if (!r.ready) { const bad = r.problems.find(x => x.code.startsWith('prohibited_item')); throw new HttpError(422, bad ? bad.code : 'not_ready', r.problems); }
      const seller = (await c.query('SELECT status FROM sellers WHERE id=$1', [s.sellerId])).rows[0]; if (seller.status !== 'active') throw new HttpError(403, 'seller_suspended');
      const queued = !!r.category?.restricted;                                  // restricted categories go live now and are reviewed by staff afterwards
      await c.query(`UPDATE products SET status='published', moderation_status=$2, published_at=coalesce(published_at, now()), updated_at=now() WHERE id=$1`, [id, queued ? 'queued' : 'approved']);
      const shop = (await c.query(`UPDATE shops SET status='live', published_at=coalesce(published_at, now()) WHERE id=$1 AND status='draft' RETURNING slug`, [s.shopId])).rows[0];
      await audit(c, { actor: s.user.id, area: 'studio', action: 'product.publish', entityType: 'product', entityId: id, next: { moderation: queued ? 'queued' : 'approved', shopWentLive: !!shop }, ip: req.ip });
      return { ...(await productView(c, await ownProduct(c, id, s.sellerId))), shopWentLive: !!shop, shopSlug: (await c.query('SELECT slug FROM shops WHERE id=$1', [s.shopId])).rows[0].slug };
    });
  });
  app.post('/api/studio/products/:id/unpublish', async (req) => {
    const s = await sellerCtx(req, 'seller.products.write'); const { id } = idp.parse(req.params);
    return tx(async c => { await ownProduct(c, id, s.sellerId, true); await c.query(`UPDATE products SET status='hidden', updated_at=now() WHERE id=$1`, [id]); await audit(c, { actor: s.user.id, area: 'studio', action: 'product.unpublish', entityType: 'product', entityId: id, ip: req.ip }); return productView(c, await ownProduct(c, id, s.sellerId)); });
  });
  /** "Add another like this": copies everything except photos' order of sale history; stock starts at zero so nothing is oversold by accident. */
  app.post('/api/studio/products/:id/duplicate', async (req, reply) => {
    const s = await sellerCtx(req, 'seller.products.write'); const { id } = idp.parse(req.params);
    const newId = await tx(async c => {
      const p = await ownProduct(c, id, s.sellerId); const n = (await c.query(`INSERT INTO products(shop_id,seller_id,title,description,category_id,condition,handmade,made_in,tax_class,one_of_a_kind,made_to_order,lead_time_days,weekly_capacity,personalisation,dangerous_goods,tags,art_kind,art_tone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [p.shop_id, p.seller_id, `${p.title} (copy)`.slice(0, 140), p.description, p.category_id, p.condition, p.handmade, p.made_in, p.tax_class, p.one_of_a_kind, p.made_to_order, p.lead_time_days, p.weekly_capacity, JSON.stringify(p.personalisation), p.dangerous_goods, p.tags, p.art_kind, p.art_tone])).rows[0].id;
      await c.query('INSERT INTO product_categories(product_id,category_id) SELECT $2, category_id FROM product_categories WHERE product_id=$1', [id, n]); await c.query('INSERT INTO product_attribute_values(product_id,key,value) SELECT $2, key, value FROM product_attribute_values WHERE product_id=$1', [id, n]);
      await c.query('INSERT INTO product_media(product_id,media_id,position) SELECT $2, media_id, position FROM product_media WHERE product_id=$1', [id, n]);
      for (const o of (await c.query('SELECT id, position, name FROM product_options WHERE product_id=$1', [id])).rows) { const no = (await c.query('INSERT INTO product_options(product_id,position,name) VALUES ($1,$2,$3) RETURNING id', [n, o.position, o.name])).rows[0].id; await c.query('INSERT INTO product_option_values(option_id,position,value,swatch) SELECT $2, position, value, swatch FROM product_option_values WHERE option_id=$1', [o.id, no]); }
      await c.query(`INSERT INTO variants(product_id,position,sku,options,price_cents,compare_at_cents,tracks_stock,stock_on_hand,image_media_id,weight_g) SELECT $2, position, NULL, options, price_cents, compare_at_cents, tracks_stock, 0, image_media_id, weight_g FROM variants WHERE product_id=$1 AND status='active'`, [id, n]);
      await audit(c, { actor: s.user.id, area: 'studio', action: 'product.duplicate', entityType: 'product', entityId: n, prev: { from: id }, ip: req.ip }); return n as string;
    });
    return reply.code(201).send(await productView(pool, await ownProduct(pool, newId, s.sellerId)));
  });
  app.delete('/api/studio/products/:id', async (req) => {
    const s = await sellerCtx(req, 'seller.products.write'); const { id } = idp.parse(req.params);
    return tx(async c => { const p = await ownProduct(c, id, s.sellerId, true); if (p.status !== 'draft') throw new HttpError(409, 'unpublish_first'); await c.query('DELETE FROM products WHERE id=$1', [id]); await audit(c, { actor: s.user.id, area: 'studio', action: 'product.delete', entityType: 'product', entityId: id, prev: { title: p.title }, ip: req.ip }); return { deleted: true }; });
  });

  // ---- Variants and stock
  const ownVariant = async (c: Client, id: string, sellerId: string) => { const v = (await c.query(`SELECT v.*, p.one_of_a_kind, p.made_to_order FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND p.seller_id=$2 FOR UPDATE OF v`, [id, sellerId])).rows[0]; if (!v) throw new HttpError(404, 'not_found'); return v; };
  app.patch('/api/studio/variants/:id', async (req) => {
    const s = await sellerCtx(req, 'seller.products.write'); const { id } = idp.parse(req.params);
    const b = z.object({ priceCents: z.number().int().min(0).max(100_000_000), compareAtCents: z.number().int().min(1).max(100_000_000).nullable(), stock: z.number().int().min(0).max(1_000_000), sku: z.string().trim().max(60).nullable(), imageMediaId: z.string().uuid().nullable(), weightG: z.number().int().min(0).max(100_000).nullable() }).partial().strict().parse(req.body);
    return tx(async c => {
      const v = await ownVariant(c, id, s.sellerId); const price = b.priceCents ?? v.price_cents; const cmp = 'compareAtCents' in b ? b.compareAtCents : v.compare_at_cents; if (cmp !== null && cmp !== undefined && cmp <= price) throw new HttpError(422, 'compare_at_must_exceed_price');
      const stock = b.stock ?? v.stock_on_hand; if (stock < v.stock_reserved) throw new HttpError(409, 'stock_below_reserved');
      if (b.imageMediaId && !(await c.query('SELECT 1 FROM media WHERE id=$1 AND seller_id=$2 AND kind=\'image\'', [b.imageMediaId, s.sellerId])).rowCount) throw new HttpError(422, 'media_invalid');
      await c.query(`UPDATE variants SET price_cents=$2, compare_at_cents=$3, stock_on_hand=$4, sku=CASE WHEN $5::boolean THEN $6 ELSE sku END, image_media_id=CASE WHEN $7::boolean THEN $8::uuid ELSE image_media_id END, weight_g=CASE WHEN $9::boolean THEN $10::int ELSE weight_g END WHERE id=$1`,
        [id, price, cmp ?? null, stock, 'sku' in b, b.sku ?? null, 'imageMediaId' in b, b.imageMediaId ?? null, 'weightG' in b, b.weightG ?? null]).catch(oneLeftError);
      await audit(c, { actor: s.user.id, area: 'studio', action: 'variant.update', entityType: 'variant', entityId: id, prev: { price: v.price_cents, stock: v.stock_on_hand }, next: { price, stock }, ip: req.ip });
      return (await c.query('SELECT id, sku, options, price_cents AS "priceCents", compare_at_cents AS "compareAtCents", stock_on_hand AS stock, stock_reserved AS reserved FROM variants WHERE id=$1', [id])).rows[0];
    });
  });
  app.post('/api/studio/variants/:id/stock', async (req) => {
    const s = await sellerCtx(req, 'seller.products.write'); const { id } = idp.parse(req.params); const b = z.object({ delta: z.number().int().min(-1_000_000).max(1_000_000).refine(n => n !== 0) }).strict().parse(req.body);
    return tx(async c => { const v = await ownVariant(c, id, s.sellerId); const next = v.stock_on_hand + b.delta; if (next < v.stock_reserved || next < 0) throw new HttpError(409, 'stock_below_reserved');
      await c.query('UPDATE variants SET stock_on_hand=$2 WHERE id=$1', [id, next]).catch(oneLeftError); await audit(c, { actor: s.user.id, area: 'studio', action: 'variant.stock', entityType: 'variant', entityId: id, prev: { stock: v.stock_on_hand }, next: { stock: next }, ip: req.ip }); return { id, stock: next, reserved: v.stock_reserved }; });
  });
  /** Bulk edit price and stock across many products (CSV import joins this in the studio phase). */
  app.post('/api/studio/products/bulk', async (req) => {
    const s = await sellerCtx(req, 'seller.products.write');
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(200), priceChangePercent: z.number().min(-90).max(500).optional(), setPriceCents: z.number().int().min(1).max(100_000_000).optional(), stockDelta: z.number().int().min(-100000).max(100000).optional() }).strict()
      .refine(x => [x.priceChangePercent, x.setPriceCents, x.stockDelta].filter(v => v !== undefined).length === 1, 'Choose exactly one change').parse(req.body);
    return tx(async c => {
      const owned = (await c.query('SELECT id FROM products WHERE id = ANY($1::uuid[]) AND seller_id=$2 FOR UPDATE', [b.ids, s.sellerId])).rows.map(r => r.id as string); if (owned.length !== new Set(b.ids).size) throw new HttpError(404, 'not_found');
      let n = 0;
      if (b.setPriceCents !== undefined) n = (await c.query(`UPDATE variants SET price_cents=$2, compare_at_cents=CASE WHEN compare_at_cents <= $2 THEN NULL ELSE compare_at_cents END WHERE product_id = ANY($1::uuid[]) AND status='active'`, [owned, b.setPriceCents])).rowCount ?? 0;
      if (b.priceChangePercent !== undefined) n = (await c.query(`UPDATE variants SET price_cents=GREATEST(1, round(price_cents * (1 + $2::numeric/100))::int), compare_at_cents=NULL WHERE product_id = ANY($1::uuid[]) AND status='active'`, [owned, b.priceChangePercent])).rowCount ?? 0;
      if (b.stockDelta !== undefined) { const bad = await c.query(`SELECT 1 FROM variants WHERE product_id = ANY($1::uuid[]) AND status='active' AND tracks_stock AND stock_on_hand + $2 < GREATEST(stock_reserved, 0)`, [owned, b.stockDelta]); if (bad.rowCount) throw new HttpError(409, 'stock_below_reserved');
        n = (await c.query(`UPDATE variants SET stock_on_hand=stock_on_hand + $2 WHERE product_id = ANY($1::uuid[]) AND status='active' AND tracks_stock`, [owned, b.stockDelta]).catch(oneLeftError))!.rowCount ?? 0; }
      await audit(c, { actor: s.user.id, area: 'studio', action: 'product.bulk', entityType: 'seller', entityId: s.sellerId, next: { products: owned.length, ...b, ids: undefined }, ip: req.ip }); return { products: owned.length, variantsChanged: n };
    });
  });
}
