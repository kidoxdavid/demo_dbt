import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { releaseExpiredReservations } from '../src/modules/commerce.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const refund = (cookie: string, orderId: string, body: object) => app.inject({ method: 'POST', url: `/api/seller/orders/${orderId}/refunds`, ...ck(cookie), payload: body });
const ledger = async (orderId: string) => (await oq('SELECT account, amount_cents::int a FROM ledger_entries WHERE order_id=$1', [orderId])).rows;
const sumBy = (rows: any[], acct: string) => rows.filter(r => r.account === acct).reduce((n, r) => n + r.a, 0);

describe('refunds', () => {
  it('full refund: marks refunded, nets the ledger to zero, restocks, and records movements', async () => {
    const s = await k.seller('rf1'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 2);
    expect(await k.stock(p.variantId)).toEqual({ on_hand: 3, reserved: 0 });
    const r = await refund(s.cookie, o.orderId, { amountCents: o.total, reason: 'Customer changed mind', restock: true });
    expect(r.statusCode).toBe(201); expect(r.json()).toMatchObject({ status: 'refunded', refundedCents: o.total });
    const led = await ledger(o.orderId);
    for (const a of ['cash_received', 'platform_fee', 'seller_payable']) expect(sumBy(led, a)).toBe(0);
    expect(led.reduce((n, x) => n + x.a, 0)).toBe(0);
    expect(await k.stock(p.variantId)).toEqual({ on_hand: 5, reserved: 0 });
    expect((await oq(`SELECT count(*)::int n FROM inventory_movements WHERE order_id=$1 AND reason='return'`, [o.orderId])).rows[0].n).toBe(1);
    expect((await app.inject({ method: 'GET', url: `/api/public/orders/${o.token}` })).json()).toMatchObject({ status: 'refunded', refunded_cents: o.total });
  });
  it('partial refunds accumulate, return the platform fee pro rata, and the last one completes the order', async () => {
    const s = await k.seller('rf2'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 2); // total 4000, fee 3% of 4000 = 120
    const a = await refund(s.cookie, o.orderId, { amountCents: 1000, reason: 'Damaged item' });
    expect(a.json()).toMatchObject({ refundedCents: 1000, status: 'paid' });
    const led = await ledger(o.orderId);
    expect(sumBy(led, 'cash_received')).toBe(4000 - 1000); expect(sumBy(led, 'platform_fee')).toBe(-120 + 30); expect(sumBy(led, 'seller_payable')).toBe(-3880 + 970);
    expect(led.reduce((n, x) => n + x.a, 0)).toBe(0);
    expect((await refund(s.cookie, o.orderId, { amountCents: 3001, reason: 'Too much' })).statusCode).toBe(422);
    const b = await refund(s.cookie, o.orderId, { amountCents: 3000, reason: 'Remainder' });
    expect(b.json()).toMatchObject({ refundedCents: 4000, status: 'refunded' });
    expect((await refund(s.cookie, o.orderId, { amountCents: 1, reason: 'Again' })).statusCode).toBe(422);
    expect((await ledger(o.orderId)).reduce((n, x) => n + x.a, 0)).toBe(0);
  });
  it('restocking is refused for partial refunds', async () => {
    const s = await k.seller('rf3'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 1);
    expect((await refund(s.cookie, o.orderId, { amountCents: 500, reason: 'Goodwill', restock: true })).statusCode).toBe(422);
    expect(await k.stock(p.variantId)).toEqual({ on_hand: 4, reserved: 0 });
  });
  it('is idempotent on a client key; a reused key on another order is rejected', async () => {
    const s = await k.seller('rf4'); const p = await k.product(s.cookie); const o1 = await k.paidOrder(s, p.variantId, 1); const o2 = await k.paidOrder(s, p.variantId, 1);
    const key = 'idem-key-123456';
    expect((await refund(s.cookie, o1.orderId, { amountCents: 500, reason: 'Goodwill', key })).statusCode).toBe(201);
    const again = await refund(s.cookie, o1.orderId, { amountCents: 500, reason: 'Goodwill', key });
    expect(again.statusCode).toBe(200); expect(again.json().replay).toBe(true);
    expect((await oq('SELECT count(*)::int n FROM refunds WHERE order_id=$1', [o1.orderId])).rows[0].n).toBe(1);
    expect((await refund(s.cookie, o2.orderId, { amountCents: 500, reason: 'Goodwill', key })).statusCode).toBe(409);
  });
  it('two simultaneous refunds that together exceed the total: exactly one wins', async () => {
    const s = await k.seller('rf5'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 2); // 4000
    const rs = await Promise.all([refund(s.cookie, o.orderId, { amountCents: 3000, reason: 'Race one' }), refund(s.cookie, o.orderId, { amountCents: 3000, reason: 'Race two' })]);
    expect(rs.map(r => r.statusCode).sort()).toEqual([201, 422]);
    expect((await oq('SELECT refunded_cents FROM orders WHERE id=$1', [o.orderId])).rows[0].refunded_cents).toBe(3000);
  });
  it('refuses unpaid orders, other sellers, and staff-role members; validates input', async () => {
    const a = await k.seller('rf6'); const b = await k.seller('rf7'); const p = await k.product(a.cookie);
    const unpaid = (await k.checkout(a.slug, p.variantId)).json();
    const unpaidId = (await app.inject({ method: 'GET', url: '/api/seller/orders', ...ck(a.cookie) })).json().find((x: any) => Number(x.number) === unpaid.orderNumber).id;
    expect((await refund(a.cookie, unpaidId, { amountCents: 100, reason: 'Nope nope' })).statusCode).toBe(409);
    const o = await k.paidOrder(a, p.variantId, 1);
    expect((await refund(b.cookie, o.orderId, { amountCents: 100, reason: 'Not mine' })).statusCode).toBe(404);
    expect((await refund(a.cookie, o.orderId, { amountCents: 0, reason: 'zero' })).statusCode).toBe(400);
    expect((await refund(a.cookie, o.orderId, { amountCents: 100, reason: 'x' })).statusCode).toBe(400);
    expect((await refund(a.cookie, o.orderId, { amountCents: 100, reason: 'Fine reason', extra: 1 })).statusCode).toBe(400);
  });
  it('staff-role members can fulfil orders but cannot refund', async () => {
    const s = await k.seller('rf12'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 1);
    await oq(`UPDATE memberships SET role='staff' WHERE tenant_id=$1`, [s.tenantId]);
    expect((await refund(s.cookie, o.orderId, { amountCents: 100, reason: 'Not allowed' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/seller/orders/${o.orderId}/status`, ...ck(s.cookie), payload: { status: 'processing' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/seller/payments/${o.paymentId}/refund-unfulfilled`, ...ck(s.cookie) })).statusCode).toBe(403);
    expect((await oq('SELECT refunded_cents FROM orders WHERE id=$1', [o.orderId])).rows[0].refunded_cents).toBe(0);
  });
  it('dashboard shows refunds, drops fully refunded orders, and reduces profit for partial refunds', async () => {
    const s = await k.seller('rf8'); const p = await k.product(s.cookie, { variants: [{ priceCents: 2000, costCents: 800, stock: 10 }] });
    const o1 = await k.paidOrder(s, p.variantId, 1); const o2 = await k.paidOrder(s, p.variantId, 1);
    await refund(s.cookie, o1.orderId, { amountCents: o1.total, reason: 'Full refund' });
    await refund(s.cookie, o2.orderId, { amountCents: 500, reason: 'Partial refund' });
    const d = (await app.inject({ method: 'GET', url: '/api/seller/dashboard', ...ck(s.cookie) })).json();
    expect(d).toMatchObject({ orders: 1, grossSalesCents: 2000, cogsCents: 800, refundsCents: 500, grossProfitCents: 2000 - 800 - 500 });
  });
  it('refund records are immutable', async () => {
    const s = await k.seller('rf9'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 1);
    await refund(s.cookie, o.orderId, { amountCents: 100, reason: 'Goodwill' });
    await expect(oq('DELETE FROM refunds')).rejects.toThrow(/append-only/);
    await expect(oq('UPDATE refunds SET amount_cents=1')).rejects.toThrow(/append-only/);
    await expect(oq('UPDATE orders SET refunded_cents = total_cents + 1 WHERE id=$1', [o.orderId])).rejects.toThrow();
  });
  it('unfulfilled payments (paid after stock was gone) are listed and refunded once', async () => {
    const s = await k.seller('rf10'); const p = await k.product(s.cookie, { variants: [{ priceCents: 1000, stock: 1 }] });
    const a = (await k.checkout(s.slug, p.variantId)).json();
    await oq(`UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE public_token=$1`, [a.orderToken]);
    await releaseExpiredReservations(); await k.checkout(s.slug, p.variantId); await k.pay(a.paymentId);
    const att = (await app.inject({ method: 'GET', url: '/api/seller/attention', ...ck(s.cookie) })).json();
    expect(att.unfulfilledPayments).toHaveLength(1); expect(att.unfulfilledPayments[0]).toMatchObject({ amount_cents: 1000, orderNumber: String(a.orderNumber) });
    const go = () => app.inject({ method: 'POST', url: `/api/seller/payments/${a.paymentId}/refund-unfulfilled`, ...ck(s.cookie) });
    expect((await go()).statusCode).toBe(200); expect((await go()).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/seller/attention', ...ck(s.cookie) })).json().unfulfilledPayments).toHaveLength(0);
    expect((await oq(`SELECT kind FROM refunds WHERE payment_id=$1`, [a.paymentId])).rows).toEqual([{ kind: 'unfulfilled' }]);
    const other = await k.seller('rf11');
    expect((await app.inject({ method: 'POST', url: `/api/seller/payments/${a.paymentId}/refund-unfulfilled`, ...ck(other.cookie) })).statusCode).toBe(404);
  });
});
