import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { ck, jpeg, login, makeUser, studioSeller, upload, PW } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 100000 }); });
afterAll(async () => { await app.close(); await pool.end(); });
const shop = (cookie: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookie ? ck('shop', cookie) : {}) });
const st = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', cookie) });

/** A buyer with an account who has bought from a new shop; the order is delivered (or left open) and reviewed, and they have messaged, saved and followed. */
async function customer(opts: { deliver: boolean }) {
  const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
  const p = (await st(s.cookie, 'POST', '/api/studio/products', { title: 'Privacy mug', categorySlug: 'pottery-ceramics', priceCents: 3000, stock: 9, attributes: {}, mediaIds: [m.id] })).json(); await st(s.cookie, 'POST', `/api/studio/products/${p.id}/publish`, { acknowledged: true });
  const v = (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id; const u = await login(app, 'shop');
  await shop(u.cookie, 'POST', '/api/cart/items', { variantId: v, quantity: 1 }); const co = (await shop(u.cookie, 'POST', '/api/checkout', { address: { name: 'Pat Private', line1: '77 Secret Lane', line2: 'Unit 5', city: 'Calgary', region: 'AB', postal: 'T2N 1N4', phone: '403-555-0100' } })).json();
  await app.inject({ method: 'POST', url: `/api/dev/payments/${co.payment.ref}/simulate`, payload: { outcome: 'succeeded' } }); const so = (await q('SELECT id FROM seller_orders WHERE order_id=$1', [co.orderId])).rows[0].id as string;
  if (opts.deliver) { await st(s.cookie, 'POST', `/api/studio/orders/${so}/ship`, { carrier: 'canada_post', trackingNumber: 'AB123456789CA' }); await st(s.cookie, 'POST', `/api/studio/orders/${so}/deliver`, {}); await shop(null, 'POST', `/api/orders/by-token/${co.token}/reviews`, { productId: p.id, rating: 5, body: 'Lovely mug' }); await shop(null, 'POST', `/api/orders/by-token/${co.token}/messages/${so}`, { body: 'Where is my parcel?' }); }
  await shop(u.cookie, 'PUT', `/api/me/saved/${p.id}`); await shop(u.cookie, 'PUT', `/api/shops/${s.shop.slug}/follow`); await shop(u.cookie, 'POST', `/api/shops/${s.shop.slug}/messages`, { productId: p.id, body: 'Is it dishwasher safe?' });
  await shop(u.cookie, 'PUT', '/api/me/notification-prefs', { category: 'messages', email: false });
  return { ...u, seller: s, productId: p.id as string, orderId: co.orderId as string, token: co.token as string, sellerOrderId: so };
}

describe('data export', () => {
  it('gives a signed-in person all of their own data as a file, and nobody else\'s', async () => {
    const a = await customer({ deliver: true }); const b = await customer({ deliver: true }); expect((await shop(null, 'GET', '/api/me/export')).statusCode).toBe(401);
    const r = await shop(a.cookie, 'GET', '/api/me/export'); expect(r.statusCode).toBe(200); expect(r.headers['content-disposition']).toContain('attachment'); const d = r.json();
    expect(d.profile).toMatchObject({ email: a.email }); expect(d.orders).toHaveLength(1); expect(d.orders[0]).toMatchObject({ buyerName: 'Pat Private', shipTo: { line1: '77 Secret Lane' } }); expect(d.orders[0].lines[0].title).toBe('Privacy mug');
    expect(d.reviews[0]).toMatchObject({ body: 'Lovely mug', product: 'Privacy mug' }); expect(d.conversations.length).toBeGreaterThanOrEqual(1); expect(d.savedPieces).toHaveLength(1); expect(d.followedShops).toHaveLength(1); expect(d.notificationSettings.find((c: any) => c.key === 'messages').email).toBe(false);
    const text = r.body; expect(text).not.toContain(b.email); expect(text).not.toContain(b.token); expect(text).not.toMatch(/password|token_hash|p256dh/i);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='account.export'`, [a.id])).rows[0].n)).toBe(1);
  });
});

describe('account deletion', () => {
  it('needs the password, and is refused for staff and sellers and while an order is still on its way', async () => {
    const open = await customer({ deliver: false }); expect((await shop(open.cookie, 'DELETE', '/api/me', { password: 'wrong-password' })).json().error).toBe('wrong_password'); expect((await shop(null, 'DELETE', '/api/me', { password: PW })).statusCode).toBe(401);
    expect((await shop(open.cookie, 'DELETE', '/api/me', { password: PW })).json().error).toBe('open_orders'); expect((await q('SELECT status FROM users WHERE id=$1', [open.id])).rows[0].status).toBe('active');
    const staff = await makeUser(app, { role: 'support' }); const sl = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': 'shop' }, payload: { email: staff.email, password: PW } }); const cookie = sl.cookies.find(c => c.name === 'es_shop')!.value; expect((await shop(cookie, 'DELETE', '/api/me', { password: PW })).json().error).toBe('has_roles');
  });
  it('removes the person but keeps the books: no name, email or address left on sales; reviews and order chats stay without them; everything personal is gone', async () => {
    const a = await customer({ deliver: true }); const keepTotal = (await q('SELECT total_cents, tax_cents FROM orders WHERE id=$1', [a.orderId])).rows[0]; const ledgerBefore = Number((await q('SELECT coalesce(sum(amount_cents),0) s FROM ledger_entries')).rows[0].s);
    const del = await shop(a.cookie, 'DELETE', '/api/me', { password: PW }); expect(del.statusCode).toBe(200); expect(del.json()).toEqual({ deleted: true });
    expect((await shop(a.cookie, 'GET', '/api/me')).statusCode).toBe(401); expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': 'shop' }, payload: { email: a.email, password: PW } })).statusCode).toBe(401);
    const u = (await q('SELECT email, full_name, status, phone FROM users WHERE id=$1', [a.id])).rows[0]; expect(u).toMatchObject({ full_name: 'Deleted user', status: 'disabled', phone: null }); expect(u.email).toBe(`deleted-${a.id}@deleted.invalid`);
    const o = (await q('SELECT email, buyer_name, ship_to, total_cents, tax_cents, user_id FROM orders WHERE id=$1', [a.orderId])).rows[0]; expect(o).toMatchObject({ buyer_name: 'Deleted customer', user_id: null, total_cents: keepTotal.total_cents, tax_cents: keepTotal.tax_cents }); expect(o.ship_to).toEqual({ region: 'AB', country: 'CA' }); expect(JSON.stringify(o)).not.toMatch(/Secret Lane|Pat Private|403-555/);
    expect(Number((await q('SELECT coalesce(sum(amount_cents),0) s FROM ledger_entries')).rows[0].s)).toBe(ledgerBefore);
    const rv = (await q('SELECT author_name, user_id, status FROM reviews WHERE seller_order_id=$1', [a.sellerOrderId])).rows[0]; expect(rv).toMatchObject({ author_name: 'Former customer', user_id: null, status: 'published' });
    expect((await q('SELECT buyer_name, guest_email FROM threads WHERE seller_order_id=$1', [a.sellerOrderId])).rows[0]).toMatchObject({ buyer_name: 'Deleted customer', guest_email: `deleted-${a.id}@deleted.invalid` }); expect(Number((await q('SELECT count(*) n FROM threads WHERE shop_id=$1 AND seller_order_id IS NULL', [a.seller.shop.id])).rows[0].n)).toBe(0);
    for (const t of ['saved_products', 'shop_follows', 'push_subscriptions', 'notifications', 'sessions', 'carts']) expect(Number((await q(`SELECT count(*) n FROM ${t} WHERE user_id=$1`, [a.id])).rows[0].n)).toBe(0);
    expect(Number((await q('SELECT count(*) n FROM notification_prefs WHERE email=$1', [a.email])).rows[0].n)).toBe(0); expect(Number((await q('SELECT count(*) n FROM outbox_emails WHERE to_email=$1', [a.email])).rows[0].n)).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: a.email, password: 'a-brand-new-passphrase-2026', fullName: 'Pat Again' } })).statusCode).toBe(201);          // the address is free again
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='account.delete'`, [a.id])).rows[0].n)).toBe(1);
    expect((await shop(null, 'GET', `/api/orders/by-token/${a.token}`)).statusCode).toBe(200);                                          // the order record still resolves, with no personal details
    expect(JSON.stringify((await shop(null, 'GET', `/api/orders/by-token/${a.token}`)).json())).not.toMatch(/Secret Lane|Pat Private/);
  });
});
