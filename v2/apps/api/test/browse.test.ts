import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q, tx } from '../src/db.js';
import { seedDemoCatalogue } from '../src/seed/demoCatalogue.js';
import { ck, jpeg, studioSeller, upload, PW } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
const st = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, cookie: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', cookie) });
const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
type P = { title: string; category?: string; extra?: string[]; price?: number; was?: number; stock?: number; handmade?: boolean; attrs?: object; tags?: string[]; description?: string };
/** A shop with several published products (each through the real studio flow). */
async function shopWith(products: P[], opts: { name?: string; cats?: string[] } = {}) {
  const s = await studioSeller(app, { categories: opts.cats ?? ['pottery-ceramics'], shopName: opts.name }); const m = (await upload(app, s.cookie, await jpeg())).json(); const ids: string[] = [];
  for (const p of products) {
    const r = (await st('POST', '/api/studio/products', s.cookie, { title: p.title, description: p.description ?? '', categorySlug: p.category ?? 'pottery-ceramics', extraCategorySlugs: p.extra, priceCents: p.price ?? 3000, compareAtCents: p.was, stock: p.stock === 0 ? 1 : p.stock ?? 3, handmade: p.handmade, tags: p.tags, attributes: p.attrs ?? {}, mediaIds: [m.id] })).json();
    const pr = await st('POST', `/api/studio/products/${r.id}/publish`, s.cookie, { acknowledged: true }); if (pr.statusCode !== 200) throw new Error(pr.body); ids.push(r.id);
    if (p.stock === 0) { const v = (await st('GET', `/api/studio/products/${r.id}`, s.cookie)).json().variants[0]; await st('PATCH', `/api/studio/variants/${v.id}`, s.cookie, { stock: 0 }); }     // it sold out after going live
  }
  return { ...s, ids };
}

describe('listing, filters and search', () => {
  it('cards are the same shape everywhere and show chip, was-price, availability and rating', async () => {
    const s = await shopWith([{ title: 'Zarqon vase', price: 4800, was: 6000, handmade: true }, { title: 'Zarqon sold out dish', stock: 0 }], { name: 'Zarqon Studio' });
    await q(`UPDATE shops SET rating_avg=4.9, rating_count=128 WHERE id=$1`, [s.shop.id]);
    const r = await get(`/api/products?shop=${s.shop.slug}&sort=price_desc`); expect(r).toMatchObject({ total: 2, makers: 1, fuzzy: false });
    expect(r.items[0]).toMatchObject({ title: 'Zarqon vase', priceCents: 4800, wasCents: 6000, chip: 'Handmade', available: true, seller: { name: 'Zarqon Studio', slug: s.shop.slug }, rating: { avg: 4.9, count: 128 } }); expect(r.items[0].photo).toMatch(/^\/api\/media\/.+\/w640$/); expect(r.items[0].photoBlur).toMatch(/^data:image\/webp/);
    expect(r.items[1]).toMatchObject({ available: false, wasCents: null, chip: null }); expect(Object.keys(r.items[0]).sort()).toEqual(Object.keys(r.items[1]).sort());
    const detail = await get(`/api/products/${r.items[0].id}`); expect(detail.moreFromShop[0].title).toBe('Zarqon sold out dish'); expect(Object.keys(detail.moreFromShop[0]).sort()).toEqual(Object.keys(r.items[0]).sort());          // same card everywhere
  });
  it('a product appears under every category it belongs to, including parents of sub-categories', async () => {
    const s = await shopWith([{ title: 'Quillon planter', category: 'pottery-ceramics', extra: ['plants-planters'] }, { title: 'Quillon candle', category: 'candles-home-fragrance' }], { cats: ['pottery-ceramics', 'candles-home-fragrance'] });
    const inCat = async (slug: string) => (await get(`/api/products?category=${slug}&shop=${s.shop.slug}`)).items.map((i: any) => i.title);
    expect(await inCat('pottery-ceramics')).toEqual(['Quillon planter']); expect(await inCat('plants-planters')).toEqual(['Quillon planter']); expect(await inCat('candles-home-fragrance')).toEqual(['Quillon candle']);
    const admin = (await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': 'admin' }, payload: await (async () => { const { makeUser } = await import('./helpers.js'); const u = await makeUser(app, { role: 'catalogue' }); return { email: u.email, password: PW }; })() }));
    const ac = admin.cookies.find(c => c.name === 'es_admin')!.value; const parent = (await get('/api/categories/pottery-ceramics')).id;
    const sub = (await app.inject({ method: 'POST', url: '/api/admin/categories', ...ck('admin', ac), payload: { slug: 'quillon-mugs', name: 'Mugs', parentId: parent } })).json();
    await st('PATCH', `/api/studio/products/${s.ids[0]}`, s.cookie, { categorySlug: 'quillon-mugs', extraCategorySlugs: [] });
    expect(await inCat('quillon-mugs')).toEqual(['Quillon planter']); expect(await inCat('pottery-ceramics')).toEqual(['Quillon planter']);          // parent category includes the sub-category's products
    expect((await app.inject({ method: 'GET', url: '/api/products?category=nope' })).statusCode).toBe(404); void sub;
  });
  it('filters: price range, handmade, in stock, one of a kind, rating and attribute values; facets count what matches', async () => {
    const s = await shopWith([{ title: 'Wexler a', price: 2000, handmade: true, attrs: { technique: 'wheel-thrown', dishwasher_safe: true } }, { title: 'Wexler b', price: 5000, attrs: { technique: 'hand-built', dishwasher_safe: false } },
      { title: 'Wexler c', price: 8000, stock: 0, attrs: { technique: 'wheel-thrown' } }]); const base = `/api/products?shop=${s.shop.slug}`; const titles = async (qs: string) => (await get(`${base}&${qs}&sort=price_asc`)).items.map((i: any) => i.title);
    expect(await titles('minPrice=3000&maxPrice=6000')).toEqual(['Wexler b']); expect(await titles('handmade=true')).toEqual(['Wexler a']); expect(await titles('inStock=true')).toEqual(['Wexler a', 'Wexler b']);
    expect(await titles('attr.technique=wheel-thrown')).toEqual(['Wexler a', 'Wexler c']); expect(await titles('attr.technique=wheel-thrown,hand-built')).toHaveLength(3); expect(await titles('attr.dishwasher_safe=true')).toEqual(['Wexler a']);
    expect(await titles('attr.technique=slip-cast')).toEqual([]); expect(await titles('rating=4')).toEqual([]);
    const f = await get(`${base}&category=pottery-ceramics`); const tech = f.facets.find((x: any) => x.key === 'technique'); expect(tech.options.find((o: any) => o.value === 'wheel-thrown').count).toBe(2); expect(tech.options.find((o: any) => o.value === 'hand-built').count).toBe(1);
    expect(f.facets.find((x: any) => x.key === 'dishwasher_safe').options[0]).toMatchObject({ value: 'true', count: 1 });
    expect((await app.inject({ method: 'GET', url: `${base}&limit=500` })).statusCode).toBe(400);
  });
  it('sorting and paging are stable; hidden, draft, vacation and suspended shops behave', async () => {
    const s = await shopWith(Array.from({ length: 5 }, (_, i) => ({ title: `Paging item ${i}`, price: 1000 + i * 100 }))); const base = `/api/products?shop=${s.shop.slug}`;
    expect((await get(`${base}&sort=price_asc&limit=2`)).items.map((i: any) => i.priceCents)).toEqual([1000, 1100]); expect((await get(`${base}&sort=price_asc&limit=2&offset=2`)).items.map((i: any) => i.priceCents)).toEqual([1200, 1300]); expect((await get(`${base}&sort=price_desc&limit=1`)).items[0].priceCents).toBe(1400);
    await st('POST', `/api/studio/products/${s.ids[0]}/unpublish`, s.cookie); await st('POST', '/api/studio/products', s.cookie, { title: 'A draft' }); expect((await get(base)).total).toBe(4);
    await st('PATCH', '/api/studio/shop', s.cookie, { vacation: true }); const v = await get(base); expect(v.total).toBe(4); expect(v.items.every((i: any) => i.available === false)).toBe(true);               // visible, but cannot be bought
    await q(`UPDATE sellers SET status='suspended' WHERE id=$1`, [s.sellerId]); expect((await get(base)).total).toBe(0); expect((await app.inject({ method: 'GET', url: `/api/shops/${s.shop.slug}` })).statusCode).toBe(404);
  });
  it('search: exact matches first, verified synonyms, typo tolerance only as a fallback, and suggestions', async () => {
    const s = await shopWith([{ title: 'Velmora hair piece in auburn', category: 'hair-wigs', attrs: { length_in: 12, hair_type: 'synthetic' } }, { title: 'Velmora wig curly', category: 'hair-wigs', attrs: { length_in: 14, hair_type: 'synthetic' } },
      { title: 'Velmora cup and saucer', description: 'A cup for tea', tags: ['teaware'] }, { title: 'Velmora stoneware mug' }], { cats: ['hair-wigs', 'pottery-ceramics'], name: 'Velmora Works' });
    const find = async (qs: string) => get(`/api/products?q=${encodeURIComponent(qs)}&shop=${s.shop.slug}`);
    expect((await find('velmora wig')).items.map((i: any) => i.title).sort()).toEqual(['Velmora hair piece in auburn', 'Velmora wig curly']);        // "wig" also finds "hair piece" (verified synonym)
    expect((await find('velmora mug')).items.map((i: any) => i.title).sort()).toEqual(['Velmora cup and saucer', 'Velmora stoneware mug']);        // mug <-> cup
    expect((await find('teaware')).items.map((i: any) => i.title)).toEqual(['Velmora cup and saucer']);                                                // tags are searched
    const exact = await find('Velmora wig curly'); expect(exact.fuzzy).toBe(false); expect(exact.items[0].title).toBe('Velmora wig curly');
    const typo = await find('velmroa'); expect(typo.fuzzy).toBe(true); expect(typo.total).toBeGreaterThanOrEqual(4);                                  // misspelt: nothing exact, so fuzzy kicks in
    expect((await find('zzzqqq')).total).toBe(0);
    const sug = await get('/api/search/suggest?q=velm'); expect(sug.products.length).toBeGreaterThan(0); expect(sug.shops.map((x: any) => x.name)).toContain('Velmora Works'); expect((await get('/api/search/suggest?q=pott')).categories.map((c: any) => c.slug)).toContain('pottery-ceramics');
    expect((await get(`/api/products?q=${encodeURIComponent("100%_'; DROP TABLE products;--")}`)).total).toBe(0);                                      // wildcards and quotes are inert
  });
  it('product detail: options with defaults, labelled attributes, breadcrumbs, similar and more-from', async () => {
    const s = await shopWith([{ title: 'Detail vase', attrs: { technique: 'wheel-thrown', dishwasher_safe: false, height_cm: 24 } }, { title: 'Detail sibling' }]);
    await st('PUT', `/api/studio/products/${s.ids[0]}/options`, s.cookie, { options: [{ name: 'Size', values: [{ value: 'Small' }, { value: 'Medium', default: true }] }, { name: 'Glaze', values: [{ value: 'Terracotta', swatch: '#b8704a' }, { value: 'Oat', swatch: '#e8dccb', default: true }] }] });
    const d = await get(`/api/products/${s.ids[0]}`); expect(d.defaultOptions).toEqual({ Size: 'Medium', Glaze: 'Oat' }); expect(d.options[1].values[0]).toMatchObject({ value: 'Terracotta', swatch: '#b8704a' }); expect(d.variants).toHaveLength(4);
    expect(d.attributes.find((a: any) => a.key === 'technique')).toMatchObject({ label: 'Technique', display: 'Wheel-thrown' }); expect(d.attributes.find((a: any) => a.key === 'height_cm').display).toBe('24 cm'); expect(d.attributes.find((a: any) => a.key === 'dishwasher_safe').display).toBe('No');
    expect(d.category.breadcrumbs.map((b: any) => b.slug)).toEqual(['pottery-ceramics']); expect(d.shop).toMatchObject({ slug: s.shop.slug, verifiedMaker: false }); expect(d.moreFromShop.map((c: any) => c.title)).toEqual(['Detail sibling']);
    expect(d.media[0]).toMatchObject({ kind: 'image', w640: expect.stringMatching(/^\/api\/media\//) }); expect(d.variants[0]).not.toHaveProperty('stock_on_hand'); expect(JSON.stringify(d)).not.toMatch(/seller_id|password|email/);
    expect((await app.inject({ method: 'GET', url: '/api/products/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
  });
});

describe('the demo catalogue from the brief', () => {
  it('seeds the fixed shops and products, reaches 412 pieces from 38 makers, and is idempotent', async () => {
    await q(`UPDATE products SET status='hidden' WHERE seller_id NOT IN (SELECT seller_id FROM shops WHERE false)`);          // earlier tests in this shared database made newer products: set them aside
    expect(await tx(c => seedDemoCatalogue(c, PW))).toBe(true); expect(await tx(c => seedDemoCatalogue(c, PW))).toBe(false);
    const newest = await get('/api/products?sort=new&limit=5'); expect(newest.items.map((i: any) => i.title)).toEqual(['Dusk over the hills, A4 print', 'Cedar & fig soy candle', 'Geometric desk planter', 'Body wave bundle, 18 in', 'Amber & oud eau de parfum, 50 ml']);
    expect(newest.items[0]).toMatchObject({ priceCents: 3800, chip: 'Limited', seller: { name: 'Harper & Pine' }, art: { kind: 'print', tone: 'warm' } }); expect(newest.items[1]).toMatchObject({ priceCents: 2600, chip: 'Handmade' }); expect(newest.items[2].chip).toBeNull();
    expect(newest.items[3]).toMatchObject({ priceCents: 11800, wasCents: 14000, seller: { name: 'Crown Hair Co.' } }); expect(newest.items[4]).toMatchObject({ priceCents: 9600, wasCents: 11000 });
    const pot = await get('/api/products?category=pottery-ceramics&limit=6'); expect(pot).toMatchObject({ total: 412, makers: 38 });
    expect(pot.items.map((i: any) => `${i.title} | ${i.seller.name} | ${i.priceCents}${i.wasCents ? ` was ${i.wasCents}` : ''} | ${i.chip ?? '-'}`)).toEqual([
      'Speckled stoneware mug | Clay & Ember | 3400 | One of a kind', 'Tall bud vase, matte glaze | Kiln & Co. | 4800 | -', 'Hand-built planter | Clay & Ember | 4200 | Handmade', 'Serving bowl, ash glaze | Studio Marlow | 6400 | -',
      'Trinket dish set of 3 | Kiln & Co. | 2900 was 3600 | -', 'Espresso cup pair | Studio Marlow | 4400 | -']);
    expect((await get('/api/products?category=plants-planters&shop=clay-ember')).items.map((i: any) => i.title)).toEqual(['Hand-built planter']);           // also under Plants & planters
    const shop = await get('/api/shops/clay-ember'); expect(shop).toMatchObject({ name: 'Clay & Ember', city: 'Calgary', region: 'AB', verifiedMaker: true, rating: { avg: 4.9, count: 128 }, tagline: 'Wheel-thrown stoneware from Calgary' });
    const id = (await get('/api/products?q=terracotta&shop=clay-ember')).items[0].id; const vase = await get(`/api/products/${id}`);
    expect(vase).toMatchObject({ title: 'Tall bud vase in terracotta glaze', chip: 'Handmade · Made in Alberta', defaultOptions: { Size: 'Medium', Glaze: 'Terracotta' } }); expect(vase.options.map((o: any) => o.name)).toEqual(['Size', 'Glaze']);
    expect(vase.options[1].values.map((v: any) => v.swatch)).toEqual(['#b8704a', '#e8dccb', '#3d5a4b', '#2c2620']); const def = vase.variants.find((v: any) => v.options.Size === 'Medium' && v.options.Glaze === 'Terracotta'); expect(def.priceCents).toBe(4800);
    expect(vase.variants.filter((v: any) => v.left !== null && v.left <= 5).map((v: any) => v.options)).toEqual([{ Size: 'Large', Glaze: 'Charcoal' }]);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': 'studio' }, payload: { email: 'amara@clayember.test', password: PW } }); expect(login.statusCode).toBe(200);
  }, 120_000);
});
