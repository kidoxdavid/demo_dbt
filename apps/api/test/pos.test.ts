import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookie ? ck(cookie) : {}) });
async function shop(n: string, o: { plan?: string; stock?: number; price?: number; barcode?: string; sku?: string; federal?: boolean } = {}) {
  const s = await k.seller(n);
  await oq(`UPDATE tenants SET plan_id=(SELECT id FROM plans WHERE code=$2) WHERE id=$1`, [s.tenantId, o.plan ?? 'professional']);
  if (o.federal) await call('PATCH', '/api/seller/business', s.cookie, { region: 'AB', taxFederal: true });
  const p = await k.product(s.cookie, { variants: [{ title: 'Std', priceCents: o.price ?? 1000, costCents: 400, stock: o.stock ?? 10, barcode: o.barcode, sku: o.sku }] });
  return { s, p };
}
const sale = (cookie: string, variantId: string, quantity = 1, extra: object = {}) => call('POST', '/api/seller/pos/sales', cookie, { items: [{ variantId, quantity }], paymentMethod: 'cash', ...extra });

describe('EazyPOS', () => {
  it('is a plan feature: starter gets 402, professional works', async () => {
    const a = await shop('pos1', { plan: 'starter' });
    expect((await sale(a.s.cookie, a.p.variantId)).statusCode).toBe(402);
    expect((await call('GET', '/api/seller/pos/lookup?q=x', a.s.cookie)).statusCode).toBe(402);
    const b = await shop('pos2');
    expect((await sale(b.s.cookie, b.p.variantId)).statusCode).toBe(201);
  });
  it('looks up by barcode and SKU first, then by name; escapes wildcards', async () => {
    const { s, p } = await shop('pos3', { barcode: '0123456789012', sku: 'MUG-1' });
    const byCode = (await call('GET', '/api/seller/pos/lookup?q=0123456789012', s.cookie)).json(); expect(byCode[0].variantId).toBe(p.variantId); expect(byCode[0].available).toBe(10);
    expect((await call('GET', '/api/seller/pos/lookup?q=mug-1', s.cookie)).json()[0].variantId).toBe(p.variantId);
    expect((await call('GET', '/api/seller/pos/lookup?q=Stand', s.cookie)).json().length).toBe(1);
    expect((await call('GET', '/api/seller/pos/lookup?q=%25', s.cookie)).json().length).toBe(0);
  });
  it('a counter sale: stock down, tax added, balanced ledger, no platform fee, change for cash', async () => {
    const { s, p } = await shop('pos4', { federal: true, price: 2000 });
    const r = await sale(s.cookie, p.variantId, 2, { tenderedCents: 5000 }); expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ subtotalCents: 4000, taxCents: 200, totalCents: 4200, changeCents: 800 });
    expect(await k.stock(p.variantId)).toMatchObject({ on_hand: 8, reserved: 0 });
    const led = (await oq('SELECT account, amount_cents::int a FROM ledger_entries WHERE order_id=$1', [r.json().id])).rows; const by = (a: string) => led.filter(x => x.account === a).reduce((n, x) => n + x.a, 0);
    expect({ cash: by('cash_received'), fee: by('platform_fee'), tax: by('tax_payable'), payable: by('seller_payable') }).toEqual({ cash: 4200, fee: 0, tax: -200, payable: -4000 });
    expect(led.reduce((n, x) => n + x.a, 0)).toBe(0);
    const o = (await oq(`SELECT status, channel, platform_fee_bps, source FROM orders WHERE id=$1`, [r.json().id])).rows[0]; expect(o).toMatchObject({ status: 'completed', channel: 'pos', platform_fee_bps: 0, source: 'pos' });
    expect((await oq(`SELECT count(*)::int n FROM audit_logs WHERE action='pos.sale' AND tenant_id=$1`, [s.tenantId])).rows[0].n).toBe(1);
  });
  it('a quote shows the same total as the sale and changes nothing', async () => {
    const { s, p } = await shop('pos13', { federal: true, price: 2000 });
    const q = (await call('POST', '/api/seller/pos/quote', s.cookie, { items: [{ variantId: p.variantId, quantity: 2 }] })).json();
    expect(q).toMatchObject({ subtotalCents: 4000, taxCents: 200, totalCents: 4200 }); expect(await k.stock(p.variantId)).toMatchObject({ on_hand: 10 });
    expect((await sale(s.cookie, p.variantId, 2)).json().totalCents).toBe(q.totalCents);
  });
  it('refuses cash that does not cover the total, and sells nothing', async () => {
    const { s, p } = await shop('pos5');
    const r = await sale(s.cookie, p.variantId, 1, { tenderedCents: 500 }); expect(r.statusCode).toBe(422); expect(r.json().error).toBe('tendered_too_low:1000');
    expect(await k.stock(p.variantId)).toMatchObject({ on_hand: 10 });
  });
  it('discount codes work at the counter', async () => {
    const { s, p } = await shop('pos6');
    await call('POST', '/api/seller/discounts', s.cookie, { code: 'SHOP10', kind: 'percent', value: 10 });
    const r = await sale(s.cookie, p.variantId, 1, { discountCode: 'shop10' }); expect(r.json()).toMatchObject({ discountCents: 100, totalCents: 900 });
  });
  it('never oversells, and cannot take units an online checkout has reserved', async () => {
    const { s, p } = await shop('pos7', { stock: 3 });
    const online = await k.checkout(s.slug, p.variantId, 2); expect(online.statusCode).toBe(201);            // reserves 2 of 3
    expect((await sale(s.cookie, p.variantId, 2)).json().error).toBe('out_of_stock');
    expect((await sale(s.cookie, p.variantId, 1)).statusCode).toBe(201);
    const both = await Promise.all([sale(s.cookie, p.variantId, 1), sale(s.cookie, p.variantId, 1)]);
    expect(both.map(x => x.statusCode)).toEqual([409, 409]);
    expect((await k.stock(p.variantId)).on_hand).toBe(2);
  });
  it('concurrent counter sales of the last unit: exactly one wins', async () => {
    const { s, p } = await shop('pos8', { stock: 1 });
    const rs = await Promise.all([sale(s.cookie, p.variantId), sale(s.cookie, p.variantId), sale(s.cookie, p.variantId)]);
    expect(rs.map(x => x.statusCode).sort()).toEqual([201, 409, 409]); expect((await k.stock(p.variantId)).on_hand).toBe(0);
  });
  it('a counter sale can be refunded (and restocked) without a payment provider', async () => {
    const { s, p } = await shop('pos9');
    const r = (await sale(s.cookie, p.variantId, 2)).json();
    const rf = await call('POST', `/api/seller/orders/${r.id}/refunds`, s.cookie, { amountCents: r.totalCents, reason: 'Customer returned', restock: true });
    expect(rf.statusCode).toBe(201); expect(rf.json().status).toBe('refunded'); expect((await k.stock(p.variantId)).on_hand).toBe(10);
    expect((await oq('SELECT provider FROM refunds WHERE order_id=$1', [r.id])).rows[0].provider).toBe('pos');
    const led = (await oq('SELECT amount_cents::int a FROM ledger_entries WHERE order_id=$1', [r.id])).rows; expect(led.reduce((n, x) => n + x.a, 0)).toBe(0);
  });
  it('receipt and end-of-day summary (time zone aware, net of refunds)', async () => {
    const { s, p } = await shop('pos10');
    const a = (await sale(s.cookie, p.variantId, 1, { paymentMethod: 'cash' })).json(); await sale(s.cookie, p.variantId, 2, { paymentMethod: 'card_terminal' });
    const rc = (await call('GET', `/api/seller/pos/sales/${a.id}/receipt`, s.cookie)).json(); expect(rc).toMatchObject({ total_cents: 1000, payment_method: 'cash' }); expect(rc.lines[0]).toMatchObject({ quantity: 1 });
    await call('POST', `/api/seller/orders/${a.id}/refunds`, s.cookie, { amountCents: 1000, reason: 'Wrong item' });
    const sm = (await call('GET', '/api/seller/pos/summary?tz=America/Edmonton', s.cookie)).json();
    expect(sm.sales).toBe(2); expect(sm.totalCents).toBe(2000); expect(sm.byMethod.find((x: any) => x.method === 'cash').totalCents).toBe(0);
    expect((await call('GET', '/api/seller/pos/summary?tz=Nope/Zone', s.cookie)).statusCode).toBe(400);
    expect((await call('GET', '/api/seller/orders', s.cookie)).json().every((o: any) => o.channel === 'pos')).toBe(true);
  });
  it('staff may sell; other stores cannot see or sell this store\'s items', async () => {
    const a = await shop('pos11'); const b = await shop('pos12');
    await oq(`UPDATE memberships SET role='staff' WHERE tenant_id=$1`, [a.s.tenantId]);
    expect((await sale(a.s.cookie, a.p.variantId)).statusCode).toBe(201);
    expect((await sale(b.s.cookie, a.p.variantId)).statusCode).toBe(422);
    const rid = (await sale(a.s.cookie, a.p.variantId)).json().id;
    expect((await call('GET', `/api/seller/pos/sales/${rid}/receipt`, b.s.cookie)).statusCode).toBe(404);
    expect((await call('GET', '/api/seller/pos/lookup?q=Stand', b.s.cookie)).json().every((x: any) => x.variantId !== a.p.variantId)).toBe(true);
  });
});
