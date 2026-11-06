import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { ck, jpeg, login, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 1_000_000 }); });
afterAll(async () => { await app.close(); await pool.end(); });
afterEach(async () => { await q('DELETE FROM feature_flags'); await q(`DELETE FROM app_settings WHERE key='store_promotions_require_approval'`); });

const maker = async () => {
  const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
  const p = (await app.inject({ method: 'POST', url: '/api/studio/products', payload: { title: 'Promo vase', categorySlug: 'pottery-ceramics', priceCents: 3200, stock: 5, attributes: {}, mediaIds: [m.id] }, ...ck('studio', s.cookie) })).json();
  await app.inject({ method: 'POST', url: `/api/studio/products/${p.id}/publish`, payload: { acknowledged: true }, ...ck('studio', s.cookie) });
  return { s, p, slug: (await q('SELECT slug FROM shops WHERE seller_id=$1', [s.sellerId])).rows[0].slug as string };
};
const st = (c: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', c) });
const shown = async (slug: string) => (await app.inject({ method: 'GET', url: `/api/shops/${slug}/promotion` })).json().promotion;
const body = (productId: string | null, extra: object = {}) => ({ headline: 'Autumn glaze sale', body: 'Small batch, fired this week.', ctaLabel: 'See the vase', productId, ...extra });

describe('store promotions: a maker promotes their own store page', () => {
  it('waits for approval, then shows on the store page with the featured piece; clicks and views are counted', async () => {
    const { s, p, slug } = await maker(); const mkt = await login(app, 'marketing', { role: 'marketing' });
    const put = await st(s.cookie, 'PUT', '/api/studio/promotion', body(p.id)); expect(put.statusCode).toBe(200); expect(put.json().promotion.status).toBe('pending'); expect(await shown(slug)).toBeNull();
    const list = (await app.inject({ method: 'GET', url: '/api/marketing/promotions?status=pending', ...ck('marketing', mkt.cookie) })).json(); const row = list.find((r: any) => r.slug === slug); expect(row.headline).toBe('Autumn glaze sale');
    expect((await app.inject({ method: 'POST', url: `/api/marketing/promotions/${row.id}/decide`, payload: { decision: 'approve' }, ...ck('marketing', mkt.cookie) })).statusCode).toBe(200);
    const live = await shown(slug); expect(live.headline).toBe('Autumn glaze sale'); expect(live.product.id).toBe(p.id); expect(live.product.priceCents).toBe(3200);
    expect((await app.inject({ method: 'POST', url: `/api/shops/${slug}/promotion/click` })).statusCode).toBe(204); await new Promise(r => setTimeout(r, 100));
    const mine = (await st(s.cookie, 'GET', '/api/studio/promotion')).json().promotion; expect(mine.status).toBe('live'); expect(mine.clicks).toBe(1); expect(mine.views).toBeGreaterThanOrEqual(1);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1`, [row.id])).rows[0].n)).toBeGreaterThanOrEqual(2);
  });
  it('an edit goes back for approval, pausing hides it, resuming works only for an approved one, and a rejection shows its reason', async () => {
    const { s, p, slug } = await maker(); const admin = await login(app, 'admin', { role: 'admin' }); const decide = (id: string, payload: object) => app.inject({ method: 'POST', url: `/api/admin/promotions/${id}/decide`, payload, ...ck('admin', admin.cookie) });
    const id = (await st(s.cookie, 'PUT', '/api/studio/promotion', body(p.id))).json().promotion.id; expect((await st(s.cookie, 'POST', '/api/studio/promotion/status', { status: 'live' })).statusCode).toBe(409);
    expect((await decide(id, { decision: 'approve' })).statusCode).toBe(200); expect(await shown(slug)).not.toBeNull();
    expect((await st(s.cookie, 'POST', '/api/studio/promotion/status', { status: 'paused' })).statusCode).toBe(200); expect(await shown(slug)).toBeNull();
    expect((await st(s.cookie, 'POST', '/api/studio/promotion/status', { status: 'live' })).statusCode).toBe(200); expect(await shown(slug)).not.toBeNull();
    const edited = (await st(s.cookie, 'PUT', '/api/studio/promotion', body(p.id, { headline: 'New wording' }))).json().promotion; expect(edited.status).toBe('pending'); expect(await shown(slug)).toBeNull();
    expect((await decide(id, { decision: 'reject' })).statusCode).toBe(422); expect((await decide(id, { decision: 'reject', reason: 'Please remove the discount claim' })).statusCode).toBe(200);
    const after = (await st(s.cookie, 'GET', '/api/studio/promotion')).json().promotion; expect(after.status).toBe('rejected'); expect(after.rejectReason).toBe('Please remove the discount claim'); expect(await shown(slug)).toBeNull();
    expect((await st(s.cookie, 'POST', '/api/studio/promotion/status', { status: 'live' })).statusCode).toBe(409);
    expect((await st(s.cookie, 'PUT', '/api/studio/promotion', body(p.id, { headline: 'Fixed wording' }))).json().promotion.status).toBe('pending');          // a fix goes back for review
  });
  it('the approval setting off makes promotions live at once; the feature toggle off hides and blocks them', async () => {
    const { s, p, slug } = await maker(); const admin = await login(app, 'admin', { role: 'admin' });
    await app.inject({ method: 'PUT', url: '/api/admin/settings/store_promotions_require_approval', payload: { value: false }, ...ck('admin', admin.cookie) });
    expect((await st(s.cookie, 'PUT', '/api/studio/promotion', body(p.id))).json().promotion.status).toBe('live'); expect(await shown(slug)).not.toBeNull();
    await app.inject({ method: 'PUT', url: '/api/admin/flags/store_promotions', payload: { enabled: false }, ...ck('admin', admin.cookie) });
    expect(await shown(slug)).toBeNull(); expect((await st(s.cookie, 'GET', '/api/studio/promotion')).statusCode).toBe(404); expect((await st(s.cookie, 'PUT', '/api/studio/promotion', body(p.id))).statusCode).toBe(404);
  });
  it('only a maker may create one, only for their own pieces, with sane dates; staff other than marketing and admin cannot decide', async () => {
    const a = await maker(); const b = await maker(); const dates = { startsOn: '2030-01-10', endsOn: '2030-01-01' };
    expect((await st(a.s.cookie, 'PUT', '/api/studio/promotion', body(b.p.id))).statusCode).toBe(422);
    expect((await st(a.s.cookie, 'PUT', '/api/studio/promotion', body(a.p.id, dates))).statusCode).toBe(422);
    expect((await st(a.s.cookie, 'PUT', '/api/studio/promotion', { ...body(a.p.id), headline: '' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/studio/promotion', payload: body(a.p.id) })).statusCode).toBe(401);
    const id = (await st(a.s.cookie, 'PUT', '/api/studio/promotion', body(a.p.id, { startsOn: '2999-01-01' }))).json().promotion.id;
    const support = await login(app, 'support', { role: 'support' }); expect((await app.inject({ method: 'POST', url: `/api/support/promotions/${id}/decide`, payload: { decision: 'approve' }, ...ck('support', support.cookie) })).statusCode).toBe(404);
    const mkt = await login(app, 'marketing', { role: 'marketing' }); await app.inject({ method: 'POST', url: `/api/marketing/promotions/${id}/decide`, payload: { decision: 'approve' }, ...ck('marketing', mkt.cookie) });
    expect(await shown(a.slug)).toBeNull();          // approved, but its start date is in the future
  });
});
