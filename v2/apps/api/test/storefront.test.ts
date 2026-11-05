import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q, tx } from '../src/db.js';
import { seedDemoCatalogue } from '../src/seed/demoCatalogue.js';
import { ck, login } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); await tx(c => seedDemoCatalogue(c, 'demo-password-2026')); });
afterAll(async () => { await app.close(); await pool.end(); });
const get = async (url: string, cookie?: string) => app.inject({ method: 'GET', url, ...(cookie ? ck('shop', cookie) : {}) });

describe('home, curated picks and filters', () => {
  it('home returns the category tiles, phone and desktop picks, and the spotlight', async () => {
    const h = (await get('/api/home')).json();
    expect(h.categories.length).toBeGreaterThanOrEqual(8); expect(h.phone.length).toBeLessThanOrEqual(4); expect(h.desktop.length).toBeLessThanOrEqual(4);
    if (h.spotlight) { expect(h.spotlight.shop.slug).toBe('clay-ember'); expect(h.spotlight.quote.length).toBeGreaterThan(10); }
  });
  it('curated picks win; with none set the newest pieces are shown', async () => {
    const prev = (await q(`SELECT value FROM app_settings WHERE key='home_picks_phone'`)).rows[0]?.value;
    try {
      await q(`DELETE FROM app_settings WHERE key='home_picks_phone'`); const newest = (await get('/api/home')).json().phone; expect(newest.length).toBeGreaterThan(0);
      const pick = (await get('/api/products?limit=3&sort=price_desc')).json().items.map((x: any) => x.id).slice(0, 2);
      await q(`INSERT INTO app_settings(key,value) VALUES ('home_picks_phone',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(pick)]);
      expect((await get('/api/home')).json().phone.map((x: any) => x.id).sort()).toEqual([...pick].sort());
    } finally { if (prev) await q(`INSERT INTO app_settings(key,value) VALUES ('home_picks_phone',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(prev)]); else await q(`DELETE FROM app_settings WHERE key='home_picks_phone'`); }
  });
  it('the free-shipping filter only returns pieces whose shop ships them free', async () => {
    const all = (await get('/api/products?limit=60')).json().total; const free = (await get('/api/products?freeShipping=true&limit=60')).json();
    expect(free.total).toBeLessThan(all);
    for (const c of free.items) { const r = (await q(`SELECT 1 FROM shipping_profiles sp JOIN shops s ON s.seller_id=sp.seller_id WHERE s.slug=$1 AND sp.is_default AND (sp.base_cents=0 OR sp.free_over_cents <= $2)`, [c.seller.slug, c.priceCents])).rowCount; expect(r).toBe(1); }
  });
  it('pottery has Material and Size filters with counts', async () => {
    const r = (await get('/api/products?category=pottery-ceramics&limit=1')).json(); const keys = r.facets.map((f: any) => f.key); expect(keys).toEqual(expect.arrayContaining(['material', 'size']));
  });
});

describe('saved pieces and followed shops', () => {
  it('guests are told to sign in; signed-in buyers save, list and unsave; saved ids fill the hearts', async () => {
    const piece = (await get('/api/products?limit=1')).json().items[0];
    expect((await app.inject({ method: 'PUT', url: `/api/me/saved/${piece.id}` })).statusCode).toBe(401); expect((await get('/api/me/saved/ids')).json()).toEqual({ products: [], shops: [] });
    const u = await login(app, 'shop'); const put = () => app.inject({ method: 'PUT', url: `/api/me/saved/${piece.id}`, ...ck('shop', u.cookie) });
    expect((await put()).statusCode).toBe(204); expect((await put()).statusCode).toBe(204);                                  // saving twice is harmless
    expect((await get('/api/me/saved/ids', u.cookie)).json().products).toEqual([piece.id]); expect((await get('/api/me/saved', u.cookie)).json().items[0].id).toBe(piece.id);
    expect((await app.inject({ method: 'DELETE', url: `/api/me/saved/${piece.id}`, ...ck('shop', u.cookie) })).statusCode).toBe(204); expect((await get('/api/me/saved/ids', u.cookie)).json().products).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: '/api/me/saved/00000000-0000-4000-8000-000000000000', ...ck('shop', u.cookie) })).statusCode).toBe(404);
  });
  it('buyers follow and unfollow shops, each person has their own list', async () => {
    const a = await login(app, 'shop'), b = await login(app, 'shop'); const f = (m: 'PUT' | 'DELETE', c: string) => app.inject({ method: m, url: '/api/shops/clay-ember/follow', ...ck('shop', c) });
    expect((await app.inject({ method: 'PUT', url: '/api/shops/clay-ember/follow' })).statusCode).toBe(401); expect((await f('PUT', a.cookie)).statusCode).toBe(204);
    expect((await get('/api/me/saved/ids', a.cookie)).json().shops).toEqual(['clay-ember']); expect((await get('/api/me/saved/ids', b.cookie)).json().shops).toEqual([]);
    expect((await f('DELETE', a.cookie)).statusCode).toBe(204); expect((await get('/api/me/saved/ids', a.cookie)).json().shops).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: '/api/shops/no-such-shop/follow', ...ck('shop', a.cookie) })).statusCode).toBe(404);
  });
});
