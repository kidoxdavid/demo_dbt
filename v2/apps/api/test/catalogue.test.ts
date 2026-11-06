import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { readMedia } from '../src/lib/media.js';
import { ck, jpeg, makeUser, login, studioSeller, tinyMp4, upload, PW } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
type M = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const st = (method: M, url: string, cookie: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', cookie) });
const pub = (url: string) => app.inject({ method: 'GET', url });
/** A seller with one fully valid, published product. */
async function liveShop(opts: { title?: string; category?: string; price?: number; stock?: number; extra?: object; attrs?: object } = {}) {
  const s = await studioSeller(app, { categories: [opts.category ?? 'pottery-ceramics'] });
  const m = (await upload(app, s.cookie, await jpeg())).json();
  const p = (await st('POST', '/api/studio/products', s.cookie, { title: opts.title ?? 'Test mug', categorySlug: opts.category ?? 'pottery-ceramics', priceCents: opts.price ?? 3000, stock: opts.stock ?? 5, mediaIds: [m.id], attributes: opts.attrs ?? {}, ...(opts.extra ?? {}) })).json();
  const r = await st('POST', `/api/studio/products/${p.id}/publish`, s.cookie, { acknowledged: true });
  if (r.statusCode !== 200) throw new Error(`publish failed ${r.statusCode} ${r.body}`);
  return { ...s, productId: p.id as string, mediaId: m.id as string };
}

describe('seller sign-up', () => {
  it('creates the person, seller, draft shop, role and a studio session in one step', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/studio/signup', payload: { email: 'amy@seller.test', password: PW, fullName: 'Amy Potter', categories: ['pottery-ceramics', 'candles-home-fragrance'], shopName: 'Clay & Ember Two' } });
    expect(r.statusCode).toBe(201); expect(r.json().shop).toMatchObject({ slug: 'clay-and-ember-two', name: 'Clay & Ember Two' });
    const cookie = r.cookies.find(c => c.name === 'es_studio')!.value;
    const shop = (await st('GET', '/api/studio/shop', cookie)).json(); expect(shop).toMatchObject({ status: 'draft', slug: 'clay-and-ember-two' }); expect(shop.categories.map((c: any) => c.slug)).toEqual(['pottery-ceramics', 'candles-home-fragrance']);
    expect(shop.categories[0].sellerTips).toMatch(/food-safe/); expect(shop.policyTemplates.standard).toMatch(/14 days/);
    expect((await q(`SELECT role FROM user_roles WHERE user_id=(SELECT id FROM users WHERE email='amy@seller.test')`)).rows).toEqual([{ role: 'seller_owner' }]);
    const again = await app.inject({ method: 'POST', url: '/api/studio/signup', payload: { email: 'amy2@seller.test', password: PW, fullName: 'Amy Two', categories: ['jewellery'], shopName: 'Clay & Ember Two' } }); expect(again.json().shop.slug).toBe('clay-and-ember-two-2');
    expect((await app.inject({ method: 'GET', url: '/api/me', ...ck('shop', cookie) })).statusCode).toBe(401);                       // the studio session is not a shop session
  });
  it('refuses weak passwords, duplicates, unknown categories and no categories', async () => {
    const p = { email: 'dup@seller.test', password: PW, fullName: 'D', categories: ['jewellery'] }; const go = (x: object) => app.inject({ method: 'POST', url: '/api/studio/signup', payload: { ...p, ...x } });
    expect((await go({ password: 'short' })).json().error).toBe('weak_password:too_short'); expect((await go({ categories: [] })).statusCode).toBe(400); expect((await go({ categories: ['nope'] })).json().error).toBe('unknown_category');
    expect((await go({})).statusCode).toBe(201); expect((await go({})).json().error).toBe('email_in_use');
  });
  it('shop settings: identity, look, policies from templates, validation, and only owners and managers write', async () => {
    const s = await studioSeller(app); const logo = (await upload(app, s.cookie, await jpeg(200, 200))).json();
    const r = await st('PATCH', '/api/studio/shop', s.cookie, { tagline: 'Wheel-thrown stoneware', look: 'sage', city: 'Calgary', region: 'AB', logoMediaId: logo.id, policies: { returns: { template: 'final_sale' } }, processingDaysMin: 1, processingDaysMax: 4 });
    expect(r.json()).toMatchObject({ look: 'sage', tagline: 'Wheel-thrown stoneware', processing: { minDays: 1, maxDays: 4 } }); expect(r.json().policies.returns.text).toMatch(/final/); expect(r.json().logo).toContain(logo.id);
    expect((await st('PATCH', '/api/studio/shop', s.cookie, { look: 'neon' })).statusCode).toBe(400); expect((await st('PATCH', '/api/studio/shop', s.cookie, { processingDaysMin: 5, processingDaysMax: 2 })).json().error).toBe('processing_range_invalid');
    expect((await st('PATCH', '/api/studio/shop', s.cookie, { slug: 'admin' })).json().error).toBe('slug_unavailable'); const other = await studioSeller(app); const otherLogo = (await upload(app, other.cookie, await jpeg(50, 50))).json();
    expect((await st('PATCH', '/api/studio/shop', s.cookie, { logoMediaId: otherLogo.id })).json().error).toBe('logoMediaId_invalid');                    // someone else's photo
    const staff = await login(app, 'studio', { role: 'seller_staff', sellerId: s.sellerId }); expect((await st('PATCH', '/api/studio/shop', staff.cookie, { look: 'noir' })).json().error).toBe('forbidden');
    expect((await st('GET', '/api/studio/shop', staff.cookie)).statusCode).toBe(200);
  });
});

describe('media pipeline', () => {
  it('makes three WebP sizes, strips location data, fixes orientation, and keeps a disk copy and a database copy', async () => {
    const s = await studioSeller(app);
    const withGps = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#336699' } }).withExif({ IFD0: { Copyright: 'x' }, IFD3: { GPSLatitudeRef: 'N' } }).jpeg().toBuffer();
    const r = await upload(app, s.cookie, withGps); expect(r.statusCode).toBe(201); const m = r.json(); expect(m).toMatchObject({ kind: 'image', width: 1280, height: 720 }); expect(m.blur).toMatch(/^data:image\/webp/);
    for (const [label, w] of [['w320', 320], ['w640', 640], ['w1280', 1280]] as const) { const f = await readMedia(m.id, label); const meta = await sharp(f!.data).metadata(); expect(meta.format).toBe('webp'); expect(meta.width).toBe(w); expect(meta.exif).toBeUndefined(); }
    expect((await q('SELECT count(*)::int n FROM media_files WHERE media_id=$1', [m.id])).rows[0].n).toBe(3);
    await rm(join('/tmp/es2-test-uploads', m.id), { recursive: true, force: true }); expect((await readMedia(m.id, 'w640'))!.data.length).toBeGreaterThan(100); // disk copy gone: served from the database and written back
    const rotated = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#aa3333' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer(); const r2 = (await upload(app, s.cookie, rotated)).json(); expect([r2.width, r2.height]).toEqual([200, 400]);
  });
  it('trusts the bytes, not the label: fake, corrupt and oversize files are refused', async () => {
    const s = await studioSeller(app);
    expect((await upload(app, s.cookie, Buffer.from('<script>alert(1)</script> not an image at all'), 'image/jpeg')).json().error).toBe('unsupported_media_type');
    expect((await upload(app, s.cookie, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]), 'image/jpeg')).json().error).toBe('unreadable_image');
    expect((await upload(app, s.cookie, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10 * 1024 * 1024 + 10, 1)]))).json().error).toBe('image_too_large');
    expect((await app.inject({ method: 'POST', url: '/api/studio/media', headers: { 'content-type': 'text/html' }, payload: '<b>x</b>', ...ck('studio', s.cookie) })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/api/studio/media', headers: { 'content-type': 'image/jpeg' }, payload: await jpeg() })).statusCode).toBe(401);
  });
  it('converts a video to web MP4 with a poster, and refuses broken ones', async () => {
    const s = await studioSeller(app); const r = await upload(app, s.cookie, tinyMp4(2), 'video/mp4'); expect(r.statusCode).toBe(201); const m = r.json(); expect(m.kind).toBe('video'); expect(m.duration).toBeGreaterThan(1.5);
    const v = await readMedia(m.id, 'video'); expect(v!.mime).toBe('video/mp4'); expect(v!.data.toString('latin1', 4, 8)).toBe('ftyp'); expect((await sharp((await readMedia(m.id, 'poster'))!.data).metadata()).format).toBe('webp');
    expect((await upload(app, s.cookie, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(300, 3)]), 'video/mp4')).json().error).toBe('unreadable_video');
  }, 60_000);
  it('public media only serves what is live; owners see their own drafts; Range requests work', async () => {
    const s = await studioSeller(app); const other = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
    expect((await pub(`/api/media/${m.id}/w640`)).statusCode).toBe(404); expect((await st('GET', `/api/studio/media/${m.id}/w640`, s.cookie)).statusCode).toBe(200); expect((await st('GET', `/api/studio/media/${m.id}/w640`, other.cookie)).statusCode).toBe(404);
    const p = (await st('POST', '/api/studio/products', s.cookie, { title: 'Range test', categorySlug: 'pottery-ceramics', priceCents: 1000, stock: 1, mediaIds: [m.id] })).json(); await st('POST', `/api/studio/products/${p.id}/publish`, s.cookie, { acknowledged: true });
    const full = await pub(`/api/media/${m.id}/w640`); expect(full.statusCode).toBe(200); expect(full.headers['content-type']).toBe('image/webp'); expect(full.headers['accept-ranges']).toBe('bytes'); expect(full.headers['cache-control']).toMatch(/immutable/);
    const part = await app.inject({ method: 'GET', url: `/api/media/${m.id}/w640`, headers: { range: 'bytes=0-9' } }); expect(part.statusCode).toBe(206); expect(part.rawPayload.length).toBe(10); expect(part.headers['content-range']).toBe(`bytes 0-9/${full.rawPayload.length}`);
    expect((await app.inject({ method: 'GET', url: `/api/media/${m.id}/w640`, headers: { range: 'bytes=999999999-' } })).statusCode).toBe(416); expect((await pub(`/api/media/${m.id}/huge`)).statusCode).toBe(400);
    await st('POST', `/api/studio/products/${p.id}/unpublish`, s.cookie); expect((await pub(`/api/media/${m.id}/w640`)).statusCode).toBe(404);          // hidden again
  });
});

describe('products: drafts, readiness and publishing', () => {
  it('a draft autosaves piece by piece, tells the seller what is missing, and publishing makes the shop live', async () => {
    const s = await studioSeller(app); const empty = (await st('POST', '/api/studio/products', s.cookie, {})).json(); expect(empty).toMatchObject({ status: 'draft', title: '' }); expect(empty.readiness.ready).toBe(false);
    const p1 = (await st('PATCH', `/api/studio/products/${empty.id}`, s.cookie, { title: 'Tall bud vase', categorySlug: 'pottery-ceramics', priceCents: 4800, stock: 6, handmade: true, madeIn: 'Alberta', attributes: { technique: 'wheel-thrown', dishwasher_safe: false } })).json();
    expect(p1.variants).toHaveLength(1); expect(p1.variants[0]).toMatchObject({ priceCents: 4800, stock: 6 }); expect(p1.attributes).toMatchObject({ technique: 'wheel-thrown' }); expect(p1.readiness.problems.map((x: any) => x.code)).toEqual(['photo_required']);
    const pub0 = await st('POST', `/api/studio/products/${empty.id}/publish`, s.cookie, {}); expect(pub0.statusCode).toBe(422); expect(pub0.json().error).toBe('not_ready'); expect((await pub(`/api/products/${empty.id}`)).statusCode).toBe(404);   // drafts are invisible
    const m = (await upload(app, s.cookie, await jpeg())).json(); await st('PATCH', `/api/studio/products/${empty.id}`, s.cookie, { mediaIds: [m.id] });
    const live = await st('POST', `/api/studio/products/${empty.id}/publish`, s.cookie, {}); expect(live.statusCode).toBe(200); expect(live.json()).toMatchObject({ status: 'published', moderation: 'approved', shopWentLive: true });
    expect((await pub(`/api/shops/${s.shop.slug}`)).json()).toMatchObject({ name: s.shop.name, productCount: 1 }); expect((await pub(`/api/products/${empty.id}`)).json()).toMatchObject({ title: 'Tall bud vase', chip: 'Handmade · Made in Alberta' });
    expect((await st('POST', `/api/studio/products/${empty.id}/unpublish`, s.cookie)).json().status).toBe('hidden'); expect((await pub(`/api/products/${empty.id}`)).statusCode).toBe(404);
  });
  it('attributes are checked against the category: types, choices, units, required ones at publish, free-form only for Other', async () => {
    const s = await studioSeller(app, { categories: ['perfume-fragrance'] }); const m = (await upload(app, s.cookie, await jpeg())).json();
    const p = (await st('POST', '/api/studio/products', s.cookie, { title: 'Amber oud', categorySlug: 'perfume-fragrance', priceCents: 9600, stock: 3, mediaIds: [m.id] })).json();
    for (const bad of [{ volume_ml: 'fifty' }, { concentration: 'strong' }, { flammable: 'yes' }, { nonsense: 1 }, { fragrance_family: ['floral'] }]) expect((await st('PATCH', `/api/studio/products/${p.id}`, s.cookie, { attributes: bad })).json().error).toBe('invalid_attributes');
    const missing = await st('POST', `/api/studio/products/${p.id}/publish`, s.cookie, { acknowledged: true }); expect(missing.json().detail.map((x: any) => x.field).sort()).toEqual(['attr.flammable', 'attr.volume_ml']);
    await st('PATCH', `/api/studio/products/${p.id}`, s.cookie, { attributes: { volume_ml: 50, flammable: true, concentration: 'eau-de-parfum', notes: 'Oud' } });
    expect((await st('POST', `/api/studio/products/${p.id}/publish`, s.cookie, {})).json().detail.map((x: any) => x.code)).toEqual(['acknowledgement_required']);                // restricted category
    const ok = await st('POST', `/api/studio/products/${p.id}/publish`, s.cookie, { acknowledged: true }); expect(ok.json()).toMatchObject({ status: 'published', moderation: 'queued', dangerousGoods: true });
    expect((await pub(`/api/products/${p.id}`)).statusCode).toBe(200);                                                                                                                  // live now, reviewed afterwards
    const o = await studioSeller(app, { categories: ['other'] }); const q2 = (await st('POST', '/api/studio/products', o.cookie, { title: 'Wooden spoon', categorySlug: 'other', attributes: { wood_type: 'maple' } })).json(); expect(q2.attributes).toEqual({ wood_type: 'maple' });
  });
  it('prohibited items are stopped with a plain reason; human hair needs a sourcing statement', async () => {
    const s = await studioSeller(app, { categories: ['hair-wigs'] }); const m = (await upload(app, s.cookie, await jpeg())).json();
    const mk = async (title: string, extra: object = {}) => (await st('POST', '/api/studio/products', s.cookie, { title, categorySlug: 'hair-wigs', priceCents: 5000, stock: 2, mediaIds: [m.id], attributes: { length_in: 16, hair_type: 'synthetic' }, ...extra })).json().id as string;
    for (const [title, reason] of [['Rolex replica watch', 'counterfeit'], ['Pokémon plush 20 cm', 'ip_infringement'], ['Hunting rifle ammo', 'weapons'], ['Vape pods', 'regulated_goods']] as const) {
      const r = await st('POST', `/api/studio/products/${await mk(title)}/publish`, s.cookie, { acknowledged: true }); expect(r.statusCode).toBe(422); expect(r.json().error).toBe(`prohibited_item:${reason}`); }
    const human = await mk('Human hair bundle', { attributes: { length_in: 16, hair_type: 'human' } }); const r = await st('POST', `/api/studio/products/${human}/publish`, s.cookie, { acknowledged: true }); expect(r.json().detail.map((x: any) => x.code)).toEqual(['origin_required']);
    await st('PATCH', `/api/studio/products/${human}`, s.cookie, { attributes: { origin: 'Sourced from a family farm in Vietnam' } }); expect((await st('POST', `/api/studio/products/${human}/publish`, s.cookie, { acknowledged: true })).statusCode).toBe(200);
  });
  it('sellers only touch their own products, staff roles are limited, and suspended sellers cannot publish', async () => {
    const a = await liveShop(); const b = await studioSeller(app);
    for (const [method, url] of [['GET', `/api/studio/products/${a.productId}`], ['PATCH', `/api/studio/products/${a.productId}`], ['POST', `/api/studio/products/${a.productId}/unpublish`], ['DELETE', `/api/studio/products/${a.productId}`]] as const)
      expect((await st(method, url, b.cookie, method === 'PATCH' ? { title: 'Hijack' } : undefined)).statusCode).toBe(404);
    const staff = await login(app, 'studio', { role: 'seller_staff', sellerId: a.sellerId }); expect((await st('GET', '/api/studio/products', staff.cookie)).statusCode).toBe(200); expect((await st('POST', '/api/studio/products', staff.cookie, {})).json().error).toBe('forbidden');
    const buyer = await makeUser(app); expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': 'studio' }, payload: { email: buyer.email, password: PW } })).statusCode).toBe(403);
    await q(`UPDATE sellers SET status='suspended' WHERE id=$1`, [a.sellerId]); expect((await pub(`/api/products/${a.productId}`)).statusCode).toBe(404);          // suspended sellers vanish from the storefront
    const d = (await st('POST', '/api/studio/products', a.cookie, { title: 'New', categorySlug: 'pottery-ceramics', priceCents: 100, stock: 1, mediaIds: [a.mediaId] })).json(); expect((await st('POST', `/api/studio/products/${d.id}/publish`, a.cookie, { acknowledged: true })).json().error).toBe('seller_suspended');
  });
});

describe('variants, one-of-a-kind and stock', () => {
  it('options build a variant table that keeps price and stock; archived combinations come back when re-added', async () => {
    const s = await liveShop({ price: 4800, stock: 6 }); const opts = (options: object) => st('PUT', `/api/studio/products/${s.productId}/options`, s.cookie, { options });
    const r = (await opts([{ name: 'Size', values: [{ value: 'Small' }, { value: 'Medium', default: true }, { value: 'Large' }] }, { name: 'Glaze', values: [{ value: 'Terracotta', swatch: '#b8704a', default: true }, { value: 'Oat', swatch: '#e8dccb' }] }])).json();
    expect(r.variants).toHaveLength(6); expect(r.variants.every((v: any) => v.priceCents === 4800)).toBe(true); expect(r.options[0].values.find((v: any) => v.default).value).toBe('Medium');
    const med = r.variants.find((v: any) => v.options.Size === 'Medium' && v.options.Glaze === 'Terracotta'); expect((await st('PATCH', `/api/studio/variants/${med.id}`, s.cookie, { priceCents: 5200, stock: 9, sku: 'VASE-M-T' })).json()).toMatchObject({ priceCents: 5200, stock: 9, sku: 'VASE-M-T' });
    const r2 = (await opts([{ name: 'Size', values: [{ value: 'Medium' }, { value: 'Large' }] }, { name: 'Glaze', values: [{ value: 'Terracotta' }, { value: 'Oat' }] }])).json(); expect(r2.variants).toHaveLength(4); expect(r2.variants.find((v: any) => v.id === med.id).stock).toBe(9);
    const r3 = (await opts([{ name: 'Size', values: [{ value: 'Small' }, { value: 'Medium' }, { value: 'Large' }] }, { name: 'Glaze', values: [{ value: 'Terracotta' }, { value: 'Oat' }] }])).json(); expect(r3.variants).toHaveLength(6);
    expect((await opts([{ name: 'Size', values: [{ value: 'S' }, { value: 's' }] }])).json().error).toBe('duplicate_option_value'); expect((await opts([{ name: 'A', values: [{ value: '1' }] }, { name: 'a', values: [{ value: '1' }] }])).json().error).toBe('duplicate_option_name');
    const big = Array.from({ length: 11 }, (_, i) => ({ value: `v${i}` })); expect((await opts([{ name: 'X', values: big }, { name: 'Y', values: big }])).json().error).toBe('too_many_variants');
    expect((await opts([])).json().variants).toHaveLength(1); const pubd = (await pub(`/api/products/${s.productId}`)).json(); expect(pubd.variants).toHaveLength(1);
  });
  it('a compare-at price must exceed the price, and stock cannot drop below what is reserved', async () => {
    const s = await liveShop({ price: 3000, stock: 5 }); const v = (await st('GET', `/api/studio/products/${s.productId}`, s.cookie)).json().variants[0];
    expect((await st('PATCH', `/api/studio/variants/${v.id}`, s.cookie, { compareAtCents: 2500 })).json().error).toBe('compare_at_must_exceed_price'); expect((await st('PATCH', `/api/studio/variants/${v.id}`, s.cookie, { compareAtCents: 4000 })).statusCode).toBe(200);
    expect((await pub(`/api/products/${s.productId}`)).json().variants[0]).toMatchObject({ priceCents: 3000, compareAtCents: 4000 });
    await q('UPDATE variants SET stock_reserved=3 WHERE id=$1', [v.id]); expect((await st('PATCH', `/api/studio/variants/${v.id}`, s.cookie, { stock: 2 })).json().error).toBe('stock_below_reserved');
    expect((await st('POST', `/api/studio/variants/${v.id}/stock`, s.cookie, { delta: -3 })).json().error).toBe('stock_below_reserved'); expect((await st('POST', `/api/studio/variants/${v.id}/stock`, s.cookie, { delta: -2 })).json()).toMatchObject({ stock: 3, reserved: 3 });
    await expect(q('UPDATE variants SET stock_reserved=99 WHERE id=$1', [v.id])).rejects.toThrow(/check/i);                                // the database itself refuses reserved > on hand
  });
  it('one-of-a-kind pieces can never be oversold: one variant, at most one in stock, never combined with made to order', async () => {
    const s = await liveShop({ stock: 5 }); const patch = (b: object) => st('PATCH', `/api/studio/products/${s.productId}`, s.cookie, b);
    expect((await patch({ oneOfAKind: true })).statusCode).toBe(200); const v = (await st('GET', `/api/studio/products/${s.productId}`, s.cookie)).json().variants[0]; expect(v.stock).toBe(1);        // clamped to the one piece that exists
    expect((await patch({ stock: 4 })).statusCode).toBe(200); expect((await st('GET', `/api/studio/products/${s.productId}`, s.cookie)).json().variants[0].stock).toBe(1);
    expect((await st('POST', `/api/studio/variants/${v.id}/stock`, s.cookie, { delta: 5 })).json().error).toBe('one_of_a_kind_needs_single_item');
    expect((await st('PUT', `/api/studio/products/${s.productId}/options`, s.cookie, { options: [{ name: 'Size', values: [{ value: 'S' }, { value: 'M' }] }] })).json().error).toBe('one_of_a_kind_needs_single_variant');
    expect((await patch({ madeToOrder: true })).json().error).toBe('one_of_a_kind_and_made_to_order');
    await expect(q(`INSERT INTO variants(product_id,options,price_cents,stock_on_hand) VALUES ($1,'{"x":"y"}',100,1)`, [s.productId])).rejects.toThrow(/one_of_a_kind_variants/);        // even straight SQL cannot add a second variant
    await expect(q('UPDATE variants SET stock_on_hand=2 WHERE id=$1', [v.id])).rejects.toThrow(/one_of_a_kind_stock/);
    const d = (await pub(`/api/products/${s.productId}`)).json(); expect(d).toMatchObject({ oneOfAKind: true, onlyOne: true, chip: 'One of a kind' }); expect(d.variants[0].left).toBe(1);
  });
  it('made-to-order items do not track stock, need a lead time, and are always available', async () => {
    const s = await studioSeller(app, { categories: ['3d-printing'] }); const m = (await upload(app, s.cookie, await jpeg())).json();
    const p = (await st('POST', '/api/studio/products', s.cookie, { title: 'Custom name plate', categorySlug: '3d-printing', priceCents: 2500, madeToOrder: true, mediaIds: [m.id], attributes: { material: 'pla' } })).json();
    expect(p.readiness.problems.map((x: any) => x.code)).toEqual(['lead_time_required']); await st('PATCH', `/api/studio/products/${p.id}`, s.cookie, { leadTimeDays: 5 }); expect((await st('POST', `/api/studio/products/${p.id}/publish`, s.cookie, {})).statusCode).toBe(200);
    const d = (await pub(`/api/products/${p.id}`)).json(); expect(d).toMatchObject({ madeToOrder: true, leadTimeDays: 5 }); expect(d.variants[0]).toMatchObject({ available: true, left: null });
  });
it('a live product can be deleted without unpublishing it first', async () => {
    const s = await liveShop({ title: 'Live and doomed', price: 2000, stock: 4 }); const r = (await st('DELETE', `/api/studio/products/${s.productId}`, s.cookie)).json(); expect(r.deleted).toBe(true); expect((await st('GET', `/api/studio/products/${s.productId}`, s.cookie)).statusCode).toBe(404);
  });
    it('duplicate, bulk edit and delete rules', async () => {
    const s = await liveShop({ title: 'Original', price: 2000, stock: 4 }); const d = (await st('POST', `/api/studio/products/${s.productId}/duplicate`, s.cookie)).json();
    expect(d).toMatchObject({ title: 'Original (copy)', status: 'draft' }); expect(d.variants[0]).toMatchObject({ priceCents: 2000, stock: 0 }); expect(d.media).toHaveLength(1);
    expect((await st('DELETE', `/api/studio/products/${d.id}`, s.cookie)).statusCode).toBe(200);
    const bulk = (b: object) => st('POST', '/api/studio/products/bulk', s.cookie, { ids: [s.productId], ...b });
    expect((await bulk({ priceChangePercent: 10 })).json()).toMatchObject({ products: 1, variantsChanged: 1 }); expect((await pub(`/api/products/${s.productId}`)).json().variants[0].priceCents).toBe(2200);
    expect((await bulk({ setPriceCents: 1500 })).statusCode).toBe(200); expect((await bulk({ stockDelta: 3 })).statusCode).toBe(200); expect((await bulk({ stockDelta: 3, priceChangePercent: 5 })).statusCode).toBe(400);
    const other = await liveShop(); expect((await st('POST', '/api/studio/products/bulk', s.cookie, { ids: [s.productId, other.productId], setPriceCents: 1 })).statusCode).toBe(404);
    expect((await pub(`/api/products/${s.productId}`)).json().variants[0]).toMatchObject({ priceCents: 1500, left: null });
  });
});
