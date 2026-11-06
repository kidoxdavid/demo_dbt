import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { ck, cookieOf, jpeg, login, PW, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 1_000_000 }); });
afterAll(async () => { await app.close(); await pool.end(); });
afterEach(async () => { await q('DELETE FROM seller_flags'); await q('DELETE FROM feature_flags'); });

const adm = (cookie: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('admin', cookie) });
const draft = async (cookie: string) => { const m = (await upload(app, cookie, await jpeg())).json(); return (await app.inject({ method: 'POST', url: '/api/studio/products', payload: { title: 'Control mug', categorySlug: 'pottery-ceramics', priceCents: 2200, stock: 4, attributes: {}, mediaIds: [m.id] }, ...ck('studio', cookie) })).json(); };
const publish = (cookie: string, id: string) => app.inject({ method: 'POST', url: `/api/studio/products/${id}/publish`, payload: { acknowledged: true }, ...ck('studio', cookie) });

describe('switches for one maker', () => {
  it('admin pauses publishing, ads and the store promotion for one maker only; the maker is told it was staff; every change is audited with its reason', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const a = await studioSeller(app); const b = await studioSeller(app); const pa = await draft(a.cookie); const pb = await draft(b.cookie);
    const list = (await adm(admin.cookie, 'GET', `/api/admin/sellers/${a.sellerId}/flags`)).json(); expect(list.map((f: any) => f.key).sort()).toEqual(['ads', 'publishing', 'store_promotions']); expect(list.every((f: any) => f.enabled)).toBe(true);
    expect((await adm(admin.cookie, 'PUT', `/api/admin/sellers/${a.sellerId}/flags/publishing`, { enabled: false })).statusCode).toBe(400);             // a reason is required
    expect((await adm(admin.cookie, 'PUT', `/api/admin/sellers/${a.sellerId}/flags/publishing`, { enabled: false, reason: 'Listings under review' })).statusCode).toBe(200);
    const blocked = await publish(a.cookie, pa.id); expect(blocked.statusCode).toBe(403); expect(blocked.json().error).toBe('paused_by_staff'); expect((await publish(b.cookie, pb.id)).statusCode).toBe(200);
    await adm(admin.cookie, 'PUT', `/api/admin/sellers/${a.sellerId}/flags/ads`, { enabled: false, reason: 'Ad abuse' }); await adm(admin.cookie, 'PUT', `/api/admin/sellers/${a.sellerId}/flags/store_promotions`, { enabled: false, reason: 'Wording review' });
    const camp = { name: 'C', productIds: [pb.id], bidCents: 30, dailyBudgetCents: 500, totalBudgetCents: null, categories: [], keywords: [] };
    expect((await app.inject({ method: 'POST', url: '/api/studio/ads', payload: { ...camp, productIds: [pa.id] }, ...ck('studio', a.cookie) })).json().error).toBe('paused_by_staff');
    expect((await app.inject({ method: 'PUT', url: '/api/studio/promotion', payload: { headline: 'Hi', productId: null }, ...ck('studio', a.cookie) })).json().error).toBe('paused_by_staff');
    expect((await app.inject({ method: 'POST', url: '/api/studio/ads', payload: camp, ...ck('studio', b.cookie) })).statusCode).toBe(201);
    const hist = (await q(`SELECT action, reason FROM audit_log WHERE entity_type='seller' AND entity_id=$1 AND action LIKE 'seller.flag.%' ORDER BY id`, [a.sellerId])).rows; expect(hist.map(h => h.action)).toEqual(['seller.flag.publishing', 'seller.flag.ads', 'seller.flag.store_promotions']); expect(hist[0].reason).toBe('Listings under review');
    await adm(admin.cookie, 'PUT', `/api/admin/sellers/${a.sellerId}/flags/publishing`, { enabled: true, reason: 'Cleared' }); expect((await publish(a.cookie, pa.id)).statusCode).toBe(200);
  });
  it('a paused maker\'s running ads and store promotion stop showing to buyers', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const a = await studioSeller(app); const p = await draft(a.cookie); await publish(a.cookie, p.id); const slug = (await q('SELECT slug FROM shops WHERE seller_id=$1', [a.sellerId])).rows[0].slug;
    await q('DELETE FROM app_settings WHERE key=$1', ['store_promotions_require_approval']); await app.inject({ method: 'PUT', url: '/api/admin/settings/store_promotions_require_approval', payload: { value: false }, ...ck('admin', admin.cookie) });
    await app.inject({ method: 'PUT', url: '/api/studio/promotion', payload: { headline: 'Showing now', productId: p.id }, ...ck('studio', a.cookie) }); const shown = async () => (await app.inject({ method: 'GET', url: `/api/shops/${slug}/promotion` })).json().promotion;
    expect(await shown()).not.toBeNull(); await adm(admin.cookie, 'PUT', `/api/admin/sellers/${a.sellerId}/flags/store_promotions`, { enabled: false, reason: 'Review' }); expect(await shown()).toBeNull();
    await q('DELETE FROM app_settings WHERE key=$1', ['store_promotions_require_approval']);
  });
  it('only staff with maker-write power can flip them', async () => {
    const a = await studioSeller(app); const support = await login(app, 'support', { role: 'support' });
    expect((await app.inject({ method: 'PUT', url: `/api/admin/sellers/${a.sellerId}/flags/ads`, payload: { enabled: false, reason: 'nope nope' }, ...ck('support', support.cookie) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: `/api/admin/sellers/${a.sellerId}/flags/ads`, payload: { enabled: false, reason: 'nope nope' }, ...ck('studio', a.cookie) })).statusCode).toBe(401);
  });
});

describe('admin acts as a maker', () => {
  it('needs a reason and the admin\'s own password; then works inside that one maker\'s studio, and everything changed is logged against the maker', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const a = await studioSeller(app); const other = await studioSeller(app); const act = (payload: object) => adm(admin.cookie, 'POST', `/api/admin/sellers/${a.sellerId}/act-as`, payload);
    expect((await act({ reason: 'x', password: PW })).statusCode).toBe(400); expect((await act({ reason: 'Fixing a listing for them', password: 'not-my-password' })).json().error).toBe('wrong_password');
    const r = await act({ reason: 'Fixing a listing for them', password: PW }); expect(r.statusCode).toBe(200); const cookie = cookieOf(r, 'studio'); expect(cookie).toBeTruthy();
    const me = (await app.inject({ method: 'GET', url: '/api/studio/me', ...ck('studio', cookie) })).json(); expect(me.acting).toMatchObject({ sellerId: a.sellerId, reason: 'Fixing a listing for them' });
    const p = await draft(cookie); expect(p.id).toBeTruthy(); expect((await q('SELECT seller_id FROM products WHERE id=$1', [p.id])).rows[0].seller_id).toBe(a.sellerId);
    expect((await app.inject({ method: 'GET', url: `/api/studio/products/${(await draft(other.cookie)).id}`, ...ck('studio', cookie) })).statusCode).toBeGreaterThanOrEqual(403);        // only this maker's things
    const logged = (await q(`SELECT action, next FROM audit_log WHERE entity_type='seller' AND entity_id=$1 AND actor_id=$2 ORDER BY id`, [a.sellerId, admin.id])).rows; expect(logged[0].action).toBe('seller.act_as.start');
    expect(logged.some(l => l.action === 'acting.request' && l.next.method === 'POST' && l.next.path === '/api/studio/products')).toBe(true);
    const end = await app.inject({ method: 'POST', url: '/api/studio/acting/end', ...ck('studio', cookie) }); expect(end.json().back).toBe(`/admin/sellers/${a.sellerId}`); expect((await app.inject({ method: 'GET', url: '/api/studio/me', ...ck('studio', cookie) })).statusCode).toBe(401);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE action='seller.act_as.end' AND entity_id=$1`, [a.sellerId])).rows[0].n)).toBe(1);
  });
  it('is limited to a couple of hours, refused for anyone but staff with maker-write power, and a normal maker session is never marked acting', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const a = await studioSeller(app); const support = await login(app, 'support', { role: 'support' });
    const r = await adm(admin.cookie, 'POST', `/api/admin/sellers/${a.sellerId}/act-as`, { reason: 'Checking something', password: PW }); const exp = (await q(`SELECT expires_at FROM sessions WHERE acting_seller_id=$1`, [a.sellerId])).rows[0].expires_at as Date; expect(exp.getTime() - Date.now()).toBeLessThanOrEqual(2 * 3600_000 + 5000); expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/sellers/${a.sellerId}/act-as`, payload: { reason: 'Checking something', password: PW }, ...ck('support', support.cookie) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/studio/me', ...ck('studio', a.cookie) })).json().acting).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/api/studio/acting/end', ...ck('studio', a.cookie) })).statusCode).toBe(409);
    expect((await adm(admin.cookie, 'POST', `/api/admin/sellers/00000000-0000-4000-8000-000000000000/act-as`, { reason: 'Checking something', password: PW })).statusCode).toBe(404);
  });
});

describe('open another console from admin', () => {
  it('admin enters support, finance or marketing without signing in again; nobody else can; each has its own session', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const r = await adm(admin.cookie, 'POST', '/api/admin/portals/support/enter'); expect(r.statusCode).toBe(200); expect(r.json().url).toBe('/support');
    const c = cookieOf(r, 'support'); expect((await app.inject({ method: 'GET', url: '/api/support/me', ...ck('support', c) })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { 'x-area': 'support' }, ...ck('support', c) }); expect((await app.inject({ method: 'GET', url: '/api/admin/me', ...ck('admin', admin.cookie) })).statusCode).toBe(200);
    expect((await adm(admin.cookie, 'POST', '/api/admin/portals/studio/enter')).statusCode).toBe(400);
    const fin = await login(app, 'finance', { role: 'finance' }); expect((await app.inject({ method: 'POST', url: '/api/admin/portals/support/enter', ...ck('admin', fin.cookie) })).statusCode).toBe(401);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE action='portal.enter' AND actor_id=$1`, [admin.id])).rows[0].n)).toBe(1);
  });
});
