import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });
const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck(cookie) });
const ask = async (cookie: string, body: object) => (await call('POST', '/api/seller/assist/ask', cookie, body)).json();

describe('EazyAssist', () => {
  it('profit summary: every figure is derived from the records and labelled; platform fees are separate', async () => {
    const s = await k.seller('as1'); const p = await k.product(s.cookie, { variants: [{ title: 'A', priceCents: 10000, costCents: 4000, stock: 20 }] });
    await call('POST', '/api/seller/discounts', s.cookie, { code: 'TEN', kind: 'percent', value: 10 });
    const o = (await k.checkout(s.slug, p.variantId, 2, { discountCode: 'TEN' })).json(); await k.pay(o.paymentId);   // 20000 - 2000 discount; cost 8000; fee 3% of 18000 = 540
    const r = await ask(s.cookie, { id: 'profit_summary' });
    expect(r.matched).toBe(true); expect(r.figures).toMatchObject({ orders: 1, salesCents: 20000, discountsCents: 2000, costOfGoodsCents: 8000, grossProfitCents: 10000, platformFeesCents: 540, profitAfterFeesCents: 9460 });
    expect(r.caveats.join(' ')).toMatch(/not net income/); expect(r.method).toMatch(/Not AI/);
  });
  it('keyword questions map to the right query; unknown questions are declined, not invented', async () => {
    const s = await k.seller('as2'); const p = await k.product(s.cookie, { name: 'Candle', variants: [{ title: 'A', priceCents: 1500, costCents: 500, stock: 3 }] });
    await k.pay((await k.checkout(s.slug, p.variantId, 1)).json().paymentId);
    expect((await ask(s.cookie, { question: 'What are my best selling products?' })).id).toBe('top_products');
    expect((await ask(s.cookie, { question: 'which items are running low' })).id).toBe('low_stock');
    const top = await ask(s.cookie, { id: 'top_products' }); expect(top.rows[0]).toMatchObject({ name: 'Candle', units: 1, revenue: 1500 });
    const low = await ask(s.cookie, { id: 'low_stock' }); expect(low.rows[0]).toMatchObject({ name: 'Candle', available: 2 });
    const rs = await ask(s.cookie, { id: 'restock' }); expect(rs.rows[0]).toMatchObject({ name: 'Candle', sold_30d: 1 });
    const unk = await ask(s.cookie, { question: 'Should I buy a boat?' }); expect(unk.matched).toBe(false); expect(unk.questions.length).toBeGreaterThan(5);
    for (const q of (await call('GET', '/api/seller/assist/questions', s.cookie)).json()) expect((await ask(s.cookie, { id: q.id })).matched).toBe(true);   // every catalogue question runs
  });
  it('is private to the business and to owners/managers', async () => {
    const a = await k.seller('as3'); const b = await k.seller('as3b'); const p = await k.product(a.cookie, { name: 'Secret' });
    await k.pay((await k.checkout(a.slug, p.variantId, 1)).json().paymentId);
    expect((await ask(b.cookie, { id: 'top_products' })).rows).toEqual([]);
    await oq(`UPDATE memberships SET role='staff' WHERE tenant_id=$1`, [a.tenantId]);
    expect((await call('POST', '/api/seller/assist/ask', a.cookie, { id: 'top_products' })).statusCode).toBe(403);
  });
});
