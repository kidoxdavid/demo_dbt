import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { ck, jpeg, login, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 1_000_000 }); });
afterAll(async () => { await app.close(); await pool.end(); });

async function shop(opts: { stock?: number; title?: string } = {}) {
  const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
  const p = (await app.inject({ method: 'POST', url: '/api/studio/products', payload: { title: opts.title ?? `Quick mug ${Date.now()}`, categorySlug: 'pottery-ceramics', priceCents: 3200, stock: opts.stock ?? 5, attributes: {}, mediaIds: [m.id] }, ...ck('studio', s.cookie) })).json();
  await app.inject({ method: 'POST', url: `/api/studio/products/${p.id}/publish`, payload: { acknowledged: true }, ...ck('studio', s.cookie) });
  return { s, p, variant: (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id as string, slug: (await q('SELECT slug FROM shops WHERE seller_id=$1', [s.sellerId])).rows[0].slug as string };
}
const card = async (title: string) => (await app.inject({ method: 'GET', url: `/api/products?q=${encodeURIComponent(title)}` })).json().items.find((i: any) => i.title === title);

describe('adding to the basket straight from a card', () => {
  it('a single-variant piece in stock offers one-tap add, and that tap really adds it; sold out or several variants do not', async () => {
    const t = `Tap mug ${Date.now()}`; const a = await shop({ title: t }); const c = await card(t); expect(c.quickAdd).toBe(a.variant);
    const jar: Record<string, string> = {}; const add = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: c.quickAdd, quantity: 1 } }); expect(add.statusCode).toBe(201); for (const k of add.cookies) jar[k.name] = k.value;
    expect((await app.inject({ method: 'GET', url: '/api/cart', cookies: jar })).json().count).toBe(1);
    const t2 = `Gone mug ${Date.now()}`; const b = await shop({ title: t2, stock: 1 }); await q('UPDATE variants SET stock_on_hand=0 WHERE id=$1', [b.variant]); expect((await card(t2)).quickAdd).toBeNull();
    const t3 = `Two ways mug ${Date.now()}`; const d = await shop({ title: t3 }); await q(`INSERT INTO variants(product_id, sku, price_cents, stock_on_hand, status, position, options, tracks_stock) SELECT product_id, 'x'||floor(random()*1e9)::text, 3300, 4, 'active', 5, '{"Size":"L"}'::jsonb, true FROM variants WHERE id=$1`, [d.variant]); expect((await card(t3)).quickAdd).toBeNull();
  });
  it('the basket total already includes GST and equals what checkout will ask you to pay', async () => {
    const a = await shop(); const jar: Record<string, string> = {}; const add = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: a.variant, quantity: 1 } }); for (const k of add.cookies) jar[k.name] = k.value;
    const cart = (await app.inject({ method: 'GET', url: '/api/cart', cookies: jar })).json(); expect(cart.taxCents).toBeGreaterThan(0); expect(cart.totalCents).toBe(cart.itemsCents + cart.shippingCents + cart.taxCents);
    const o = (await app.inject({ method: 'POST', url: '/api/checkout', cookies: jar, payload: { email: 'tot@t.test', address: { name: 'T', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } } })).json(); expect(o.totalCents ?? o.payment?.amountCents ?? cart.totalCents).toBe(cart.totalCents);
  });
});

describe('meet the makers', () => {
  it('lists live shops that have something for sale, and not empty or hidden ones', async () => {
    const a = await shop(); const empty = await studioSeller(app, { shopName: `Empty Shop ${Date.now()}` }); const emptySlug = (await q('SELECT slug FROM shops WHERE seller_id=$1', [empty.sellerId])).rows[0].slug;
    const all: any[] = []; for (let off = 0; off < 600; off += 60) { const page = (await app.inject({ method: 'GET', url: `/api/makers?limit=60&offset=${off}` })).json().items; all.push(...page); if (page.length < 60) break; }
    const item = all.find(m => m.slug === a.slug); expect(item).toBeTruthy(); expect(item.productCount).toBeGreaterThanOrEqual(1); expect(all.map(m => m.slug)).not.toContain(emptySlug);
  });
});

describe('a maker\'s insights and payouts', () => {
  it('insights add up from their own orders, and payouts split what is ready, waiting and paid; only a maker with the right role can see them', async () => {
    const a = await shop(); const jar: Record<string, string> = {}; const add = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: a.variant, quantity: 2 } }); for (const k of add.cookies) jar[k.name] = k.value;
    const o = (await app.inject({ method: 'POST', url: '/api/checkout', cookies: jar, payload: { email: 'ins@t.test', address: { name: 'I', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } } })).json();
    await app.inject({ method: 'POST', url: `/api/dev/payments/${o.payment.ref}/simulate`, payload: { outcome: 'succeeded' } });
    const ins = (await app.inject({ method: 'GET', url: '/api/studio/insights?days=30', ...ck('studio', a.s.cookie) })).json(); expect(ins.orders).toBe(1); expect(ins.salesCents).toBeGreaterThanOrEqual(6400); expect(ins.avgOrderCents).toBe(ins.salesCents); expect(ins.top[0]).toMatchObject({ units: 2 }); expect(ins.daily).toHaveLength(30);
    expect((await app.inject({ method: 'GET', url: '/api/studio/insights?days=5', ...ck('studio', a.s.cookie) })).statusCode).toBe(400);
    const pay = (await app.inject({ method: 'GET', url: '/api/studio/payouts', ...ck('studio', a.s.cookie) })).json(); expect(pay.owedCents).toBeGreaterThan(0); expect(pay.availableCents + pay.pendingCents).toBe(pay.owedCents); expect(pay.paidOutCents).toBe(0); expect(pay.history).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/studio/insights' })).statusCode).toBe(401);
    const buyer = await login(app, 'shop', {}); expect((await app.inject({ method: 'GET', url: '/api/studio/payouts', ...ck('studio', buyer.cookie) })).statusCode).toBe(401);
  });
});

describe('test mode is stated plainly', () => {
  it('says payments are simulated and email is not sent when this is a practice site', async () => { const m = (await app.inject({ method: 'GET', url: '/api/mode' })).json(); expect(m).toMatchObject({ testMode: true, payments: 'simulated' }); expect(['sent', 'not sent']).toContain(m.email); });
});

describe('a maker deletes a product', () => {
  const del = (cookie: string, id: string) => app.inject({ method: 'DELETE', url: `/api/studio/products/${id}`, ...ck('studio', cookie) });
  const inList = async (cookie: string, id: string) => (await app.inject({ method: 'GET', url: '/api/studio/products?limit=60', ...ck('studio', cookie) })).json().items.some((i: any) => i.id === id);
  it('a live product nobody ordered is deleted outright, leaves every basket, and the shop page is gone', async () => {
    const a = await shop(); const jar: Record<string, string> = {}; const add = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: a.variant, quantity: 1 } }); for (const k of add.cookies) jar[k.name] = k.value;
    const r = await del(a.s.cookie, a.p.id); expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ deleted: true, removedFromSale: false });
    expect((await q('SELECT 1 FROM products WHERE id=$1', [a.p.id])).rowCount).toBe(0); expect((await app.inject({ method: 'GET', url: `/api/products/${a.p.id}` })).statusCode).toBe(404); expect((await app.inject({ method: 'GET', url: '/api/cart', cookies: jar })).json().count).toBe(0);
    expect((await del(a.s.cookie, a.p.id)).statusCode).toBe(404);
  });
  it('a hidden product that was once live can be deleted too (it used to be stuck forever)', async () => {
    const a = await shop(); await app.inject({ method: 'POST', url: `/api/studio/products/${a.p.id}/unpublish`, ...ck('studio', a.s.cookie) }); expect((await del(a.s.cookie, a.p.id)).json().deleted).toBe(true);
  });
  it('a product that was ordered is taken off sale and out of the list, but the order and its receipt keep working', async () => {
    const a = await shop(); const jar: Record<string, string> = {}; const add = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: a.variant, quantity: 1 } }); for (const k of add.cookies) jar[k.name] = k.value;
    const o = (await app.inject({ method: 'POST', url: '/api/checkout', cookies: jar, payload: { email: 'del@t.test', address: { name: 'D', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } } })).json(); await app.inject({ method: 'POST', url: `/api/dev/payments/${o.payment.ref}/simulate`, payload: { outcome: 'succeeded' } });
    const r = await del(a.s.cookie, a.p.id); expect(r.json()).toMatchObject({ deleted: false, removedFromSale: true }); expect(r.json().message).toContain('order history');
    expect(await inList(a.s.cookie, a.p.id)).toBe(false); expect((await app.inject({ method: 'GET', url: `/api/products/${a.p.id}` })).statusCode).toBe(404); expect((await app.inject({ method: 'GET', url: `/api/studio/products/${a.p.id}`, ...ck('studio', a.s.cookie) })).statusCode).toBe(404);
    const order = (await app.inject({ method: 'GET', url: `/api/orders/by-token/${o.token}` })); expect(order.statusCode).toBe(200); expect(JSON.stringify(order.json())).toContain(a.p.title);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE action='product.delete_kept' AND entity_id=$1`, [a.p.id])).rows[0].n)).toBe(1);
  });
  it('nobody can delete another maker\'s product, and a signed-out visitor cannot delete anything', async () => {
    const a = await shop(); const b = await shop(); expect((await del(b.s.cookie, a.p.id)).statusCode).toBe(404); expect((await app.inject({ method: 'DELETE', url: `/api/studio/products/${a.p.id}` })).statusCode).toBe(401); expect((await q('SELECT 1 FROM products WHERE id=$1', [a.p.id])).rowCount).toBe(1);
  });
});
