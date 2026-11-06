import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { ck, jpeg, login, studioSeller, upload } from './helpers.js';
import { FLAGS } from '../src/settings.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 1_000_000 }); });
afterAll(async () => { await app.close(); await pool.end(); });
afterEach(async () => { await q('DELETE FROM feature_flags'); });

const setFlag = (cookie: string, key: string, enabled: boolean) => app.inject({ method: 'PUT', url: `/api/admin/flags/${key}`, payload: { enabled, reason: 'test' }, ...ck('admin', cookie) });
const listedProduct = async () => {
  const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
  const p = (await app.inject({ method: 'POST', url: '/api/studio/products', payload: { title: 'Toggle mug', categorySlug: 'pottery-ceramics', priceCents: 2000, stock: 5, attributes: {}, mediaIds: [m.id] }, ...ck('studio', s.cookie) })).json();
  await app.inject({ method: 'POST', url: `/api/studio/products/${p.id}/publish`, payload: { acknowledged: true }, ...ck('studio', s.cookie) });
  return { s, p, variant: (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id as string, shop: (await q('SELECT slug FROM shops WHERE seller_id=$1', [s.sellerId])).rows[0].slug as string };
};

describe('every toggle is real', () => {
  it('lists each toggle with its portal, wording and state, and only admin may change them; changes are audited', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const list = (await app.inject({ method: 'GET', url: '/api/admin/flags', ...ck('admin', admin.cookie) })).json();
    expect(list.map((f: any) => f.key).sort()).toEqual([...FLAGS].sort()); expect(list.every((f: any) => f.label && f.help && f.portal && typeof f.enabled === 'boolean')).toBe(true);
    const support = await login(app, 'support', { role: 'support' }); expect((await app.inject({ method: 'PUT', url: '/api/admin/flags/reviews', payload: { enabled: false }, ...ck('support', support.cookie) })).statusCode).toBe(401);   // support has no admin-window session at all
    expect((await setFlag(admin.cookie, 'wishlists', false)).statusCode).toBe(200); expect((await app.inject({ method: 'GET', url: '/api/flags' })).json().wishlists).toBe(false);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE action='flag.update' AND entity_id='wishlists'`)).rows[0].n)).toBe(1);
  });
  it('hearts, follows and gift messages stop working when switched off, and resume when switched on', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const { p, variant, shop } = await listedProduct(); const buyer = await login(app, 'shop', {});
    const heart = () => app.inject({ method: 'PUT', url: `/api/me/saved/${p.id}`, ...ck('shop', buyer.cookie) }); const follow = () => app.inject({ method: 'PUT', url: `/api/shops/${shop}/follow`, ...ck('shop', buyer.cookie) });
    expect((await heart()).statusCode).toBe(204); expect((await follow()).statusCode).toBe(204);
    await setFlag(admin.cookie, 'wishlists', false); await setFlag(admin.cookie, 'shop_follows', false); expect((await heart()).statusCode).toBe(404); expect((await follow()).statusCode).toBe(404);
    await setFlag(admin.cookie, 'wishlists', true); expect((await heart()).statusCode).toBe(204);
    const jar: Record<string, string> = {}; const add = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: variant, quantity: 1 } }); for (const c of add.cookies) jar[c.name] = c.value;
    const sellerId = (await q('SELECT seller_id FROM products WHERE id=$1', [p.id])).rows[0].seller_id;
    const gift = () => app.inject({ method: 'PUT', url: `/api/cart/gift/${sellerId}`, cookies: jar, payload: { isGift: true, message: 'hi' } });
    expect((await gift()).statusCode).toBeLessThan(300); await setFlag(admin.cookie, 'gift_options', false); expect((await gift()).statusCode).toBe(404);
  });
  it('guest checkout off asks for sign-in; signed-in buyers still pay', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const { variant } = await listedProduct(); const addr = { name: 'G', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' };
    await setFlag(admin.cookie, 'guest_checkout', false);
    const jar: Record<string, string> = {}; const add = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: variant, quantity: 1 } }); for (const c of add.cookies) jar[c.name] = c.value;
    const guest = await app.inject({ method: 'POST', url: '/api/checkout', cookies: jar, payload: { email: 'g@t.test', address: addr } }); expect(guest.statusCode).toBe(401); expect(guest.json().error).toBe('sign_in_required');
    const buyer = await login(app, 'shop', {}); const a2 = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: variant, quantity: 1 }, cookies: { es_shop: buyer.cookie } }); const jar2: Record<string, string> = { es_shop: buyer.cookie }; for (const c of a2.cookies) jar2[c.name] = c.value;
    expect((await app.inject({ method: 'POST', url: '/api/checkout', cookies: jar2, payload: { address: addr } })).statusCode).toBe(201);
  });
  it('closing buyer and maker sign-ups refuses new accounts but leaves existing ones alone', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); await setFlag(admin.cookie, 'buyer_signups', false); await setFlag(admin.cookie, 'maker_signups', false);
    const b = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `new${Date.now()}@t.test`, password: 'correct-horse-battery', fullName: 'New Buyer' } }); expect(b.statusCode).toBe(403); expect(b.json().error).toBe('signups_closed');
    const m = await app.inject({ method: 'POST', url: '/api/studio/signup', payload: { email: `mk${Date.now()}@t.test`, password: 'correct-horse-battery', fullName: 'New Maker', categories: ['pottery-ceramics'], shopName: 'Closed Shop' } }); expect(m.statusCode).toBe(403); expect(m.json().error).toBe('signups_closed');
    expect((await login(app, 'shop', {})).cookie).toBeTruthy();
    await setFlag(admin.cookie, 'buyer_signups', true); expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `ok${Date.now()}@t.test`, password: 'correct-horse-battery', fullName: 'Ok Buyer' } })).statusCode).toBe(201);
  });
});
