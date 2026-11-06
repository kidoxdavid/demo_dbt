import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { config } from '../src/config.js';
import { clearMicrocache, microcache } from '../src/lib/microcache.js';
import { sign } from '../src/lib/payments.js';
import { ck, jpeg, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 1_000_000 }); });
afterAll(async () => { await app.close(); await pool.end(); });
afterEach(() => { config.listCacheMs = 0; clearMicrocache(); });
const st = (cookie: string, method: 'POST', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', cookie) });

describe('short-lived shared answers', () => {
  it('identical requests at once share one lookup, the answer is reused until it expires, and errors are never kept', async () => {
    config.listCacheMs = 80; let calls = 0; const slow = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { n: calls }; };
    const results = await Promise.all(Array.from({ length: 25 }, () => microcache('k1', slow))); expect(calls).toBe(1); expect(new Set(results.map(r => r.n))).toEqual(new Set([1]));
    expect((await microcache('k1', slow)).n).toBe(1); expect(calls).toBe(1); await new Promise(r => setTimeout(r, 120)); expect((await microcache('k1', slow)).n).toBe(2);
    let fails = 0; const bad = async () => { fails++; throw new Error('boom'); }; await expect(microcache('k2', bad)).rejects.toThrow('boom'); await expect(microcache('k2', bad)).rejects.toThrow('boom'); expect(fails).toBe(2);
    config.listCacheMs = 0; let off = 0; await microcache('k3', async () => ++off); await microcache('k3', async () => ++off); expect(off).toBe(2);          // 0 means no sharing at all
  });
  it('anonymous listings are shared briefly in production settings and fresh when switched off; a change by a maker shows at once', async () => {
    const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json(); const mk = async (title: string) => { const p = (await st(s.cookie, 'POST', '/api/studio/products', { title, categorySlug: 'pottery-ceramics', priceCents: 2500, stock: 4, attributes: {}, mediaIds: [m.id] })).json(); await st(s.cookie, 'POST', `/api/studio/products/${p.id}/publish`, { acknowledged: true }); };
    const url = '/api/products?q=cachezebra'; await mk('Cachezebra one'); config.listCacheMs = 500; const a = await app.inject({ method: 'GET', url }); expect(a.json().total).toBe(1); expect(a.headers['cache-control']).toMatch(/^public, max-age=\d+$/);
    await mk('Cachezebra two'); expect((await app.inject({ method: 'GET', url })).json().total).toBe(2);          // a maker's change clears the shared answer at once
    await app.inject({ method: 'GET', url }); config.listCacheMs = 0; await mk('Cachezebra three');
    expect((await app.inject({ method: 'GET', url })).json().total).toBe(3); expect((await app.inject({ method: 'GET', url })).headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/api/products?q=%00' })).statusCode).toBe(400);                                                  // errors are not cached and not 500
  });
});

describe('pressure on stock and payments', () => {
  it('forty buyers race for ten units: exactly ten orders are placed, stock never goes negative, every hold is accounted for', async () => {
    const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json(); const p = (await st(s.cookie, 'POST', '/api/studio/products', { title: 'Race mug', categorySlug: 'pottery-ceramics', priceCents: 1000, stock: 10, attributes: {}, mediaIds: [m.id] })).json(); await st(s.cookie, 'POST', `/api/studio/products/${p.id}/publish`, { acknowledged: true });
    const v = (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id as string;
    const buyers = await Promise.all(Array.from({ length: 40 }, async (_, i) => { const jar: Record<string, string> = {}; const r = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: v, quantity: 1 } }); for (const c of r.cookies) jar[c.name] = c.value; return { jar, i }; }));
    const results = await Promise.all(buyers.map(b => app.inject({ method: 'POST', url: '/api/checkout', cookies: b.jar, payload: { email: `race${b.i}@t.test`, address: { name: 'R', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } } })));
    const codes = results.map(r => r.statusCode); expect(codes.filter(c => c === 201)).toHaveLength(10); expect(codes.filter(c => c === 409)).toHaveLength(30); expect(codes.every(c => c === 201 || c === 409)).toBe(true);
    const row = (await q('SELECT stock_on_hand, stock_reserved FROM variants WHERE id=$1', [v])).rows[0]; expect(row).toEqual({ stock_on_hand: 10, stock_reserved: 10 }); expect(Number((await q(`SELECT coalesce(sum(quantity),0) n FROM stock_reservations WHERE variant_id=$1 AND status='held'`, [v])).rows[0].n)).toBe(10);
    // all ten pay at once: every one is confirmed, stock moves from held to sold exactly once each
    const refs = results.filter(r => r.statusCode === 201).map(r => r.json().payment.ref as string); const paid = await Promise.all(refs.map(ref => app.inject({ method: 'POST', url: `/api/dev/payments/${ref}/simulate`, payload: { outcome: 'succeeded' } }))); expect(paid.every(r => r.statusCode === 200 && r.json().status === 'paid')).toBe(true);
    expect((await q('SELECT stock_on_hand, stock_reserved FROM variants WHERE id=$1', [v])).rows[0]).toEqual({ stock_on_hand: 0, stock_reserved: 0 }); expect(Number((await q(`SELECT coalesce(sum(amount_cents),0) s FROM ledger_entries`)).rows[0].s)).toBe(0);
  }, 120_000);
  it('the same payment event delivered many times at once is applied exactly once', async () => {
    const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json(); const p = (await st(s.cookie, 'POST', '/api/studio/products', { title: 'Webhook mug', categorySlug: 'pottery-ceramics', priceCents: 1500, stock: 5, attributes: {}, mediaIds: [m.id] })).json(); await st(s.cookie, 'POST', `/api/studio/products/${p.id}/publish`, { acknowledged: true });
    const v = (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id; const jar: Record<string, string> = {}; const add = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: v, quantity: 2 } }); for (const c of add.cookies) jar[c.name] = c.value;
    const o = (await app.inject({ method: 'POST', url: '/api/checkout', cookies: jar, payload: { email: 'hook@t.test', address: { name: 'H', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } } })).json();
    const body = JSON.stringify({ id: `evt_burst_${Date.now()}`, type: 'payment.succeeded', providerRef: o.payment.ref }); const hit = () => app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: { 'content-type': 'application/json', 'x-signature': sign(body) }, payload: body });
    const rs = await Promise.all(Array.from({ length: 20 }, hit)); expect(rs.every(r => r.statusCode === 200)).toBe(true); expect(rs.filter(r => r.json().status === 'paid')).toHaveLength(1);
    expect(Number((await q(`SELECT count(*) n FROM ledger_entries WHERE order_id=$1 AND memo='sale'`, [o.orderId])).rows[0].n)).toBe(4); expect((await q('SELECT stock_on_hand, stock_reserved FROM variants WHERE id=$1', [v])).rows[0]).toEqual({ stock_on_hand: 3, stock_reserved: 0 });
    expect(Number((await q(`SELECT count(*) n FROM outbox_emails WHERE to_email='hook@t.test' AND template='order_confirmation'`)).rows[0].n)).toBe(1);
  }, 60_000);
});
