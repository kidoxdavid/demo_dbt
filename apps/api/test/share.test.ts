import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });
const qr = (cookie: string | undefined, qs: string) => app.inject({ method: 'GET', url: `/api/seller/qr?${qs}`, ...(cookie ? ck(cookie) : {}) });

describe('share links and QR codes', () => {
  it('lists the seller\'s store and active products with paths and channels', async () => {
    const s = await k.seller('sh1'); const p = await k.product(s.cookie); await k.product(s.cookie, { name: 'Draft', status: 'draft' });
    const r = (await app.inject({ method: 'GET', url: '/api/seller/share', ...ck(s.cookie) })).json();
    expect(r.store.path).toBe('/store/sh1-shop'); expect(r.products).toEqual([{ id: p.id, name: 'Stand', path: `/store/sh1-shop/p/${p.id}` }]);
    expect(r.sources.map((x: any) => x.key)).toEqual(expect.arrayContaining(['instagram', 'whatsapp', 'qr']));
    expect((await app.inject({ method: 'GET', url: '/api/seller/share' })).statusCode).toBe(401);
  });
  it('generates an SVG QR for own store/product pages only', async () => {
    const a = await k.seller('sh2'); const b = await k.seller('sh3'); const pa = await k.product(a.cookie); const pb = await k.product(b.cookie);
    const ok = await qr(a.cookie, `path=${encodeURIComponent('/store/sh2-shop')}&src=instagram`);
    expect(ok.statusCode).toBe(200); expect(ok.headers['content-type']).toBe('image/svg+xml'); expect(ok.body.startsWith('<?xml') || ok.body.startsWith('<svg')).toBe(true);
    expect((await qr(a.cookie, `path=${encodeURIComponent(`/store/sh2-shop/p/${pa.id}`)}`)).statusCode).toBe(200);
    expect((await qr(a.cookie, `path=${encodeURIComponent('/store/sh3-shop')}`)).statusCode).toBe(403);               // someone else's store
    expect((await qr(a.cookie, `path=${encodeURIComponent(`/store/sh2-shop/p/${pb.id}`)}`)).statusCode).toBe(404);    // someone else's product
    expect((await qr(a.cookie, `path=${encodeURIComponent('https://evil.example/phish')}`)).statusCode).toBe(400);   // arbitrary URL
    expect((await qr(a.cookie, `path=${encodeURIComponent('/store/sh2-shop')}&src=<script>`)).statusCode).toBe(400);
    expect((await qr(undefined, `path=${encodeURIComponent('/store/sh2-shop')}`)).statusCode).toBe(401);
  });
  it('encodes the channel tag into the QR target (different tags give different codes)', async () => {
    const s = await k.seller('sh4');
    const a = (await qr(s.cookie, `path=${encodeURIComponent('/store/sh4-shop')}&src=whatsapp`)).body; const b = (await qr(s.cookie, `path=${encodeURIComponent('/store/sh4-shop')}&src=email`)).body;
    expect(a).not.toBe(b);
  });
  it('attributes orders to a channel and reports sales by source; rejects malformed tags', async () => {
    const s = await k.seller('sh5'); const p = await k.product(s.cookie, { variants: [{ priceCents: 1000, costCents: 400, stock: 20 }] });
    const place = async (source?: string, qty = 1) => { const r = await k.checkout(s.slug, p.variantId, qty, source ? { source } : {}); if (r.statusCode === 201) await k.pay(r.json().paymentId); return r; };
    await place('instagram', 2); await place('instagram'); await place('whatsapp'); await place();
    expect((await place('<b>x</b>')).statusCode).toBe(400); expect((await place('A'.repeat(41))).statusCode).toBe(400);
    const d = (await app.inject({ method: 'GET', url: '/api/seller/dashboard', ...ck(s.cookie) })).json();
    expect(d.bySource).toEqual([{ source: 'instagram', orders: 2, grossSalesCents: 3000 }, { source: 'direct', orders: 1, grossSalesCents: 1000 }, { source: 'whatsapp', orders: 1, grossSalesCents: 1000 }].sort((x, y) => y.grossSalesCents - x.grossSalesCents || 0).map(x => x));
    expect((await oq(`SELECT count(*)::int n FROM orders WHERE tenant_id=$1`, [s.tenantId])).rows[0].n).toBe(4);
  });
});
