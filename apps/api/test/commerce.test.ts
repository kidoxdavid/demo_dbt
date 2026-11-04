import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { releaseExpiredReservations, settlePayment } from '../src/modules/commerce.js';

let app: FastifyInstance;
const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

async function oq(sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_admin','on',true)`); const r = await c.query(sql, params); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const ck = (cookie: string) => ({ cookies: { eazy_sid: cookie } });

async function seller(n: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `${n}@c.test`, password: 'correct-horse-battery', fullName: n, businessName: `${n} Biz`, storeSlug: `${n}-shop` } });
  const cookie = r.cookies.find(c => c.name === 'eazy_sid')!.value;
  await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(cookie), payload: { category: 'gifts', description: 'x', fulfilment: { pickup: true, delivery: true, shipping: false } } });
  await app.inject({ method: 'POST', url: '/api/seller/store/publish', ...ck(cookie) });
  await oq(`UPDATE stores SET delivery_fee_cents=500 WHERE slug=$1`, [`${n}-shop`]);
  return { cookie, slug: `${n}-shop`, tenantId: r.json().tenantId as string };
}
async function product(cookie: string, over: Record<string, unknown> = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/seller/products', ...ck(cookie), payload: { name: 'Stand', status: 'active', variants: [{ title: 'Black', priceCents: 2000, costCents: 800, stock: 5 }], ...over } });
  expect(r.statusCode).toBe(201);
  const list = (await app.inject({ method: 'GET', url: '/api/seller/products', ...ck(cookie) })).json();
  const p = list.find((x: any) => x.id === r.json().id);
  return { id: r.json().id as string, variantId: p.variants[0].id as string };
}
const checkout = (slug: string, variantId: string, quantity = 1, extra: object = {}) => app.inject({ method: 'POST', url: `/api/public/stores/${slug}/checkout`,
  payload: { items: [{ variantId, quantity }], email: 'buyer@x.test', name: 'Buyer', fulfilment: 'pickup', ...extra } });
const stock = async (variantId: string) => (await oq('SELECT on_hand, reserved FROM inventory_levels WHERE variant_id=$1', [variantId])).rows[0];

describe('catalogue', () => {
  it('creates products with variants, custom attributes, stock, and enforces plan limits', async () => {
    const s = await seller('cat1');
    await product(s.cookie, { attributes: { material: 'PLA', waterproof: true } });
    await oq(`UPDATE plans SET limits = jsonb_set(limits,'{active_products}','2') WHERE code='starter'`);
    await product(s.cookie, { name: 'Two' });
    const over = await app.inject({ method: 'POST', url: '/api/seller/products', ...ck(s.cookie), payload: { name: 'Three', status: 'active', variants: [{ priceCents: 100 }] } });
    expect(over.statusCode).toBe(402);
    await app.inject({ method: 'POST', url: '/api/seller/products', ...ck(s.cookie), payload: { name: 'Draft ok', variants: [{ priceCents: 100 }] } }).then(r => expect(r.statusCode).toBe(201));
    await oq(`UPDATE plans SET limits = jsonb_set(limits,'{active_products}','50') WHERE code='starter'`);
  });
  it('rejects duplicate SKUs, negative prices and unknown fields', async () => {
    const s = await seller('cat2');
    await product(s.cookie, { variants: [{ sku: 'A1', priceCents: 100 }] });
    expect((await app.inject({ method: 'POST', url: '/api/seller/products', ...ck(s.cookie), payload: { name: 'd', variants: [{ sku: 'A1', priceCents: 100 }] } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/seller/products', ...ck(s.cookie), payload: { name: 'd', variants: [{ priceCents: -5 }] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/seller/products', ...ck(s.cookie), payload: { name: 'd', tenant_id: 'x', variants: [{ priceCents: 5 }] } })).statusCode).toBe(400);
  });
  it('stock adjustments are recorded and cannot go below reserved or zero', async () => {
    const s = await seller('cat3'); const p = await product(s.cookie);
    expect((await app.inject({ method: 'POST', url: `/api/seller/variants/${p.variantId}/stock`, ...ck(s.cookie), payload: { delta: 3 } })).json().on_hand).toBe(8);
    expect((await app.inject({ method: 'POST', url: `/api/seller/variants/${p.variantId}/stock`, ...ck(s.cookie), payload: { delta: -50 } })).statusCode).toBe(409);
    expect((await oq('SELECT count(*)::int n FROM inventory_movements WHERE variant_id=$1', [p.variantId])).rows[0].n).toBe(2);
  });
});

describe('checkout, inventory & payments', () => {
  it('uses DB prices, reserves stock, and only shows published stores', async () => {
    const s = await seller('co1'); const p = await product(s.cookie);
    const r = await checkout(s.slug, p.variantId, 2, { fulfilment: 'delivery', address: { line1: '1 St', city: 'Calgary', region: 'AB', postalCode: 'T2T2T2', country: 'CA' }, price: 1 } as any);
    expect(r.statusCode).toBe(400); // unknown field (client-supplied price) rejected
    const ok = await checkout(s.slug, p.variantId, 2, { fulfilment: 'delivery', address: { line1: '1 St', city: 'Calgary', region: 'AB', postalCode: 'T2T2T2', country: 'CA' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().totalCents).toBe(4500); // 2*2000 + 500 delivery
    expect(ok.json().paymentProvider.status).toBe('simulated');
    expect(await stock(p.variantId)).toEqual({ on_hand: 5, reserved: 2 });
    expect((await checkout('nope-shop', p.variantId)).statusCode).toBe(404);
  });
  it('two buyers racing for the last unit: exactly one succeeds, never oversold', async () => {
    const s = await seller('race1'); const p = await product(s.cookie, { variants: [{ priceCents: 1000, stock: 1 }] });
    const rs = await Promise.all(Array.from({ length: 6 }, () => checkout(s.slug, p.variantId)));
    expect(rs.filter(r => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter(r => r.statusCode === 409)).toHaveLength(5);
    expect(await stock(p.variantId)).toEqual({ on_hand: 1, reserved: 1 });
  });
  it('payment success: decrements stock, marks paid, writes a balanced ledger with the plan fee; replay is idempotent', async () => {
    const s = await seller('pay1'); const p = await product(s.cookie);
    const c = (await checkout(s.slug, p.variantId, 2)).json();
    const first = await app.inject({ method: 'POST', url: `/api/public/payments/${c.paymentId}/simulate`, payload: { outcome: 'succeeded' } });
    expect(first.json()).toMatchObject({ status: 'succeeded', replay: false });
    const again = await app.inject({ method: 'POST', url: `/api/public/payments/${c.paymentId}/simulate`, payload: { outcome: 'succeeded' } });
    expect(again.json().replay).toBe(true);
    expect(await stock(p.variantId)).toEqual({ on_hand: 3, reserved: 0 });
    const order = (await app.inject({ method: 'GET', url: `/api/public/orders/${c.orderToken}` })).json();
    expect(order.status).toBe('paid');
    const led = (await oq('SELECT account, amount_cents::int a FROM ledger_entries WHERE tenant_id=$1', [s.tenantId])).rows;
    expect(led).toHaveLength(3);
    expect(led.reduce((n, r) => n + r.a, 0)).toBe(0);
    expect(led.find(r => r.account === 'cash_received')!.a).toBe(4000);
    expect(led.find(r => r.account === 'platform_fee')!.a).toBe(-120); // 3% of 4000
    expect(led.find(r => r.account === 'seller_payable')!.a).toBe(-3880);
  });
  it('payment failure releases the reservation and cancels the order', async () => {
    const s = await seller('pay2'); const p = await product(s.cookie);
    const c = (await checkout(s.slug, p.variantId, 3)).json();
    await app.inject({ method: 'POST', url: `/api/public/payments/${c.paymentId}/simulate`, payload: { outcome: 'failed' } });
    expect(await stock(p.variantId)).toEqual({ on_hand: 5, reserved: 0 });
    expect((await app.inject({ method: 'GET', url: `/api/public/orders/${c.orderToken}` })).json().status).toBe('cancelled');
  });
  it('abandoned checkout: expired reservations are released by the sweeper', async () => {
    const s = await seller('exp1'); const p = await product(s.cookie);
    const c = (await checkout(s.slug, p.variantId, 4)).json();
    await oq(`UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE public_token=$1`, [c.orderToken]);
    expect((await checkout(s.slug, p.variantId, 2)).statusCode).toBe(409); // blocked while reserved
    expect(await releaseExpiredReservations()).toBeGreaterThanOrEqual(1);
    expect(await stock(p.variantId)).toEqual({ on_hand: 5, reserved: 0 });
    expect((await checkout(s.slug, p.variantId, 2)).statusCode).toBe(201);
  });
  it('payment succeeds after expiry and stock is gone: money is kept, order not fulfilled, flagged for refund', async () => {
    const s = await seller('late1'); const p = await product(s.cookie, { variants: [{ priceCents: 1000, stock: 1 }] });
    const a = (await checkout(s.slug, p.variantId)).json();
    await oq(`UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE public_token=$1`, [a.orderToken]);
    await releaseExpiredReservations();
    expect((await checkout(s.slug, p.variantId)).statusCode).toBe(201); // someone else takes the last unit
    const r = await app.inject({ method: 'POST', url: `/api/public/payments/${a.paymentId}/simulate`, payload: { outcome: 'succeeded' } });
    expect(r.json()).toMatchObject({ status: 'succeeded', needsRefund: true });
    expect((await oq('SELECT needs_refund FROM payments WHERE id=$1', [a.paymentId])).rows[0].needs_refund).toBe(true);
    expect(await stock(p.variantId)).toEqual({ on_hand: 1, reserved: 1 });
  });
  it('rejects fulfilment the seller does not offer, missing address, inactive products, and suspended sellers', async () => {
    const s = await seller('rule1'); const p = await product(s.cookie); const d = await product(s.cookie, { name: 'Hidden', status: 'draft' });
    expect((await checkout(s.slug, p.variantId, 1, { fulfilment: 'delivery' })).statusCode).toBe(422);
    expect((await checkout(s.slug, d.variantId)).statusCode).toBe(422);
    await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(s.cookie), payload: { fulfilment: { pickup: false, delivery: true, shipping: false } } });
    expect((await checkout(s.slug, p.variantId)).statusCode).toBe(422);
    await oq(`UPDATE tenants SET status='suspended' WHERE id=$1`, [s.tenantId]); await oq(`UPDATE stores SET status='suspended' WHERE tenant_id=$1`, [s.tenantId]);
    expect((await checkout(s.slug, p.variantId, 1, { fulfilment: 'delivery', address: { line1: 'a', city: 'b', region: 'c', postalCode: 'T2T2T2', country: 'CA' } })).statusCode).toBe(404);
  });
  it('hides drafts from the public product list and exposes availability without internal stock counts', async () => {
    const s = await seller('list1'); await product(s.cookie); await product(s.cookie, { name: 'Secret draft', status: 'draft' });
    const r = (await app.inject({ method: 'GET', url: `/api/public/stores/${s.slug}/products` })).json();
    expect(r.map((x: any) => x.name)).toEqual(['Stand']);
    expect(JSON.stringify(r)).not.toMatch(/costCents|on_hand|onHand/);
  });
});

describe('seller orders, isolation & reporting', () => {
  it('seller sees only own orders; manipulated order id from another tenant is a 404', async () => {
    const a = await seller('iso1'); const b = await seller('iso2'); const pa = await product(a.cookie); const pb = await product(b.cookie);
    await checkout(a.slug, pa.variantId); const ob = (await checkout(b.slug, pb.variantId)).json();
    const bOrders = (await app.inject({ method: 'GET', url: '/api/seller/orders', ...ck(b.cookie) })).json();
    expect((await app.inject({ method: 'GET', url: `/api/seller/orders/${bOrders[0].id}`, ...ck(a.cookie) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/seller/orders/${bOrders[0].id}/status`, ...ck(a.cookie), payload: { status: 'processing' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/seller/orders', ...ck(a.cookie) })).json()).toHaveLength(1);
    expect(ob.orderToken).toBeTruthy();
  });
  it('enforces the order state machine', async () => {
    const s = await seller('flow1'); const p = await product(s.cookie);
    const c = (await checkout(s.slug, p.variantId)).json();
    const id = (await app.inject({ method: 'GET', url: '/api/seller/orders', ...ck(s.cookie) })).json()[0].id;
    const go = (status: string) => app.inject({ method: 'POST', url: `/api/seller/orders/${id}/status`, ...ck(s.cookie), payload: { status } });
    expect((await go('processing')).statusCode).toBe(409); // unpaid
    await app.inject({ method: 'POST', url: `/api/public/payments/${c.paymentId}/simulate`, payload: { outcome: 'succeeded' } });
    expect((await go('completed')).statusCode).toBe(409);
    expect((await go('processing')).statusCode).toBe(200);
    expect((await go('shipped')).statusCode).toBe(200);
    expect((await go('completed')).statusCode).toBe(200);
    expect((await go('cancelled')).statusCode).toBe(409);
  });
  it('dashboard separates sales, COGS, gross profit and fees, and flags missing costs', async () => {
    const s = await seller('dash1');
    const p = await product(s.cookie, { variants: [{ priceCents: 2000, costCents: 800, stock: 10 }] });
    const q = await product(s.cookie, { name: 'No cost', variants: [{ priceCents: 1000, stock: 10 }] });
    for (const [v, n] of [[p.variantId, 2], [q.variantId, 1]] as const) {
      const c = (await checkout(s.slug, v, n)).json();
      await app.inject({ method: 'POST', url: `/api/public/payments/${c.paymentId}/simulate`, payload: { outcome: 'succeeded' } });
    }
    await checkout(s.slug, p.variantId); // unpaid, must not count
    const d = (await app.inject({ method: 'GET', url: '/api/seller/dashboard', ...ck(s.cookie) })).json();
    expect(d).toMatchObject({ orders: 2, grossSalesCents: 5000, cogsCents: 1600, grossProfitCents: 2400, grossProfitIsPartial: true, lineItemsMissingCost: 1, platformFeesCents: 150 });
    expect(d.notes.join(' ')).toMatch(/not profit/);
  });
  it('dashboard reports COGS and profit as unknown (null), not zero, when no sold item has a cost', async () => {
    const s = await seller('dash2'); const q = await product(s.cookie, { variants: [{ priceCents: 1000, stock: 5 }] });
    const c = (await checkout(s.slug, q.variantId)).json();
    await app.inject({ method: 'POST', url: `/api/public/payments/${c.paymentId}/simulate`, payload: { outcome: 'succeeded' } });
    const d = (await app.inject({ method: 'GET', url: '/api/seller/dashboard', ...ck(s.cookie) })).json();
    expect(d).toMatchObject({ grossSalesCents: 1000, cogsCents: null, grossProfitCents: null, grossProfitIsPartial: true });
    const empty = (await app.inject({ method: 'GET', url: '/api/seller/dashboard', ...ck((await seller('dash3')).cookie) })).json();
    expect(empty).toMatchObject({ orders: 0, cogsCents: 0, grossProfitCents: 0, grossProfitIsPartial: false });
  });
  it('ledger and inventory history are immutable; DB refuses oversell even if app logic is bypassed', async () => {
    const s = await seller('imm1'); const p = await product(s.cookie);
    const c = (await checkout(s.slug, p.variantId)).json();
    await app.inject({ method: 'POST', url: `/api/public/payments/${c.paymentId}/simulate`, payload: { outcome: 'succeeded' } });
    const before = (await oq('SELECT count(*)::int n FROM ledger_entries')).rows[0].n;
    await expect(oq('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
    await expect(oq(`UPDATE ledger_entries SET amount_cents=1`)).rejects.toThrow(/append-only/);
    await expect(oq('DELETE FROM inventory_movements')).rejects.toThrow(/append-only/);
    expect((await oq('SELECT count(*)::int n FROM ledger_entries')).rows[0].n).toBe(before);
    await expect(oq('UPDATE inventory_levels SET reserved = on_hand + 1 WHERE variant_id=$1', [p.variantId])).rejects.toThrow();
  });
  it('an unbalanced ledger group is rejected at commit', async () => {
    const s = await seller('bal1');
    const c = await owner.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_admin','on',true)`);
      await c.query(`INSERT INTO ledger_entries(tenant_id,group_id,account,amount_cents,currency) VALUES ($1,gen_random_uuid(),'cash_received',100,'CAD')`, [s.tenantId]);
      await expect(c.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });
  it('settlePayment on an unknown provider reference is a clean 404', async () => {
    await expect(settlePayment('sim_unknown', 'succeeded')).rejects.toMatchObject({ status: 404 });
  });
});

describe('store settings', () => {
  it('owner can set tagline and delivery fee; fee is used by checkout; strict validation', async () => {
    const s = await seller('set1'); const p = await product(s.cookie);
    const r = await app.inject({ method: 'PATCH', url: '/api/seller/store', ...ck(s.cookie), payload: { tagline: 'Hand made', deliveryFeeCents: 750 } });
    expect(r.json()).toMatchObject({ tagline: 'Hand made', delivery_fee_cents: 750 });
    const c = await checkout(s.slug, p.variantId, 1, { fulfilment: 'delivery', address: { line1: 'a', city: 'b', region: 'c', postalCode: 'T2T2T2', country: 'CA' } });
    expect(c.json().shippingCents).toBe(750);
    expect((await app.inject({ method: 'PATCH', url: '/api/seller/store', ...ck(s.cookie), payload: { slug: 'hijack' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/seller/store', ...ck(s.cookie), payload: { deliveryFeeCents: -1 } })).statusCode).toBe(400);
  });
});
