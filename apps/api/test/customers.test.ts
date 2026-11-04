import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const PW = 'correct-horse-battery';
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie?: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookie ? ck(cookie) : {}) });
async function customer(n: string, fullName = 'Ada Lovelace', verified = true) {
  const r = await call('POST', '/api/auth/signup-customer', undefined, { email: `${n}@cust.test`, password: PW, fullName });
  expect(r.statusCode).toBe(201);
  if (verified) await oq(`UPDATE users SET email_verified_at=now() WHERE email=$1`, [`${n}@cust.test`]);
  return { cookie: r.cookies.find(c => c.name === 'eazy_sid')!.value, email: `${n}@cust.test` };
}
async function staff(n: string, role: string) {
  const s = await k.seller(n); const id = (await oq('SELECT id FROM users WHERE email=$1', [`${n}@k.test`])).rows[0].id;
  await oq('INSERT INTO platform_staff(user_id,role_key) VALUES ($1,$2)', [id, role]); return s.cookie;
}
const buy = (cookie: string | undefined, slug: string, variantId: string, email: string, qty = 1) => app.inject({ method: 'POST', url: `/api/public/stores/${slug}/checkout`,
  payload: { items: [{ variantId, quantity: qty }], email, name: 'Ada', fulfilment: 'pickup' }, ...(cookie ? ck(cookie) : {}) });
const rev = (slug: string, pid: string) => `/api/public/stores/${slug}/products/${pid}/reviews`;

describe('customer accounts', () => {
  it('sign up as a customer: a session, no business, seller pages refuse, duplicate email refused', async () => {
    const c = await customer('ca1');
    expect((await call('GET', '/api/me', c.cookie)).json()).toMatchObject({ email: c.email });
    expect((await call('GET', '/api/seller/dashboard', c.cookie)).json().error).toBe('no_business');
    expect((await call('POST', '/api/auth/signup-customer', undefined, { email: c.email, password: PW, fullName: 'X' })).statusCode).toBe(409);
    expect((await call('POST', '/api/auth/signup-customer', undefined, { email: 'short@cust.test', password: 'short', fullName: 'X' })).statusCode).toBe(400);
    expect((await oq(`SELECT count(*)::int n FROM email_outbox WHERE to_email=$1 AND template='verify_email'`, [c.email])).rows[0].n).toBe(1);
  });
  it('orders placed while signed in (or with the verified email) show in the account; strangers see nothing', async () => {
    const s = await k.seller('ca2'); const p = await k.product(s.cookie);
    const a = await customer('ca2c'); const b = await customer('ca2d');
    const linked = (await buy(a.cookie, s.slug, p.variantId, 'other@x.test')).json();                // signed in, different email on the order
    const guest = (await buy(undefined, s.slug, p.variantId, a.email)).json();                      // guest order with the account's verified email
    const list = (await call('GET', '/api/account/orders', a.cookie)).json();
    expect(list.map((o: any) => o.number).sort()).toEqual([linked.orderNumber, guest.orderNumber].sort());
    expect(list[0]).toMatchObject({ storeSlug: s.slug }); expect(JSON.stringify(list)).not.toMatch(/cost|tenant_id/);
    expect((await call('GET', '/api/account/orders', b.cookie)).json()).toEqual([]);
    expect((await call('GET', '/api/account/orders')).statusCode).toBe(401);
    const unverified = await customer('ca2e', 'Eve', false); await buy(undefined, s.slug, p.variantId, unverified.email);
    expect((await call('GET', '/api/account/orders', unverified.cookie)).json()).toEqual([]);       // an unverified email proves nothing
  });
});

describe('wishlist', () => {
  it('saves visible products, hides ones that disappear, is private per customer', async () => {
    const s = await k.seller('wl1'); const p = await k.product(s.cookie); const d = await k.product(s.cookie, { name: 'Hidden', status: 'draft' });
    const a = await customer('wl1a'); const b = await customer('wl1b');
    expect((await call('PUT', `/api/account/wishlist/${p.id}`, a.cookie)).statusCode).toBe(200);
    expect((await call('PUT', `/api/account/wishlist/${p.id}`, a.cookie)).statusCode).toBe(200);          // idempotent
    expect((await call('PUT', `/api/account/wishlist/${d.id}`, a.cookie)).statusCode).toBe(404);          // drafts are not visible
    const w = (await call('GET', '/api/account/wishlist', a.cookie)).json(); expect(w).toHaveLength(1); expect(w[0]).toMatchObject({ id: p.id, storeSlug: s.slug, available: true });
    expect(JSON.stringify(w)).not.toMatch(/cost/);
    expect((await call('GET', '/api/account/wishlist', b.cookie)).json()).toEqual([]);
    expect((await call('GET', '/api/account/wishlist/ids', a.cookie)).json()).toEqual([p.id]);
    await oq(`UPDATE products SET status='archived' WHERE id=$1`, [p.id]);
    expect((await call('GET', '/api/account/wishlist', a.cookie)).json()).toEqual([]);                   // archived: gone from view
    await oq(`UPDATE products SET status='active' WHERE id=$1`, [p.id]);
    expect((await call('DELETE', `/api/account/wishlist/${p.id}`, a.cookie)).statusCode).toBe(200);
    expect((await call('GET', '/api/account/wishlist', a.cookie)).json()).toEqual([]);
    expect((await call('PUT', `/api/account/wishlist/${p.id}`)).statusCode).toBe(401);
  });
});

describe('reviews', () => {
  it('need a real purchase; one per customer; editable; first name only; aggregates everywhere', async () => {
    const s = await k.seller('rv1'); const p = await k.product(s.cookie);
    const a = await customer('rv1a', 'Ada Lovelace'); const b = await customer('rv1b', 'Bo Peep');
    expect((await call('PUT', rev(s.slug, p.id), undefined, { rating: 5 })).statusCode).toBe(401);
    expect((await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 5 })).json().error).toBe('purchase_required');       // never bought
    const o = (await buy(a.cookie, s.slug, p.variantId, a.email)).json();
    expect((await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 5 })).json().error).toBe('purchase_required');       // ordered but not paid
    await k.pay(o.paymentId);
    expect((await call('GET', rev(s.slug, p.id), a.cookie)).json().canReview).toBe(true);
    expect((await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 6 })).statusCode).toBe(400);
    expect((await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 4, title: 'Nice', body: 'Sturdy.' })).statusCode).toBe(201);
    expect((await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 5, title: 'Great', body: 'Sturdy and tidy.' })).statusCode).toBe(200);   // edit, not a second review
    const bo = (await buy(b.cookie, s.slug, p.variantId, b.email)).json(); await k.pay(bo.paymentId);
    await call('PUT', rev(s.slug, p.id), b.cookie, { rating: 2 });
    const pub = (await call('GET', rev(s.slug, p.id))).json();
    expect(pub.rating).toMatchObject({ avg: 3.5, count: 2, distribution: { 5: 1, 2: 1 } });
    expect(pub.reviews.map((r: any) => r.name).sort()).toEqual(['Ada', 'Bo']); expect(JSON.stringify(pub)).not.toMatch(/Lovelace|Peep|@/);
    expect(pub.canReview).toBe(false); expect(pub.mine).toBeNull();
    expect((await call('GET', `/api/public/stores/${s.slug}/products/${p.id}`)).json().rating).toMatchObject({ avg: 3.5, count: 2 });
    expect((await call('GET', `/api/public/stores/${s.slug}/products`)).json()[0].rating).toMatchObject({ count: 2 });
    expect((await call('GET', `/api/public/marketplace?q=Stand`)).json().products.find((x: any) => x.id === p.id).rating).toMatchObject({ avg: 3.5, count: 2 });
    expect((await call('DELETE', rev(s.slug, p.id), b.cookie)).statusCode).toBe(200);
    expect((await call('GET', rev(s.slug, p.id))).json().rating).toMatchObject({ avg: 5, count: 1 });
  });
  it('a refunded or cancelled purchase does not qualify', async () => {
    const s = await k.seller('rv2'); const p = await k.product(s.cookie); const a = await customer('rv2a');
    const o = (await buy(a.cookie, s.slug, p.variantId, a.email)).json(); await k.pay(o.paymentId);
    const order = (await call('GET', '/api/seller/orders', s.cookie)).json()[0];
    expect((await call('POST', `/api/seller/orders/${order.id}/refunds`, s.cookie, { amountCents: order.total_cents, reason: 'Changed mind' })).statusCode).toBe(201);
    expect((await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 5 })).json().error).toBe('purchase_required');
  });
  it('sellers see their own reviews, reply once, and never reach other stores; staff can remove with a reason', async () => {
    const s = await k.seller('rv3'); const other = await k.seller('rv3x'); const p = await k.product(s.cookie); const a = await customer('rv3a');
    const o = (await buy(a.cookie, s.slug, p.variantId, a.email)).json(); await k.pay(o.paymentId);
    await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 1, title: 'Bad', body: 'Rude words' });
    const list = (await call('GET', '/api/seller/reviews', s.cookie)).json(); expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ productName: 'Stand', rating: 1 });
    expect((await call('GET', '/api/seller/reviews', other.cookie)).json()).toEqual([]);
    expect((await call('POST', `/api/seller/reviews/${list[0].id}/reply`, other.cookie, { reply: 'Hi' })).statusCode).toBe(404);
    expect((await call('POST', `/api/seller/reviews/${list[0].id}/reply`, s.cookie, { reply: 'Sorry about that.' })).statusCode).toBe(200);
    expect((await call('POST', `/api/seller/reviews/${list[0].id}/reply`, s.cookie, { reply: 'Again' })).json().error).toBe('already_replied');
    expect((await call('GET', rev(s.slug, p.id))).json().reviews[0].sellerReply).toBe('Sorry about that.');
    const adm = await staff('rv3adm', 'moderator'); const sup = await staff('rv3sup', 'support');
    expect((await call('POST', `/api/admin/reviews/${list[0].id}/remove`, sup, { reason: 'Abusive language' })).statusCode).toBe(403);
    expect((await call('POST', `/api/admin/reviews/${list[0].id}/remove`, adm, { reason: 'x' })).statusCode).toBe(400);
    expect((await call('POST', `/api/admin/reviews/${list[0].id}/remove`, adm, { reason: 'Abusive language' })).statusCode).toBe(200);
    expect((await call('POST', `/api/admin/reviews/${list[0].id}/remove`, adm, { reason: 'Abusive language' })).statusCode).toBe(409);
    const pub = (await call('GET', rev(s.slug, p.id))).json(); expect(pub.reviews).toEqual([]); expect(pub.rating.count).toBe(0);
    expect((await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 5 })).json().error).toBe('review_removed');     // cannot resurrect it by editing
    expect((await oq(`SELECT count(*)::int n FROM audit_logs WHERE action='review.remove'`)).rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('closing a customer account', () => {
  it('needs the password, refuses while orders are open, then anonymises reviews and wishlist and signs out', async () => {
    const s = await k.seller('cc1'); const p = await k.product(s.cookie); const a = await customer('cc1a', 'Cleo Patra');
    const o = (await buy(a.cookie, s.slug, p.variantId, a.email)).json(); await k.pay(o.paymentId);
    await call('PUT', rev(s.slug, p.id), a.cookie, { rating: 5, body: 'Lovely' }); await call('PUT', `/api/account/wishlist/${p.id}`, a.cookie);
    expect((await call('POST', '/api/account/close', a.cookie, { password: 'wrong-wrong-wrong', confirm: 'CLOSE' })).statusCode).toBe(401);
    expect((await call('POST', '/api/account/close', a.cookie, { password: PW, confirm: 'CLOSE' })).json().error).toBe('open_orders:1');
    const order = (await call('GET', '/api/seller/orders', s.cookie)).json()[0];
    for (const st of ['processing', 'ready', 'completed']) await call('POST', `/api/seller/orders/${order.id}/status`, s.cookie, { status: st });
    expect((await call('POST', '/api/account/close', a.cookie, { password: PW, confirm: 'CLOSE' })).statusCode).toBe(200);
    expect((await call('GET', '/api/me', a.cookie)).statusCode).toBe(401);
    const pub = (await call('GET', rev(s.slug, p.id))).json(); expect(pub.reviews[0]).toMatchObject({ name: 'Former customer', body: 'Lovely' });
    expect((await oq('SELECT count(*)::int n FROM wishlist_items')).rows[0].n).toBeGreaterThanOrEqual(0);
    expect((await oq(`SELECT count(*)::int n FROM wishlist_items w JOIN users u ON u.id=w.user_id WHERE u.email LIKE 'closed-%'`)).rows[0].n).toBe(0);
    expect((await call('POST', '/api/auth/login', undefined, { email: a.email, password: PW })).statusCode).toBe(401);
  });
  it('sellers cannot close a business through the customer endpoint', async () => {
    const s = await k.seller('cc2');
    expect((await call('POST', '/api/account/close', s.cookie, { password: 'correct-horse-battery', confirm: 'CLOSE' })).json().error).toBe('seller_account');
  });
});
