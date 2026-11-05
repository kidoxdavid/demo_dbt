import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookie ? ck(cookie) : {}) });
async function shop(n: string, price = 10000, cost = 4000) { const s = await k.seller(n); const p = await k.product(s.cookie, { variants: [{ title: 'Std', priceCents: price, costCents: cost, stock: 50 }] }); return { s, p }; }
const profit = async (cookie: string) => (await call('GET', '/api/seller/profit', cookie)).json();
const addr = { line1: '1 Main', city: 'X', region: 'AB', postalCode: 'T2T2T2', country: 'CA' };

describe('what you keep', () => {
  it('one discounted order: every cost is subtracted and every number is explained', async () => {
    const { s, p } = await shop('pf1');
    await call('POST', '/api/seller/discounts', s.cookie, { code: 'TEN', kind: 'percent', value: 10 });
    const o = (await k.checkout(s.slug, p.variantId, 2, { discountCode: 'TEN' })).json(); await k.pay(o.paymentId);
    const r = await profit(s.cookie);
    expect(r.totals).toMatchObject({ orders: 1, salesCents: 18000, discountsCents: 2000, cogsCents: 8000, platformFeesCents: 540, processingFeesCents: 552, keepCents: 8908, expensesCents: 0, keepAfterExpensesCents: 8908 });
    expect(r.byProduct[0]).toMatchObject({ name: 'Stand', units: 2, salesCents: 18000, keepCents: 8908, keepPerUnitCents: 4454 });
    expect(r.flags).toMatchObject({ itemsMissingCost: 0, processingFeeIsEstimate: true }); expect(r.notes.join(' ')).toMatch(/estimate/);
    const id = (await call('GET', '/api/seller/orders', s.cookie)).json()[0].id;
    expect((await call('GET', `/api/seller/orders/${id}/profit`, s.cookie)).json()).toMatchObject({ keepCents: 8908, platformFeeCents: 540, processingFeeCents: 552, processingFeeIsEstimate: true });
  });
  it('delivery you paid for is only counted once you enter it, and the page says what is missing', async () => {
    const { s, p } = await shop('pf2');
    const o = (await k.checkout(s.slug, p.variantId, 1, { fulfilment: 'delivery', address: addr })).json(); await k.pay(o.paymentId);       // customer paid the $5.00 flat fee
    let r = await profit(s.cookie); expect(r.totals.keepCents).toBe(5865); expect(r.flags.deliveryOrdersMissingCost).toBe(1);               // 10000 + 500 - 4000 - 300 - 335
    const id = (await call('GET', '/api/seller/orders', s.cookie)).json()[0].id;
    expect((await call('PATCH', `/api/seller/orders/${id}/delivery-cost`, s.cookie, { cents: 800 })).statusCode).toBe(200);
    r = await profit(s.cookie); expect(r.totals).toMatchObject({ deliveryPaidCents: 800, keepCents: 5065 }); expect(r.flags.deliveryOrdersMissingCost).toBe(0);
    expect((await call('PATCH', `/api/seller/orders/${id}/delivery-cost`, s.cookie, { cents: -1 })).statusCode).toBe(400);
  });
  it('a partial refund lowers what you keep (and gives back part of the platform fee)', async () => {
    const { s, p } = await shop('pf3'); const o = (await k.checkout(s.slug, p.variantId, 1)).json(); await k.pay(o.paymentId);
    const id = (await call('GET', '/api/seller/orders', s.cookie)).json()[0].id;
    expect((await call('POST', `/api/seller/orders/${id}/refunds`, s.cookie, { amountCents: 2000, reason: 'Small flaw' })).statusCode).toBe(201);
    expect((await profit(s.cookie)).totals).toMatchObject({ refundsCents: 2000, platformFeesCents: 240, keepCents: 3440 });                  // 10000 - 4000 - 240 - 320 - 2000
  });
  it('a counter sale has no platform fee and no card fee estimate', async () => {
    const { s, p } = await shop('pf4'); await oq(`UPDATE tenants SET plan_id=(SELECT id FROM plans WHERE code='professional') WHERE id=$1`, [s.tenantId]);
    expect((await call('POST', '/api/seller/pos/sales', s.cookie, { items: [{ variantId: p.variantId, quantity: 1 }], paymentMethod: 'cash' })).statusCode).toBe(201);
    const r = await profit(s.cookie); expect(r.totals).toMatchObject({ platformFeesCents: 0, processingFeesCents: 0, keepCents: 6000 }); expect(r.byChannel[0].channel).toBe('Counter'); expect(r.flags.processingFeeIsEstimate).toBe(false);
  });
  it('items with no cost price are flagged, not hidden', async () => {
    const s = await k.seller('pf5'); const p = await k.product(s.cookie, { variants: [{ title: 'NoCost', priceCents: 5000, stock: 5 }] });
    await k.pay((await k.checkout(s.slug, p.variantId, 1)).json().paymentId);
    const r = await profit(s.cookie); expect(r.flags.itemsMissingCost).toBe(1); expect(r.byProduct[0].missingCost).toBe(true);
  });
  it('expenses come off the bottom line; they are validated, audited, private and manager-only', async () => {
    const { s, p } = await shop('pf6'); const other = await k.seller('pf6b'); await k.pay((await k.checkout(s.slug, p.variantId, 1)).json().paymentId);
    const today = new Date().toISOString().slice(0, 10);
    const e = await call('POST', '/api/seller/expenses', s.cookie, { spentOn: today, category: 'ads', amountCents: 2500, note: 'Instagram boost' }); expect(e.statusCode).toBe(201);
    expect((await call('POST', '/api/seller/expenses', s.cookie, { spentOn: today, category: 'bribes', amountCents: 5 })).statusCode).toBe(400);
    expect((await call('POST', '/api/seller/expenses', s.cookie, { spentOn: today, category: 'ads', amountCents: 0 })).statusCode).toBe(400);
    let r = await profit(s.cookie); expect(r.totals).toMatchObject({ keepCents: 5380, expensesCents: 2500, keepAfterExpensesCents: 2880 }); expect(r.expenses).toEqual([{ category: 'ads', cents: 2500 }]);
    expect((await call('GET', '/api/seller/expenses', other.cookie)).json()).toEqual([]); expect((await call('DELETE', `/api/seller/expenses/${e.json().id}`, other.cookie)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/seller/expenses/${e.json().id}`, s.cookie)).statusCode).toBe(200); r = await profit(s.cookie); expect(r.totals.expensesCents).toBe(0);
    expect((await oq(`SELECT count(*)::int n FROM audit_logs WHERE tenant_id=$1 AND action LIKE 'expense.%'`, [s.tenantId])).rows[0].n).toBe(2);
    await oq(`UPDATE memberships SET role='staff' WHERE tenant_id=$1`, [s.tenantId]); expect((await call('GET', '/api/seller/profit', s.cookie)).statusCode).toBe(403);
  });
  it('is private to the business; unpaid orders do not count; daily rows follow the requested time zone', async () => {
    const a = await shop('pf7'); const b = await shop('pf7b'); await k.checkout(a.s.slug, a.p.variantId, 1);                                  // unpaid
    expect((await profit(a.s.cookie)).totals.orders).toBe(0);
    await k.pay((await k.checkout(a.s.slug, a.p.variantId, 1)).json().paymentId); expect((await profit(b.s.cookie)).totals.orders).toBe(0);
    const id = (await call('GET', '/api/seller/orders', a.s.cookie)).json().find((o: any) => o.status === 'paid').id;
    expect((await call('GET', `/api/seller/orders/${id}/profit`, b.s.cookie)).statusCode).toBe(404);
    await oq(`UPDATE orders SET created_at='2026-03-10T02:30:00Z' WHERE id=$1`, [id]);
    const utc = (await call('GET', '/api/seller/profit?tz=UTC', a.s.cookie)).json().byDay[0].date; const mt = (await call('GET', '/api/seller/profit?tz=America/Edmonton', a.s.cookie)).json().byDay[0].date;
    expect([utc, mt]).toEqual(['2026-03-10', '2026-03-09']); expect((await call('GET', '/api/seller/profit?tz=No/Where', a.s.cookie)).statusCode).toBe(400);
  });
});

describe('price check', () => {
  it('shows what you keep per sale, warns when a price loses money, and suggests a price for a 20% margin', async () => {
    const { s } = await shop('pf8');
    const pc = (body: object) => call('POST', '/api/seller/profit/price-check', s.cookie, body).then(r => r.json());
    expect(await pc({ priceCents: 10000, costCents: 4000 })).toMatchObject({ platformFeeCents: 300, processingFeeCents: 320, keepCents: 5380, marginPct: 53.8, verdict: 'healthy', platformFeeBps: 300 });
    expect(await pc({ priceCents: 900, costCents: 900 })).toMatchObject({ verdict: 'loses_money' });
    expect(await pc({ priceCents: 1000, costCents: 900 })).toMatchObject({ verdict: 'thin' });
    const sug = (await pc({ priceCents: 900, costCents: 900 })).suggestedPriceCents; expect(sug).toBe(1256);
    const at = await pc({ priceCents: sug, costCents: 900 }); expect(at.marginPct).toBeGreaterThanOrEqual(20);
    expect((await pc({ priceCents: 10000, costCents: 4000, discountPercent: 50 })).keepCents).toBeLessThan(5380 / 2);
    expect(await pc({ priceCents: 10000, costCents: 4000, channel: 'pos' })).toMatchObject({ processingFeeCents: 0, processingIsEstimate: false });
  });
});
