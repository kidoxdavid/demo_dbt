import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { ck, jpeg, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
const st = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, cookie: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', cookie) });

describe('studio home', () => {
  it('a brand-new shop shows zeros and an honest checklist', async () => {
    const s = await studioSeller(app); const d = (await st('GET', '/api/studio/dashboard', s.cookie)).json();
    expect(d.firstName).toBe('Sam'); expect(d.tasks.ordersToShip).toBe(0); expect(d.week).toMatchObject({ salesCents: 0, orders: 0, visits: 0, changePct: null }); expect(d.week.daily).toHaveLength(7);
    expect(Object.fromEntries(d.checklist.map((c: any) => [c.key, c.done]))).toEqual({ shop: true, product: false, look: false, payouts: false, freeShipping: false }); expect(d.recent).toEqual([]);
  });
  it('checklist follows reality: look chosen, first product, free shipping', async () => {
    const s = await studioSeller(app); const get = async () => Object.fromEntries((await st('GET', '/api/studio/dashboard', s.cookie)).json().checklist.map((c: any) => [c.key, c.done]));
    await st('PATCH', '/api/studio/shop', s.cookie, { look: 'sage' }); expect((await get()).look).toBe(true);
    await st('POST', '/api/studio/products', s.cookie, { title: 'Draft thing' }); expect((await get()).product).toBe(true);
    await q('UPDATE shipping_profiles SET free_over_cents=7500 WHERE seller_id=$1', [s.sellerId]); expect((await get()).freeShipping).toBe(true);
  });
  it('shop visits count page views; only the owner sees them; low stock lists pieces with 1 or 2 left', async () => {
    const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
    const p = (await st('POST', '/api/studio/products', s.cookie, { title: 'Low stock jar', categorySlug: 'pottery-ceramics', priceCents: 2000, stock: 2, attributes: {}, mediaIds: [m.id] })).json(); await st('POST', `/api/studio/products/${p.id}/publish`, s.cookie, { acknowledged: true });
    for (let i = 0; i < 3; i++) await app.inject({ method: 'GET', url: `/api/shops/${s.shop.slug}` }); await new Promise(r => setTimeout(r, 200));
    const d = (await st('GET', '/api/studio/dashboard', s.cookie)).json(); expect(d.week.visits).toBe(3); expect(d.tasks.lowStock).toEqual([{ productId: p.id, title: 'Low stock jar', variant: null, left: 2 }]);
    const other = await studioSeller(app); expect((await st('GET', '/api/studio/dashboard', other.cookie)).json().week.visits).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/studio/dashboard' })).statusCode).toBe(401);
  });
  it('a paid order appears in "to ship", this week\'s sales and recent orders', async () => {
    const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
    const p = (await st('POST', '/api/studio/products', s.cookie, { title: 'Dash mug', categorySlug: 'pottery-ceramics', priceCents: 4000, stock: 5, attributes: {}, mediaIds: [m.id] })).json(); await st('POST', `/api/studio/products/${p.id}/publish`, s.cookie, { acknowledged: true });
    const v = (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id; const jar: Record<string, string> = {};
    const call = async (method: any, url: string, payload?: object) => { const r = await app.inject({ method, url, cookies: jar, ...(payload ? { payload } : {}) }); for (const c of r.cookies) jar[c.name] = c.value; return r; };
    await call('POST', '/api/cart/items', { variantId: v, quantity: 2 }); const o = (await call('POST', '/api/checkout', { email: 'dash@t.test', address: { name: 'Dee', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } })).json();
    await app.inject({ method: 'POST', url: `/api/dev/payments/${o.payment.ref}/simulate`, payload: { outcome: 'succeeded' } });
    const d = (await st('GET', '/api/studio/dashboard', s.cookie)).json(); expect(d.tasks.ordersToShip).toBe(1); expect(d.week.orders).toBe(1); expect(d.week.salesCents).toBe(8000 + 900);
    expect(d.week.daily.reduce((n: number, x: any) => n + x.cents, 0)).toBe(8900); expect(d.recent[0]).toMatchObject({ title: 'Dash mug', qty: 2, buyerName: 'Dee', city: 'Calgary', status: 'new' });
  });
});

describe('first product helpers', () => {
  it('suggests one of the seller\'s own categories from the title, never one they did not pick', async () => {
    const s = await studioSeller(app, { categories: ['pottery-ceramics', 'candles-home-fragrance'] }); const sug = async (t: string) => (await st('GET', `/api/studio/suggest-category?title=${encodeURIComponent(t)}`, s.cookie)).json();
    expect(await sug('Soy candle in a jar')).toMatchObject({ slug: 'candles-home-fragrance', suggested: true }); expect(await sug('Wheel-thrown ceramics mug')).toMatchObject({ slug: 'pottery-ceramics', suggested: true });
    const one = await studioSeller(app, { categories: ['jewellery'] }); expect((await st('GET', '/api/studio/suggest-category?title=vase', one.cookie)).json()).toMatchObject({ slug: 'jewellery' });
  });
});
