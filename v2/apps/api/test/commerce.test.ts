import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { mock, sign } from '../src/lib/payments.js';
import { processOutbox } from '../src/lib/outbox.js';
import { releaseExpiredReservations } from '../src/lib/orders.js';
import { ck, jpeg, login, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });

const ADDR = { name: 'Bea Buyer', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' };
const st = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', cookie) });

/** A shop whose products are published through the real studio flow. Returns the variant id of each. */
async function shop(products: { title: string; price?: number; stock?: number; oneOfAKind?: boolean; madeToOrder?: boolean; taxClass?: string }[], opts: { name?: string } = {}) {
  const s = await studioSeller(app, { shopName: opts.name }); const m = (await upload(app, s.cookie, await jpeg())).json(); const items: { id: string; variantId: string }[] = [];
  for (const p of products) {
    const r = (await st('POST', '/api/studio/products', s.cookie, { title: p.title, description: '', categorySlug: 'pottery-ceramics', priceCents: p.price ?? 4000, stock: p.stock ?? 5, attributes: {}, mediaIds: [m.id] })).json();
    if (p.oneOfAKind) await st('PATCH', `/api/studio/products/${r.id}`, s.cookie, { oneOfAKind: true });
    if (p.madeToOrder) await st('PATCH', `/api/studio/products/${r.id}`, s.cookie, { madeToOrder: true });
    const pr = await st('POST', `/api/studio/products/${r.id}/publish`, s.cookie, { acknowledged: true }); if (pr.statusCode !== 200) throw new Error(pr.body);
    const v = (await q('SELECT id FROM variants WHERE product_id=$1', [r.id])).rows[0]; items.push({ id: r.id, variantId: v.id });
  }
  return { ...s, items };
}

/** A buyer with a cookie jar (guest cart cookie, and optionally a signed-in session). */
function buyer(shopCookie?: string) {
  const jar: Record<string, string> = shopCookie ? { es_shop: shopCookie } : {};
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, headers, cookies: jar, ...(payload ? { payload } : {}) });
    for (const c of r.cookies) jar[c.name] = c.value; return r;
  };
  return { call, jar, add: (variantId: string, quantity = 1) => call('POST', '/api/cart/items', { variantId, quantity }), checkout: (headers: Record<string, string> = {}, email = 'bea@t.test') => call('POST', '/api/checkout', { email, address: ADDR }, headers) };
}
const pay = (ref: string, outcome: 'succeeded' | 'failed' = 'succeeded') => app.inject({ method: 'POST', url: `/api/dev/payments/${ref}/simulate`, payload: { outcome } });
const stock = async (variantId: string) => (await q('SELECT stock_on_hand AS on_hand, stock_reserved AS reserved FROM variants WHERE id=$1', [variantId])).rows[0] as { on_hand: number; reserved: number };
const ledgerSum = async (orderId: string) => Number((await q('SELECT coalesce(sum(amount_cents),0) s FROM ledger_entries WHERE order_id=$1', [orderId])).rows[0].s);
const balances = async (orderId: string) => Object.fromEntries((await q('SELECT account, sum(amount_cents)::int s FROM ledger_entries WHERE order_id=$1 GROUP BY account', [orderId])).rows.map(r => [r.account, r.s]));
async function paidOrder(s: Awaited<ReturnType<typeof shop>>, picks: { i: number; qty: number }[], email = 'bea@t.test') {
  const b = buyer(); for (const p of picks) expect((await b.add(s.items[p.i].variantId, p.qty)).statusCode).toBe(201);
  const co = await b.checkout({}, email); expect(co.statusCode).toBe(201); const o = co.json(); expect((await pay(o.payment.ref)).statusCode).toBe(200); return { b, o };
}

describe('basket', () => {
  it('guest basket works, adding twice sums, limits hold, and it merges into the account on sign-in', async () => {
    const s = await shop([{ title: 'Basket mug', stock: 3 }]); const v = s.items[0].variantId; const b = buyer();
    expect((await b.call('GET', '/api/cart')).json()).toMatchObject({ count: 0, itemsCents: 0 });
    expect((await b.add(v, 1)).json()).toMatchObject({ count: 1, itemsCents: 4000 }); expect((await b.add(v, 1)).json()).toMatchObject({ count: 2, itemsCents: 8000 });
    const over = await b.add(v, 2); expect(over.statusCode).toBe(409); expect(over.json().error).toBe('out_of_stock');
    expect((await b.call('POST', '/api/cart/items', { variantId: v, quantity: 0 })).statusCode).toBe(400);
    const u = await login(app, 'shop'); const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': 'shop' }, cookies: { es_cart: b.jar.es_cart }, payload: { email: u.email, password: 'correct-horse-battery' } });
    const mine = await app.inject({ method: 'GET', url: '/api/cart', cookies: { es_shop: r.cookies.find(c => c.name === 'es_shop')!.value } }); expect(mine.json().count).toBe(2);
  });
  it('refuses unavailable things now, not at the till: one-of-a-kind twice, vacation, unknown variant, sold out', async () => {
    const s = await shop([{ title: 'Only one', oneOfAKind: true, stock: 1 }, { title: 'Vacation item' }, { title: 'Gone', stock: 1 }]); const b = buyer();
    expect((await b.add(s.items[0].variantId)).statusCode).toBe(201); expect((await b.add(s.items[0].variantId)).json().error).toBe('already_in_basket');
    await q('UPDATE variants SET stock_on_hand=0 WHERE id=$1', [s.items[2].variantId]); expect((await b.add(s.items[2].variantId)).json().error).toBe('out_of_stock');
    await q('UPDATE shops SET vacation_mode=true WHERE id=$1', [s.shop.id]); expect((await b.add(s.items[1].variantId)).json().error).toBe('shop_on_vacation');
    expect((await b.add('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
  it('a new shop starts with a $9.00 flat default, not free shipping', async () => {
    const s = await shop([{ title: 'Default ship', price: 2000 }]); expect((await buyer().add(s.items[0].variantId)).json().shippingCents).toBe(900);
  });
  it('estimates shipping and arrival for one product, and rejects a bad postal code', async () => {
    const s = await shop([{ title: 'Ship est' }]);
    const r = await app.inject({ method: 'GET', url: `/api/products/${s.items[0].id}/shipping?postal=T2N` }); expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ postal: 'T2N' }); expect(r.json().shippingCents).toBeGreaterThanOrEqual(0); expect(r.json().arrives.min <= r.json().arrives.max).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/products/${s.items[0].id}/shipping?postal=ZZZ` })).statusCode).toBe(422);
  });
  it('shipping profiles: flat, per item, weight and free-over price a basket correctly', async () => {
    const s = await shop([{ title: 'Profile pot', price: 3000, stock: 10 }]); const v = s.items[0].variantId;
    const setProfile = async (p: object) => { await q('DELETE FROM shipping_profiles WHERE seller_id=$1', [s.sellerId]); await q(`INSERT INTO shipping_profiles(seller_id,name,is_default,rate_type,base_cents,extra_item_cents,per_kg_cents,free_over_cents) VALUES ($1,'t',true,$2,$3,$4,$5,$6)`, [s.sellerId, (p as any).t, (p as any).base, (p as any).extra ?? 0, (p as any).kg ?? 0, (p as any).free ?? null]); };
    const ship = async (qty: number) => { const b = buyer(); return (await b.add(v, qty)).json().shippingCents; };
    await setProfile({ t: 'flat', base: 900 }); expect(await ship(1)).toBe(900); expect(await ship(3)).toBe(900);
    await setProfile({ t: 'per_item', base: 900, extra: 300 }); expect(await ship(1)).toBe(900); expect(await ship(3)).toBe(1500);
    await setProfile({ t: 'flat', base: 900, free: 5000 }); expect(await ship(1)).toBe(900); expect(await ship(2)).toBe(0);
    await q('UPDATE variants SET weight_g=1500 WHERE id=$1', [v]); await setProfile({ t: 'weight', base: 500, kg: 200 }); expect(await ship(1)).toBe(900);          // 2 started kg
  });
});

describe('checkout, payment and the ledger', () => {
  it('totals are exact: items + shipping + GST, per seller, commission, and the ledger balances to zero', async () => {
    const a = await shop([{ title: 'Ledger A', price: 3333 }]); const c = await shop([{ title: 'Ledger C', price: 2501 }]); const b = buyer();
    await b.add(a.items[0].variantId, 3); await b.add(c.items[0].variantId, 1);
    const o = (await b.checkout()).json(); expect(o.totalCents).toBe(o.itemsCents + o.shippingCents + o.taxCents); expect(o.itemsCents).toBe(3333 * 3 + 2501);
    const sos = (await q('SELECT * FROM seller_orders WHERE order_id=$1', [o.orderId])).rows; expect(sos).toHaveLength(2);
    expect(sos.reduce((n, x) => n + x.total_cents, 0)).toBe(o.totalCents); expect(sos.reduce((n, x) => n + x.tax_cents, 0)).toBe(o.taxCents);
    for (const x of sos) { expect(x.total_cents).toBe(x.items_cents + x.shipping_cents + x.tax_cents); expect(x.commission_cents).toBe(Math.round(x.items_cents * x.commission_bps / 10000));
      const lines = (await q('SELECT * FROM order_lines WHERE seller_order_id=$1', [x.id])).rows; expect(lines.reduce((n, l) => n + l.commission_cents, 0)).toBe(x.commission_cents); }
    expect((await pay(o.payment.ref)).json().status).toBe('paid'); expect(await ledgerSum(o.orderId)).toBe(0);
    const bal = await balances(o.orderId); expect(bal.cash).toBe(o.totalCents); expect(bal.tax_payable).toBe(-o.taxCents);
    expect(bal.commission_revenue + bal.seller_payable + bal.tax_payable + bal.cash).toBe(0);
  });
  it('validates the address and email, refuses an empty basket, and holds stock', async () => {
    const s = await shop([{ title: 'Addr item', stock: 2 }]); const b = buyer();
    expect((await b.call('POST', '/api/checkout', { email: 'x@t.test', address: ADDR })).json().error).toBe('cart_empty');
    await b.add(s.items[0].variantId);
    expect((await b.call('POST', '/api/checkout', { email: 'x@t.test', address: { ...ADDR, postal: '12345' } })).statusCode).toBe(422);
    expect((await b.call('POST', '/api/checkout', { email: 'not-an-email', address: ADDR })).statusCode).toBe(400);
    expect((await b.call('POST', '/api/checkout', { address: ADDR })).statusCode).toBe(422);
    expect((await b.checkout()).statusCode).toBe(201); expect(await stock(s.items[0].variantId)).toEqual({ on_hand: 2, reserved: 1 });
  });
  it('the same Idempotency-Key returns the same order and holds stock once', async () => {
    const s = await shop([{ title: 'Idem item', stock: 5 }]); const b = buyer(); await b.add(s.items[0].variantId, 2);
    const one = await b.checkout({ 'idempotency-key': 'key-abcdefgh-1' }); const two = await b.checkout({ 'idempotency-key': 'key-abcdefgh-1' });
    expect(one.statusCode).toBe(201); expect(two.statusCode).toBe(200); expect(two.json().orderId).toBe(one.json().orderId); expect(two.json().replay).toBe(true);
    expect((await stock(s.items[0].variantId)).reserved).toBe(2);
  });
  it('a second checkout replaces the unpaid first one and does not double-hold stock', async () => {
    const s = await shop([{ title: 'Replace item', stock: 3 }]); const b = buyer(); await b.add(s.items[0].variantId, 2);
    const first = (await b.checkout()).json(); const second = (await b.checkout()).json(); expect(second.orderId).not.toBe(first.orderId);
    expect((await q('SELECT status FROM orders WHERE id=$1', [first.orderId])).rows[0].status).toBe('cancelled'); expect((await stock(s.items[0].variantId)).reserved).toBe(2);
  });
  it('the last unit goes to exactly one of two parallel checkouts', async () => {
    const s = await shop([{ title: 'Last one', stock: 1 }]); const b1 = buyer(), b2 = buyer(); await b1.add(s.items[0].variantId); await b2.add(s.items[0].variantId);
    const [r1, r2] = await Promise.all([b1.checkout({}, 'a@t.test'), b2.checkout({}, 'b@t.test')]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]); expect(await stock(s.items[0].variantId)).toEqual({ on_hand: 1, reserved: 1 });
  });
  it('payment commits the stock; failure and expiry release it', async () => {
    const s = await shop([{ title: 'Commit', stock: 4 }, { title: 'Fail', stock: 4 }, { title: 'Expire', stock: 4 }]);
    const ok = buyer(); await ok.add(s.items[0].variantId, 2); const o1 = (await ok.checkout()).json(); await pay(o1.payment.ref); expect(await stock(s.items[0].variantId)).toEqual({ on_hand: 2, reserved: 0 });
    const bad = buyer(); await bad.add(s.items[1].variantId, 2); const o2 = (await bad.checkout()).json(); expect((await pay(o2.payment.ref, 'failed')).json().status).toBe('failed');
    expect(await stock(s.items[1].variantId)).toEqual({ on_hand: 4, reserved: 0 }); expect(await ledgerSum(o2.orderId)).toBe(0);
    const ex = buyer(); await ex.add(s.items[2].variantId, 3); const o3 = (await ex.checkout()).json(); expect((await stock(s.items[2].variantId)).reserved).toBe(3);
    await releaseExpiredReservations(new Date(Date.now() + 3600_000)); expect(await stock(s.items[2].variantId)).toEqual({ on_hand: 4, reserved: 0 });
    expect((await q('SELECT status FROM orders WHERE id=$1', [o3.orderId])).rows[0].status).toBe('cancelled');
  });
  it('webhooks: bad signature 401, duplicate event applied once, amount mismatch refused', async () => {
    const s = await shop([{ title: 'Hook item' }]); const b = buyer(); await b.add(s.items[0].variantId); const o = (await b.checkout()).json();
    const body = JSON.stringify({ id: 'evt_test_12345', type: 'payment.succeeded', providerRef: o.payment.ref });
    const hit = (sig?: string) => app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: { 'content-type': 'application/json', ...(sig ? { 'x-signature': sig } : {}) }, payload: body });
    expect((await hit()).statusCode).toBe(401); expect((await hit('deadbeef')).statusCode).toBe(401);
    expect((await q('SELECT payment_status FROM orders WHERE id=$1', [o.orderId])).rows[0].payment_status).toBe('pending');
    expect((await hit(sign(body))).json().status).toBe('paid'); expect((await hit(sign(body))).json().status).toBe('duplicate_event');
    expect(Number((await q(`SELECT count(*) n FROM ledger_entries WHERE order_id=$1 AND memo='sale'`, [o.orderId])).rows[0].n)).toBe(4);
    const b2 = buyer(); await b2.add(s.items[0].variantId); const o2 = (await b2.checkout()).json(); await q('UPDATE payments SET amount_cents=amount_cents+1 WHERE order_id=$1', [o2.orderId]);
    expect((await pay(o2.payment.ref)).statusCode).toBe(409);
  });
  it('a payment that arrives after the hold expired re-takes the stock, or is refunded when it is gone', async () => {
    const s = await shop([{ title: 'Late A', stock: 1 }, { title: 'Late B', stock: 1 }]);
    const a = buyer(); await a.add(s.items[0].variantId); const oa = (await a.checkout()).json(); await releaseExpiredReservations(new Date(Date.now() + 3600_000));
    expect((await pay(oa.payment.ref)).json().status).toBe('paid'); expect(await stock(s.items[0].variantId)).toEqual({ on_hand: 0, reserved: 0 });
    const b = buyer(); await b.add(s.items[1].variantId); const ob = (await b.checkout()).json(); await releaseExpiredReservations(new Date(Date.now() + 3600_000));
    const c = buyer(); await c.add(s.items[1].variantId); const oc = (await c.checkout()).json(); await pay(oc.payment.ref);        // someone else takes the last one
    const late = await pay(ob.payment.ref); expect(late.json().status).not.toBe('paid');
    expect((await q('SELECT status FROM payments WHERE provider_ref=$1', [ob.payment.ref])).rows[0].status).not.toBe('pending'); expect(await stock(s.items[1].variantId)).toEqual({ on_hand: 0, reserved: 0 });
  });
  it('a pinned development clock moves delivery dates only, never the stock hold', async () => {
    const prev = process.env.EAZY_FAKE_NOW; process.env.EAZY_FAKE_NOW = '2020-01-01T12:00:00Z';
    try { const s = await shop([{ title: 'Pinned clock' }]); const b = buyer(); const cart = (await b.add(s.items[0].variantId)).json(); expect(cart.sellers[0].eta.min.startsWith('2020-01')).toBe(true);
      const o = (await b.checkout()).json(); expect(new Date(o.expiresAt).getTime()).toBeGreaterThan(Date.now()); }
    finally { if (prev === undefined) delete process.env.EAZY_FAKE_NOW; else process.env.EAZY_FAKE_NOW = prev; }
  });
  it('payments are refused when no provider is configured', async () => {
    const prev = process.env.PAYMENT_PROVIDER; process.env.PAYMENT_PROVIDER = 'none';
    try { const s = await shop([{ title: 'No pay' }]); const b = buyer(); await b.add(s.items[0].variantId); expect((await b.checkout()).statusCode).toBe(503); }
    finally { if (prev === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = prev; }
  });
  it('the ledger is append-only and rejects an unbalanced transaction at commit', async () => {
    const s = await shop([{ title: 'Ledger rules' }]); const { o } = await paidOrder(s, [{ i: 0, qty: 1 }]);
    await expect(q(`UPDATE ledger_entries SET amount_cents=1 WHERE order_id=$1`, [o.orderId])).rejects.toThrow(/append-only/); await expect(q(`DELETE FROM ledger_entries WHERE order_id=$1`, [o.orderId])).rejects.toThrow(/append-only/);
    await expect(q(`INSERT INTO ledger_entries(txn_id,account,amount_cents,memo) VALUES (gen_random_uuid(),'cash',100,'bad')`)).rejects.toThrow(/ledger_unbalanced/);
  });
});

describe('orders for buyers and sellers', () => {
  it('buyers see only their own orders; guests use the private link; costs and commission are never shown', async () => {
    const s = await shop([{ title: 'Visible' }]); const u1 = await login(app, 'shop'); const u2 = await login(app, 'shop');
    const b = buyer(u1.cookie); await b.add(s.items[0].variantId); const co = await b.checkout(); await pay(co.json().payment.ref); const id = co.json().orderId;
    expect((await b.call('GET', '/api/orders')).json().map((x: any) => x.id)).toContain(id); const view = (await b.call('GET', `/api/orders/${id}`)).json(); expect(JSON.stringify(view)).not.toMatch(/commission/i);
    expect((await buyer(u2.cookie).call('GET', `/api/orders/${id}`)).statusCode).toBe(404);
    const token = (await q('SELECT public_token t FROM orders WHERE id=$1', [id])).rows[0].t; expect((await app.inject({ method: 'GET', url: `/api/orders/by-token/${token}` })).json().id).toBe(id);
    expect((await app.inject({ method: 'GET', url: '/api/orders/by-token/' + 'x'.repeat(30) })).statusCode).toBe(404);
  });
  it('sellers work their own orders: accept, ship with tracking, deliver; wrong order of steps and other sellers are refused', async () => {
    const s = await shop([{ title: 'Flow' }]); const other = await studioSeller(app); const { o } = await paidOrder(s, [{ i: 0, qty: 1 }]);
    const list = (await st('GET', '/api/studio/orders', s.cookie)).json(); expect(list.total).toBe(1); expect(list.toShip).toBe(1); const id = list.items[0].id;
    expect((await st('GET', `/api/studio/orders/${id}`, other.cookie)).statusCode).toBe(404); expect((await st('POST', `/api/studio/orders/${id}/accept`, other.cookie, {})).statusCode).toBe(404);
    expect((await st('POST', `/api/studio/orders/${id}/deliver`, s.cookie, {})).statusCode).toBe(409);
    expect((await st('POST', `/api/studio/orders/${id}/ship`, s.cookie, { carrier: 'canada_post', trackingNumber: '!!' })).statusCode).toBe(400);
    expect((await st('POST', `/api/studio/orders/${id}/accept`, s.cookie, {})).json().status).toBe('accepted');
    expect((await st('POST', `/api/studio/orders/${id}/ship`, s.cookie, { carrier: 'canada_post', trackingNumber: '1234567890AB' })).json().status).toBe('shipped');
    expect((await st('POST', `/api/studio/orders/${id}/deliver`, s.cookie, {})).json().status).toBe('delivered');
    expect((await st('POST', `/api/studio/orders/${id}/cancel`, s.cookie, { reason: 'too late' })).statusCode).toBe(409);
    expect(Number((await q(`SELECT count(*) n FROM outbox_emails WHERE template='order_shipped' AND data->>'number'=$1`, [String((await q('SELECT number FROM orders WHERE id=$1', [o.orderId])).rows[0].number)])).rows[0].n)).toBe(1);
  });
});

describe('refunds', () => {
  const refund = (s: any, id: string, payload: object, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: `/api/studio/orders/${id}/refund`, payload, headers, ...ck('studio', s.cookie) });
  it('a partial refund returns exact shares; unit-by-unit refunds sum to the line exactly; over-refunds are refused', async () => {
    const s = await shop([{ title: 'Refund thirds', price: 1111, stock: 9 }]); const { o } = await paidOrder(s, [{ i: 0, qty: 3 }]);
    const so = (await q('SELECT * FROM seller_orders WHERE order_id=$1', [o.orderId])).rows[0]; const line = (await q('SELECT * FROM order_lines WHERE seller_order_id=$1', [so.id])).rows[0];
    let total = 0; for (let n = 0; n < 3; n++) { const r = await refund(s, so.id, { lines: [{ lineId: line.id, quantity: 1 }], reason: 'one at a time' }); expect(r.statusCode).toBe(200); total += r.json().amountCents; }
    expect(await ledgerSum(o.orderId)).toBe(0);
    const refs = (await q(`SELECT sum(commission_returned_cents)::int c, sum(tax_returned_cents)::int t FROM refunds WHERE seller_order_id=$1 AND status='succeeded'`, [so.id])).rows[0];
    expect(refs.c).toBe(line.commission_cents); expect(refs.t).toBe(line.tax_cents); expect(total).toBe(line.unit_price_cents * 3 + line.tax_cents);
    expect((await refund(s, so.id, { lines: [{ lineId: line.id, quantity: 1 }], reason: 'again' })).json().error).toBe('quantity_exceeds_remaining');
    expect((await refund(s, so.id, { lines: [], includeShipping: true, reason: 'ship' })).statusCode).toBe(200); expect((await refund(s, so.id, { lines: [], includeShipping: true, reason: 'ship again' })).json().error).toBe('not_refundable');        // fully refunded now
    expect((await q('SELECT payment_status FROM orders WHERE id=$1', [o.orderId])).rows[0].payment_status).toBe('refunded'); expect((await q('SELECT refunded_cents, total_cents FROM seller_orders WHERE id=$1', [so.id])).rows[0]).toMatchObject({ refunded_cents: so.total_cents });
    const bal = await balances(o.orderId); expect(bal.cash).toBe(0);
  });
  it('an order with two sellers is only partially refunded when one seller refunds; the other seller cannot refund it', async () => {
    const a = await shop([{ title: 'Two A' }]); const c = await shop([{ title: 'Two C' }]); const b = buyer(); await b.add(a.items[0].variantId); await b.add(c.items[0].variantId); const o = (await b.checkout()).json(); await pay(o.payment.ref);
    const soA = (await q('SELECT id FROM seller_orders WHERE order_id=$1 AND seller_id=$2', [o.orderId, a.sellerId])).rows[0].id; const lineA = (await q('SELECT id FROM order_lines WHERE seller_order_id=$1', [soA])).rows[0].id;
    expect((await refund(c, soA, { lines: [{ lineId: lineA, quantity: 1 }], reason: 'not mine' })).statusCode).toBe(404);
    expect((await refund(a, soA, { lines: [{ lineId: lineA, quantity: 1 }], reason: 'damaged' })).statusCode).toBe(200);
    expect((await q('SELECT payment_status FROM orders WHERE id=$1', [o.orderId])).rows[0].payment_status).toBe('partially_refunded');
    expect((await refund(a, soA, { lines: [], includeShipping: true, reason: 'shipping too' })).statusCode).toBe(200); expect((await refund(a, soA, { lines: [], includeShipping: true, reason: 'shipping twice' })).json().error).toMatch(/shipping_already_refunded|not_refundable/);
    expect(await ledgerSum(o.orderId)).toBe(0);
  });
  it('an Idempotency-Key makes a retried refund safe; restock puts units back', async () => {
    const s = await shop([{ title: 'Refund idem', stock: 5 }]); const { o } = await paidOrder(s, [{ i: 0, qty: 2 }]); expect((await stock(s.items[0].variantId)).on_hand).toBe(3);
    const so = (await q('SELECT id FROM seller_orders WHERE order_id=$1', [o.orderId])).rows[0].id; const lineId = (await q('SELECT id FROM order_lines WHERE seller_order_id=$1', [so])).rows[0].id;
    const body = { lines: [{ lineId, quantity: 1 }], reason: 'retry safe', restock: true }; const r1 = await refund(s, so, body, { 'idempotency-key': 'refund-key-0001' }); const r2 = await refund(s, so, body, { 'idempotency-key': 'refund-key-0001' });
    expect(r1.statusCode).toBe(200); expect(r2.json().replay).toBe(true); expect(r2.json().refundId).toBe(r1.json().refundId);
    expect(Number((await q(`SELECT count(*) n FROM refunds WHERE seller_order_id=$1`, [so])).rows[0].n)).toBe(1); expect((await stock(s.items[0].variantId)).on_hand).toBe(4);
  });
  it('a provider failure leaves nothing refunded and the same refund can be retried', async () => {
    const s = await shop([{ title: 'Refund fail' }]); const { o } = await paidOrder(s, [{ i: 0, qty: 1 }]);
    const so = (await q('SELECT id FROM seller_orders WHERE order_id=$1', [o.orderId])).rows[0].id; const lineId = (await q('SELECT id FROM order_lines WHERE seller_order_id=$1', [so])).rows[0].id; const body = { lines: [{ lineId, quantity: 1 }], reason: 'provider down' };
    mock.failRefundsOnce = 1; const bad = await refund(s, so, body); expect(bad.statusCode).toBe(502);
    expect((await q('SELECT refunded_cents FROM seller_orders WHERE id=$1', [so])).rows[0].refunded_cents).toBe(0); expect((await q('SELECT refunded_qty FROM order_lines WHERE id=$1', [lineId])).rows[0].refunded_qty).toBe(0);
    expect((await q(`SELECT status FROM refunds WHERE seller_order_id=$1`, [so])).rows[0].status).toBe('failed'); expect(Number((await q(`SELECT count(*) n FROM ledger_entries WHERE order_id=$1 AND memo='refund'`, [o.orderId])).rows[0].n)).toBe(0);
    expect((await refund(s, so, body)).statusCode).toBe(200);
  });
  it('cancelling before shipping refunds everything and returns the stock', async () => {
    const s = await shop([{ title: 'Cancel me', stock: 4 }]); const { o } = await paidOrder(s, [{ i: 0, qty: 2 }]); const so = (await q('SELECT * FROM seller_orders WHERE order_id=$1', [o.orderId])).rows[0];
    const r = await st('POST', `/api/studio/orders/${so.id}/cancel`, s.cookie, { reason: 'out of clay' }); expect(r.statusCode).toBe(200); expect(r.json().order.status).toBe('cancelled');
    expect((await stock(s.items[0].variantId)).on_hand).toBe(4); expect(await ledgerSum(o.orderId)).toBe(0); expect((await balances(o.orderId)).cash).toBe(0);
  });
});

describe('emails and jobs', () => {
  it('order events queue emails in the same transaction; the worker sends them, retries failures, and never sends twice', async () => {
    const s = await shop([{ title: 'Mail item' }]); await paidOrder(s, [{ i: 0, qty: 1 }], 'mailtest@t.test');
    const mails = (await q(`SELECT template, subject, body, status FROM outbox_emails WHERE to_email='mailtest@t.test'`)).rows; expect(mails.map(m => m.template)).toContain('order_confirmation');
    const sent: string[] = []; await processOutbox(async m => { if (m.to === 'mailtest@t.test') sent.push(m.subject); }, 5000); expect(sent.length).toBeGreaterThan(0);
    const again: string[] = []; await processOutbox(async m => { again.push(m.to); }, 5000); expect(again).not.toContain('mailtest@t.test');
    const f = await shop([{ title: 'Mail fail' }]); await paidOrder(f, [{ i: 0, qty: 1 }], 'failmail@t.test'); await processOutbox(async m => { if (m.to === 'failmail@t.test') throw new Error('smtp down'); }, 5000);
    const row = (await q(`SELECT status, attempts, error FROM outbox_emails WHERE to_email='failmail@t.test' AND template='order_confirmation'`)).rows[0]; expect(row.attempts).toBe(1); expect(row.error).toMatch(/smtp/); expect(row.status).toBe('pending');
  });
  it('a seller is told about a new order', async () => {
    const s = await shop([{ title: 'Seller mail' }]); await paidOrder(s, [{ i: 0, qty: 1 }]);
    expect(Number((await q(`SELECT count(*) n FROM outbox_emails WHERE to_email=$1 AND template='seller_new_order'`, [s.email])).rows[0].n)).toBe(1);
  });
});
