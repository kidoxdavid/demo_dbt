import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';

let app: FastifyInstance;
const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const ck = (c: string) => ({ cookies: { eazy_sid: c } });
async function shop(n: string, category: string, publish = true) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `${n}@m.test`, password: 'correct-horse-battery', fullName: n, businessName: `${n} Co`, storeSlug: `${n}-mkt` } });
  const cookie = r.cookies.find(c => c.name === 'eazy_sid')!.value;
  await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(cookie), payload: { category, description: 'd', fulfilment: { pickup: true, delivery: false, shipping: false } } });
  if (publish) await app.inject({ method: 'POST', url: '/api/seller/store/publish', ...ck(cookie) });
  return { cookie, slug: `${n}-mkt`, tenantId: r.json().tenantId as string };
}
async function item(cookie: string, name: string, priceCents: number, extra: Record<string, unknown> = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/seller/products', ...ck(cookie), payload: { name, status: 'active', variants: [{ priceCents, costCents: 111, stock: 5 }], ...extra } });
  expect(r.statusCode).toBe(201); return r.json().id as string;
}
const mk = async (qs = '') => (await app.inject({ method: 'GET', url: `/api/public/marketplace${qs}` })).json();
const names = (r: any) => r.products.map((p: any) => p.name);

describe('marketplace visibility and privacy', () => {
  it('shows only active products of published stores with active tenants', async () => {
    const live = await shop('vis-live', 'Candles'); const unpub = await shop('vis-unpub', 'Candles', false); const susp = await shop('vis-susp', 'Candles');
    await item(live.cookie, 'Visible Candle', 1000);
    await item(live.cookie, 'Hidden Draft Candle', 1000, { status: 'draft' });
    await item(unpub.cookie, 'Unpublished Store Candle', 1000);
    await item(susp.cookie, 'Suspended Seller Candle', 1000);
    await owner.query(`SELECT set_config('app.platform_admin','on',false)`).catch(() => {});
    const c = await owner.connect(); try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_admin','on',true)`);
      await c.query(`UPDATE tenants SET status='suspended' WHERE id=$1`, [susp.tenantId]); await c.query('COMMIT'); } finally { c.release(); }
    const r = await mk('?category=Candles');
    expect(names(r)).toEqual(['Visible Candle']);
    expect(r.stores.map((s: any) => s.slug)).toEqual(['vis-live-mkt']);
  });
  it('exposes no internals: no cost, stock counts, tenant ids or emails (checked on keys and values)', async () => {
    const s = await shop('priv', 'Privacy'); await item(s.cookie, 'Secret Cost Item', 2000);
    const walk = (v: unknown, keys: string[] = [], vals: unknown[] = []): { keys: string[]; vals: unknown[] } => {
      if (Array.isArray(v)) v.forEach(x => walk(x, keys, vals));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x, keys, vals); } else vals.push(v);
      return { keys, vals };
    };
    const FORBIDDEN = /cost|on_?hand|reserved|tenant|email|password|phone|address/i;
    const list = await mk('?category=Privacy');
    const detail = (await app.inject({ method: 'GET', url: `/api/public/stores/${s.slug}/products/${list.products[0].id}` })).json();
    for (const payload of [list, detail]) {
      const { keys, vals } = walk(payload);
      expect(keys.filter(k => FORBIDDEN.test(k))).toEqual([]);
      expect(vals.filter(v => typeof v === 'string' && /@m\.test/.test(v))).toEqual([]);
      expect(vals).not.toContain(111);   // the seller's cost
    }
  });
});

describe('search, filters, sorting, paging', () => {
  it('finds by product, brand, store and category, tolerates typos, and treats % and _ literally', async () => {
    const s = await shop('srch', 'Fragrance Lab');
    await item(s.cookie, 'Oud Noir', 8000, { brand: 'Maison Zed' }); await item(s.cookie, 'Rose Water', 1500);
    expect(names(await mk('?q=oud'))).toContain('Oud Noir');
    expect(names(await mk('?q=maison%20zed'))).toContain('Oud Noir');
    expect(names(await mk('?q=srch%20co'))).toEqual(expect.arrayContaining(['Oud Noir', 'Rose Water']));
    expect(names(await mk('?q=fragrance%20lab'))).toContain('Rose Water');
    expect(names(await mk('?q=Rose%20Watr'))).toContain('Rose Water');       // typo tolerance
    expect(names(await mk('?q=oudd%20noire'))).toContain('Oud Noir');        // typo tolerance
    expect((await mk('?q=%25')).products).toEqual([]);                        // wildcard is literal
    expect((await mk('?q=_____')).products).toEqual([]);
    expect(names(await mk('?q=zzzzqqqq'))).toEqual([]);
  });
  it('filters by category case-insensitively and lists categories with store counts', async () => {
    const a = await shop('cat-a', 'Pottery'); const b = await shop('cat-b', 'pottery'); await item(a.cookie, 'Bowl A', 3000); await item(b.cookie, 'Bowl B', 3500);
    const r = await mk('?category=POTTERY');
    expect(names(r).sort()).toEqual(['Bowl A', 'Bowl B']);
    expect(r.categories.find((c: any) => c.name.toLowerCase() === 'pottery')).toBeTruthy();
  });
  it('sorts by price and paginates with a stable total', async () => {
    const s = await shop('sort', 'Sorty'); await item(s.cookie, 'Mid', 5000); await item(s.cookie, 'Cheap', 1000); await item(s.cookie, 'Dear', 9000);
    expect(names(await mk('?category=Sorty&sort=price_asc'))).toEqual(['Cheap', 'Mid', 'Dear']);
    expect(names(await mk('?category=Sorty&sort=price_desc'))).toEqual(['Dear', 'Mid', 'Cheap']);
    const p1 = await mk('?category=Sorty&sort=price_asc&limit=2&offset=0'); const p2 = await mk('?category=Sorty&sort=price_asc&limit=2&offset=2');
    expect([...names(p1), ...names(p2)]).toEqual(['Cheap', 'Mid', 'Dear']); expect(p1.total).toBe(3);
    expect((await app.inject({ method: 'GET', url: '/api/public/marketplace?limit=500' })).statusCode).toBe(400);
  });
  it('reports availability and made-to-order flags and price range', async () => {
    const s = await shop('avail', 'Avail');
    await app.inject({ method: 'POST', url: '/api/seller/products', ...ck(s.cookie), payload: { name: 'Gone', status: 'active', variants: [{ priceCents: 100, stock: 0 }] } });
    await item(s.cookie, 'Custom Thing', 2500, { madeToOrder: true });
    const r = await mk('?category=Avail'); const by = (n: string) => r.products.find((p: any) => p.name === n);
    expect(by('Gone').available).toBe(false); expect(by('Custom Thing')).toMatchObject({ available: true, madeToOrder: true, priceFrom: 2500 });
  });
});

describe('product detail', () => {
  it('returns details for active products only and never across stores', async () => {
    const a = await shop('pd-a', 'Detail'); const b = await shop('pd-b', 'Detail');
    const id = await item(a.cookie, 'Detail Item', 4200, { attributes: { material: 'PLA', waterproof: true }, description: 'Nice' });
    const draft = await item(a.cookie, 'Draft Item', 100, { status: 'draft' });
    const ok = await app.inject({ method: 'GET', url: `/api/public/stores/${a.slug}/products/${id}` });
    expect(ok.statusCode).toBe(200); expect(ok.json()).toMatchObject({ name: 'Detail Item', attributes: { material: 'PLA', waterproof: true } });
    expect((await app.inject({ method: 'GET', url: `/api/public/stores/${a.slug}/products/${draft}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/public/stores/${b.slug}/products/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/public/stores/${a.slug}/products/not-a-uuid` })).statusCode).toBe(400);
  });
});

describe('store theming', () => {
  it('validates, merges and publishes theme settings', async () => {
    const s = await shop('theme', 'Themed'); await item(s.cookie, 'Themed Item', 1000);
    const patch = (theme: object) => app.inject({ method: 'PATCH', url: '/api/seller/store', ...ck(s.cookie), payload: { theme } });
    expect((await patch({ accent: '#112233' })).json().theme).toEqual({ accent: '#112233' });
    expect((await patch({ hero: 'dark' })).json().theme).toEqual({ accent: '#112233', hero: 'dark' }); // merge, not replace
    expect((await patch({ accent: 'red' })).statusCode).toBe(400);
    expect((await patch({ accent: 'url(javascript:alert(1))' })).statusCode).toBe(400);
    expect((await patch({ evil: 1 })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/public/stores/${s.slug}` })).json().theme).toEqual({ accent: '#112233', hero: 'dark' });
    expect((await mk('?category=Themed')).stores[0].theme.accent).toBe('#112233');
  });
});
