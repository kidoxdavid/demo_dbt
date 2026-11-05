import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { processOutbox } from '../src/lib/outbox.js';
import { ck, jpeg, login, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
const st = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', cookie) });
const shopCall = (cookie: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookie ? ck('shop', cookie) : {}) });

/** A seller with one product, and a buyer order for it (guest), optionally delivered. */
async function sale(opts: { deliver?: boolean; email?: string; name?: string; buyerCookie?: string } = {}) {
  const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
  const p = (await st(s.cookie, 'POST', '/api/studio/products', { title: 'Review mug', categorySlug: 'pottery-ceramics', priceCents: 3000, stock: 20, attributes: {}, mediaIds: [m.id] })).json(); await st(s.cookie, 'POST', `/api/studio/products/${p.id}/publish`, { acknowledged: true });
  const v = (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id; const jar: Record<string, string> = opts.buyerCookie ? { es_shop: opts.buyerCookie } : {};
  const call = async (method: any, url: string, payload?: object) => { const r = await app.inject({ method, url, cookies: jar, ...(payload ? { payload } : {}) }); for (const c of r.cookies) jar[c.name] = c.value; return r; };
  await call('POST', '/api/cart/items', { variantId: v, quantity: 1 }); const o = (await call('POST', '/api/checkout', { ...(opts.buyerCookie ? {} : { email: opts.email ?? `rev${Date.now()}@t.test` }), address: { name: opts.name ?? 'Bea Buyer', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } })).json();
  await app.inject({ method: 'POST', url: `/api/dev/payments/${o.payment.ref}/simulate`, payload: { outcome: 'succeeded' } }); const so = (await q('SELECT id FROM seller_orders WHERE order_id=$1', [o.orderId])).rows[0].id as string;
  if (opts.deliver) { await st(s.cookie, 'POST', `/api/studio/orders/${so}/ship`, { carrier: 'canada_post', trackingNumber: 'AB123456789CA' }); await st(s.cookie, 'POST', `/api/studio/orders/${so}/deliver`, {}); }
  return { ...s, productId: p.id as string, token: o.token as string, orderId: o.orderId as string, sellerOrderId: so };
}

describe('reviews', () => {
  it('only a delivered order can be reviewed, once; the name is shortened; the shop rating moves; the seller can reply', async () => {
    const early = await sale(); const r1 = await shopCall(null, 'POST', `/api/orders/by-token/${early.token}/reviews`, { productId: early.productId, rating: 5, body: 'Lovely' }); expect(r1.statusCode).toBe(409); expect(r1.json().error).toBe('not_delivered_yet');
    const s = await sale({ deliver: true, name: 'Bea Buyer' }); const url = `/api/orders/by-token/${s.token}/reviews`;
    expect((await shopCall(null, 'POST', url, { productId: s.productId, rating: 6, body: 'x' })).statusCode).toBe(400); expect((await shopCall(null, 'POST', url, { productId: s.productId, rating: 4, body: '' })).statusCode).toBe(400);
    expect((await shopCall(null, 'POST', url, { productId: '00000000-0000-4000-8000-000000000000', rating: 5, body: 'x' })).json().error).toBe('not_in_order');
    expect((await shopCall(null, 'POST', `/api/orders/by-token/${'x'.repeat(30)}/reviews`, { productId: s.productId, rating: 5, body: 'x' })).statusCode).toBe(404);
    expect((await shopCall(null, 'POST', url, { productId: s.productId, rating: 4, title: 'Solid mug', body: 'Holds heat well, glaze is lovely.' })).statusCode).toBe(201); expect((await shopCall(null, 'POST', url, { productId: s.productId, rating: 5, body: 'again' })).json().error).toBe('already_reviewed');
    const pub = (await shopCall(null, 'GET', `/api/products/${s.productId}/reviews`)).json(); expect(pub).toMatchObject({ count: 1, avg: 4, distribution: { 4: 1, 5: 0 } }); expect(pub.items[0]).toMatchObject({ authorName: 'Bea B.', rating: 4, title: 'Solid mug', reply: null }); expect(JSON.stringify(pub)).not.toMatch(/@/);
    expect((await shopCall(null, 'GET', `/api/shops/${s.shop.slug}`)).json().rating).toEqual({ avg: 4, count: 1 });
    const mine = (await st(s.cookie, 'GET', '/api/studio/reviews')).json(); expect(mine.total).toBe(1); const rid = mine.items[0].id;
    expect((await st(s.cookie, 'POST', `/api/studio/reviews/${rid}/reply`, { body: 'Thank you, Bea!' })).statusCode).toBe(200); expect((await shopCall(null, 'GET', `/api/products/${s.productId}/reviews`)).json().items[0].reply.body).toBe('Thank you, Bea!');
    const other = await studioSeller(app); expect((await st(other.cookie, 'POST', `/api/studio/reviews/${rid}/reply`, { body: 'not mine' })).statusCode).toBe(404); expect((await st(other.cookie, 'GET', '/api/studio/reviews')).json().total).toBe(0);
    const shopList = (await shopCall(null, 'GET', `/api/shops/${s.shop.slug}/reviews`)).json(); expect(shopList.items[0].productTitle).toBe('Review mug');
    const order = (await shopCall(null, 'GET', `/api/orders/by-token/${s.token}`)).json(); expect(order.sellers[0].lines[0]).toMatchObject({ productId: s.productId, review: { rating: 4 } });
  });
  it('a seller can report a review; staff keep or hide it with a reason; hiding takes it out of the rating', async () => {
    const s = await sale({ deliver: true }); await shopCall(null, 'POST', `/api/orders/by-token/${s.token}/reviews`, { productId: s.productId, rating: 1, body: 'Terrible, I never even got it' });
    const rid = (await st(s.cookie, 'GET', '/api/studio/reviews')).json().items[0].id; expect((await shopCall(null, 'GET', `/api/shops/${s.shop.slug}`)).json().rating).toEqual({ avg: 1, count: 1 });
    expect((await st(s.cookie, 'POST', `/api/studio/reviews/${rid}/report`, { reason: 'x' })).statusCode).toBe(400); expect((await st(s.cookie, 'POST', `/api/studio/reviews/${rid}/report`, { reason: 'Tracking shows it was delivered and signed for' })).statusCode).toBe(200); expect((await st(s.cookie, 'POST', `/api/studio/reviews/${rid}/report`, { reason: 'reporting again' })).statusCode).toBe(409);
    const staff = await login(app, 'admin', { role: 'catalogue' }); const adm = (m: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method: m, url, ...(payload ? { payload } : {}), ...ck('admin', staff.cookie) });
    expect((await adm('GET', '/api/admin/reviews/reported')).json().map((x: any) => x.id)).toContain(rid); expect((await adm('POST', `/api/admin/reviews/${rid}`, { decision: 'hide' })).statusCode).toBe(400);
    expect((await adm('POST', `/api/admin/reviews/${rid}`, { decision: 'hide', reason: 'Order was delivered and signed for' })).statusCode).toBe(200); expect((await adm('POST', `/api/admin/reviews/${rid}`, { decision: 'keep', reason: 'second try' })).json().error).toBe('not_reported');
    expect((await shopCall(null, 'GET', `/api/products/${s.productId}/reviews`)).json().count).toBe(0); expect((await shopCall(null, 'GET', `/api/shops/${s.shop.slug}`)).json().rating).toBeNull();
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action IN ('review.report','review.hide')`, [rid])).rows[0].n)).toBe(2);
  });
  it('delivering asks the buyer for a review once; a seeded demo rating blends with real reviews instead of being replaced', async () => {
    const email = `ask${Date.now()}@t.test`; await sale({ deliver: true, email }); const mails = (await q(`SELECT template FROM outbox_emails WHERE to_email=$1`, [email])).rows.map(r => r.template); expect(mails.filter((t: string) => t === 'review_request')).toHaveLength(1);
    const s = await sale({ deliver: true }); await q('UPDATE shops SET rating_base_avg=5, rating_base_count=9, rating_avg=5, rating_count=9 WHERE id=$1', [s.shop.id]);
    await shopCall(null, 'POST', `/api/orders/by-token/${s.token}/reviews`, { productId: s.productId, rating: 1, body: 'Cracked in the post' }); expect((await shopCall(null, 'GET', `/api/shops/${s.shop.slug}`)).json().rating).toEqual({ avg: 4.6, count: 10 });
  });
  it('turning the reviews feature off hides the endpoints', async () => {
    const s = await sale({ deliver: true }); await q(`INSERT INTO feature_flags(key,enabled) VALUES ('reviews',false) ON CONFLICT (key) DO UPDATE SET enabled=false`);
    try { expect((await shopCall(null, 'GET', `/api/products/${s.productId}/reviews`)).statusCode).toBe(404); expect((await shopCall(null, 'POST', `/api/orders/by-token/${s.token}/reviews`, { productId: s.productId, rating: 5, body: 'x' })).statusCode).toBe(404); }
    finally { await q(`DELETE FROM feature_flags WHERE key='reviews'`); }
  });
});

describe('messages', () => {
  it('a signed-in buyer asks a maker about a piece; the maker answers; each side sees only their own conversations; email goes out once per burst', async () => {
    const s = await sale(); const buyer = await login(app, 'shop'); const other = await login(app, 'shop'); const sellerMail = s.email;
    expect((await shopCall(null, 'POST', `/api/shops/${s.shop.slug}/messages`, { body: 'hi' })).statusCode).toBe(401); expect((await shopCall(buyer.cookie, 'POST', `/api/shops/${s.shop.slug}/messages`, { body: '' })).statusCode).toBe(400);
    const t1 = await shopCall(buyer.cookie, 'POST', `/api/shops/${s.shop.slug}/messages`, { body: 'Is this dishwasher safe?' }); expect(t1.statusCode).toBe(201); const tid = t1.json().threadId;
    await shopCall(buyer.cookie, 'POST', `/api/shops/${s.shop.slug}/messages`, { body: 'And can it go in the microwave?' }); expect((await shopCall(buyer.cookie, 'GET', '/api/me/threads')).json()).toHaveLength(1);
    await shopCall(buyer.cookie, 'POST', `/api/me/threads/${tid}/messages`, { body: 'Third message' }); expect(Number((await q(`SELECT count(*) n FROM outbox_emails WHERE to_email=$1 AND template='new_message' AND data->>'threadId'=$2`, [sellerMail, tid])).rows[0].n)).toBe(1);
    const list = (await st(s.cookie, 'GET', '/api/studio/threads')).json(); expect(list.unread).toBe(1); expect(list.items[0]).toMatchObject({ id: tid, unread: true, lastSender: 'buyer' }); expect(JSON.stringify(list)).not.toContain(buyer.email);
    const detail = (await st(s.cookie, 'GET', `/api/studio/threads/${tid}`)).json(); expect(detail.messages.map((m: any) => m.body)).toEqual(['Is this dishwasher safe?', 'And can it go in the microwave?', 'Third message']); expect((await st(s.cookie, 'GET', '/api/studio/threads')).json().unread).toBe(0);
    expect((await st(s.cookie, 'POST', `/api/studio/threads/${tid}/messages`, { body: 'Yes to both!' })).statusCode).toBe(201);
    const mine = (await shopCall(buyer.cookie, 'GET', '/api/me/threads')).json(); expect(mine[0]).toMatchObject({ unread: true, lastSender: 'seller', lastMessage: 'Yes to both!' }); const view = (await shopCall(buyer.cookie, 'GET', `/api/me/threads/${tid}`)).json(); expect(view.messages).toHaveLength(4); expect((await shopCall(buyer.cookie, 'GET', '/api/me/threads')).json()[0].unread).toBe(false);
    expect((await shopCall(other.cookie, 'GET', `/api/me/threads/${tid}`)).statusCode).toBe(404); expect((await shopCall(other.cookie, 'POST', `/api/me/threads/${tid}/messages`, { body: 'let me in' })).statusCode).toBe(404);
    const otherSeller = await studioSeller(app); expect((await st(otherSeller.cookie, 'GET', `/api/studio/threads/${tid}`)).statusCode).toBe(404); expect((await st(otherSeller.cookie, 'POST', `/api/studio/threads/${tid}/messages`, { body: 'x' })).statusCode).toBe(404);
    const sent: string[] = []; await processOutbox(async m => { if (m.to === buyer.email) sent.push(m.subject); }, 5000); expect(sent[0]).toContain('New message');
    expect((await st(s.cookie, 'GET', '/api/studio/dashboard')).json().tasks.messagesToAnswer).toBe(0);
  });
  it('order chat works through the order link for guests; a seller cannot message their own shop; the flag turns it off; bursts are limited', async () => {
    const s = await sale({ deliver: true }); const url = `/api/orders/by-token/${s.token}/messages/${s.sellerOrderId}`;
    expect((await shopCall(null, 'GET', url)).json()).toMatchObject({ threadId: null, messages: [] }); expect((await shopCall(null, 'POST', url, { body: 'Where is my parcel?' })).statusCode).toBe(201); expect((await shopCall(null, 'POST', url, { body: 'Also, can you gift wrap?' })).statusCode).toBe(201);
    const list = (await st(s.cookie, 'GET', '/api/studio/threads')).json(); expect(list.items).toHaveLength(1); expect(list.items[0]).toMatchObject({ about: expect.stringMatching(/^Order #/) }); await st(s.cookie, 'POST', `/api/studio/threads/${list.items[0].id}/messages`, { body: 'It was delivered Tuesday' });
    expect((await shopCall(null, 'GET', url)).json().messages.map((m: any) => m.sender)).toEqual(['buyer', 'buyer', 'seller']); expect((await shopCall(null, 'GET', `/api/orders/by-token/${s.token}/messages/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
    const support = await login(app, 'support', { role: 'support' }); const so = (await app.inject({ method: 'GET', url: `/api/support/orders/${s.orderId}`, ...ck('support', support.cookie) })).json(); expect(so.threads[0].messages).toHaveLength(3);
    const owner = await login(app, 'shop', { role: 'seller_owner', sellerId: s.sellerId }); expect((await shopCall(owner.cookie, 'POST', `/api/shops/${s.shop.slug}/messages`, { body: 'talking to myself' })).json().error).toBe('own_shop');
    const tid = list.items[0].id; await q(`INSERT INTO messages(thread_id,sender,body) SELECT $1,'buyer','spam' FROM generate_series(1,30)`, [tid]); expect((await shopCall(null, 'POST', url, { body: 'one more' })).statusCode).toBe(429);
    await q(`INSERT INTO feature_flags(key,enabled) VALUES ('order_chat',false) ON CONFLICT (key) DO UPDATE SET enabled=false`); try { expect((await shopCall(null, 'GET', url)).statusCode).toBe(404); expect((await st(s.cookie, 'GET', '/api/studio/threads')).statusCode).toBe(404); } finally { await q(`DELETE FROM feature_flags WHERE key='order_chat'`); }
  });
});

describe('following', () => {
  it('lists followed shops with their newest pieces', async () => {
    const s = await sale(); const u = await login(app, 'shop'); expect((await shopCall(null, 'GET', '/api/me/following')).statusCode).toBe(401);
    await shopCall(u.cookie, 'PUT', `/api/shops/${s.shop.slug}/follow`); const f = (await shopCall(u.cookie, 'GET', '/api/me/following')).json(); expect(f).toHaveLength(1); expect(f[0]).toMatchObject({ slug: s.shop.slug, name: s.shop.name }); expect(f[0].items[0].title).toBe('Review mug');
  });
});
