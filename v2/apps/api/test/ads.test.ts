import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { readClick } from '../src/lib/ads.js';
import { ck, jpeg, login, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); await q(`INSERT INTO app_settings(key,value) VALUES ('ads_slots_per_page','4'),('ads_min_bid_cents','20') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`); });
afterAll(async () => { await q(`DELETE FROM app_settings WHERE key IN ('ads_slots_per_page','ads_min_bid_cents')`); await app.close(); await pool.end(); });
const st = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', cookie) });
const ledgerSum = async (where = 'true') => Number((await q(`SELECT coalesce(sum(amount_cents),0) s FROM ledger_entries WHERE ${where}`)).rows[0].s);
let ipn = 10;
const click = (token: string, ip = `10.9.${ipn++}.${ipn++}`, cookie?: string) => app.inject({ method: 'POST', url: '/api/ads/click', payload: { token }, remoteAddress: ip, ...(cookie ? ck('shop', cookie) : {}) });
const serve = async (qs: string) => (await app.inject({ method: 'GET', url: `/api/ads?${qs}` })).json().items as any[];

/** A seller with a live product and some earnings (a paid order), so their clicks can be charged. */
async function advertiser(opts: { title?: string; category?: string; stock?: number; earn?: boolean; attrs?: object } = {}) {
  const s = await studioSeller(app, { categories: [opts.category ?? 'pottery-ceramics'] }); const m = (await upload(app, s.cookie, await jpeg())).json();
  const p = (await st(s.cookie, 'POST', '/api/studio/products', { title: opts.title ?? 'Sponsored mug', categorySlug: opts.category ?? 'pottery-ceramics', priceCents: 4000, stock: opts.stock ?? 20, attributes: opts.attrs ?? {}, mediaIds: [m.id] })).json(); const pub = await st(s.cookie, 'POST', `/api/studio/products/${p.id}/publish`, { acknowledged: true }); if (pub.statusCode !== 200) throw new Error(pub.body);
  const v = (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id as string;
  if (opts.earn !== false) { const jar: Record<string, string> = {}; const call = async (method: any, url: string, payload?: object) => { const r = await app.inject({ method, url, cookies: jar, ...(payload ? { payload } : {}) }); for (const c of r.cookies) jar[c.name] = c.value; return r; };
    await call('POST', '/api/cart/items', { variantId: v, quantity: 1 }); const o = (await call('POST', '/api/checkout', { email: `ad${Date.now()}@t.test`, address: { name: 'Bea', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } })).json(); await app.inject({ method: 'POST', url: `/api/dev/payments/${o.payment.ref}/simulate`, payload: { outcome: 'succeeded' } }); }
  return { ...s, productId: p.id as string, variantId: v };
}
const campaign = (a: { cookie: string; productId: string }, over: object = {}) => st(a.cookie, 'POST', '/api/studio/ads', { name: 'Spring push', productIds: [a.productId], bidCents: 50, dailyBudgetCents: 500, totalBudgetCents: null, categories: ['pottery-ceramics'], keywords: [], ...over });

describe('campaigns', () => {
  it('validates bids, budgets and products; sellers only touch their own; staff-restricted and unpublished pieces cannot be advertised', async () => {
    const a = await advertiser(); const b = await advertiser(); const c = await campaign(a); expect(c.statusCode).toBe(201); expect(c.json()).toMatchObject({ status: 'active', bidCents: 50, serving: 'serving', impressions: 0 });
    expect((await campaign(a, { bidCents: 5 })).json().error).toBe('bid_too_low'); expect((await campaign(a, { bidCents: 300, dailyBudgetCents: 200 })).json().error).toBe('budget_below_bid'); expect((await campaign(a, { productIds: [b.productId] })).json().error).toBe('product_not_eligible');
    expect((await campaign(a, { categories: ['nope'] })).json().error).toBe('category_not_found'); expect((await campaign(a, { productIds: [] })).statusCode).toBe(400);
    const draft = (await st(a.cookie, 'POST', '/api/studio/products', { title: 'Unfinished' })).json(); expect((await campaign(a, { productIds: [draft.id] })).json().error).toBe('product_not_eligible');
    const toy = await advertiser({ category: 'toys-games', attrs: { age_range: '3-5' }, title: 'Toy blocks' }); expect((await campaign(toy, { categories: [] })).json().error).toBe('product_not_eligible');          // restricted categories cannot be advertised
    const id = c.json().id; expect((await st(b.cookie, 'GET', `/api/studio/ads/${id}`)).statusCode).toBe(404); expect((await st(b.cookie, 'PATCH', `/api/studio/ads/${id}`, { status: 'paused' })).statusCode).toBe(404); expect((await st(b.cookie, 'GET', '/api/studio/ads')).json().campaigns).toHaveLength(0);
    const up = await st(a.cookie, 'PATCH', `/api/studio/ads/${id}`, { bidCents: 80, status: 'paused' }); expect(up.json()).toMatchObject({ bidCents: 80, status: 'paused', serving: 'paused' }); expect((await st(a.cookie, 'PATCH', `/api/studio/ads/${id}`, { bidCents: 10 })).json().error).toBe('bid_too_low');
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action IN ('ad.create','ad.paused')`, [id])).rows[0].n)).toBe(2);
    expect((await st(a.cookie, 'PATCH', `/api/studio/ads/${id}`, { status: 'ended' })).json().status).toBe('ended'); expect((await st(a.cookie, 'PATCH', `/api/studio/ads/${id}`, { status: 'active' })).json().error).toBe('campaign_ended');
  });
});

describe('serving and the auction', () => {
  it('serves only eligible, matching, funded pieces; paused, out-of-stock, unfunded and off-topic ones stay out', async () => {
    const a = await advertiser({ title: 'Eligible sponsored jug' }); const id = (await campaign(a)).json().id; const here = async () => (await serve('placement=category&category=pottery-ceramics')).map(x => x.id);
    expect(await here()).toContain(a.productId); expect((await serve('placement=category&category=candles-home-fragrance')).map(x => x.id)).not.toContain(a.productId); const card = (await serve('placement=category&category=pottery-ceramics')).find(x => x.id === a.productId); expect(card).toMatchObject({ sponsored: true, title: 'Eligible sponsored jug' }); expect(card.token).toContain('.');
    await st(a.cookie, 'PATCH', `/api/studio/ads/${id}`, { status: 'paused' }); expect(await here()).not.toContain(a.productId); await st(a.cookie, 'PATCH', `/api/studio/ads/${id}`, { status: 'active' }); expect(await here()).toContain(a.productId);
    await q('UPDATE variants SET stock_on_hand=0 WHERE id=$1', [a.variantId]); expect(await here()).not.toContain(a.productId); await q('UPDATE variants SET stock_on_hand=20 WHERE id=$1', [a.variantId]);
    const broke = await advertiser({ earn: false }); await campaign(broke); expect(await here()).not.toContain(broke.productId); expect((await st(broke.cookie, 'GET', '/api/studio/ads')).json().campaigns[0].serving).toBe('low_balance');
    const off = (await app.inject({ method: 'GET', url: '/api/ads?placement=category' })).statusCode; expect(off).toBe(200);
  });
  it('search ads need a keyword hit or the piece itself matching the search; one ad per seller; the slot limit holds', async () => {
    const a = await advertiser({ title: 'Quokka teapot' }); await campaign(a, { categories: [], keywords: ['teapot'] });
    expect((await serve('placement=search&q=teapot')).map(x => x.id)).toContain(a.productId); expect((await serve('placement=search&q=bicycle')).map(x => x.id)).not.toContain(a.productId);
    const b = await advertiser({ title: 'Zorblax vase' }); await campaign(b, { categories: [], keywords: [] }); expect((await serve('placement=search&q=zorblax')).map(x => x.id)).toContain(b.productId); expect((await serve('placement=search&q=zorblax%20teapot')).map(x => x.id)).not.toContain(b.productId);
    const two = await advertiser({ title: 'Twin one' }); const m = (await upload(app, two.cookie, await jpeg())).json(); const p2 = (await st(two.cookie, 'POST', '/api/studio/products', { title: 'Twin two', categorySlug: 'pottery-ceramics', priceCents: 3000, stock: 5, attributes: {}, mediaIds: [m.id] })).json(); await st(two.cookie, 'POST', `/api/studio/products/${p2.id}/publish`, { acknowledged: true });
    await campaign(two, { productIds: [two.productId], bidCents: 90 }); await campaign(two, { productIds: [p2.id], bidCents: 80 }); const items = await serve('placement=category&category=pottery-ceramics'); expect(items.filter(x => [two.productId, p2.id].includes(x.id))).toHaveLength(1);
    await q(`UPDATE app_settings SET value='1' WHERE key='ads_slots_per_page'`); expect((await serve('placement=category&category=pottery-ceramics')).length).toBe(1); await q(`UPDATE app_settings SET value='0' WHERE key='ads_slots_per_page'`); expect(await serve('placement=category&category=pottery-ceramics')).toEqual([]); await q(`UPDATE app_settings SET value='4' WHERE key='ads_slots_per_page'`);
  });
  it('the highest bid wins and pays one cent over the next bid, never below the minimum nor above its own bid; impressions are counted', async () => {
    const hi = await advertiser({ title: 'Auction high' }); const lo = await advertiser({ title: 'Auction low' }); await campaign(hi, { bidCents: 900, dailyBudgetCents: 20000, categories: ['stationery-paper'] }); await campaign(lo, { bidCents: 800, dailyBudgetCents: 20000, categories: ['stationery-paper'] });
    // a private auction page: move both pieces to a category nothing else advertises in
    await q(`UPDATE product_categories SET category_id=(SELECT id FROM categories WHERE slug='stationery-paper') WHERE product_id = ANY($1::uuid[])`, [[hi.productId, lo.productId]]);
    const items = (await serve('placement=category&category=stationery-paper')).filter(x => [hi.productId, lo.productId].includes(x.id)); expect(items.map(x => x.id)).toEqual([hi.productId, lo.productId]);
    expect(readClick(items[0].token)!.k).toBe(801); expect(readClick(items[1].token)!.k).toBe(20);          // the winner pays 1 cent over the runner-up; the last bidder pays the minimum
  });
});

describe('clicks and money', () => {
  it('a click is charged once as a balanced ledger entry; tampered, replayed and repeat clicks are free; stats add up', async () => {
    const a = await advertiser({ title: 'Click me mug' }); const id = (await campaign(a, { bidCents: 70, dailyBudgetCents: 1000 })).json().id; const get = async () => (await serve('placement=category&category=pottery-ceramics')).find(x => x.id === a.productId);
    const owedBefore = Number((await q(`SELECT -sum(amount_cents) o FROM ledger_entries WHERE seller_id=$1 AND account='seller_payable'`, [a.sellerId])).rows[0].o); const ad = await get(); const price = readClick(ad.token)!.k; expect(price).toBeGreaterThanOrEqual(20); expect(price).toBeLessThanOrEqual(70);
    expect((await click(ad.token + 'x')).statusCode).toBe(400); expect((await click('abc.def')).statusCode).toBe(400);
    const total0 = await ledgerSum(); const r = await click(ad.token); expect(r.json()).toMatchObject({ charged: true, productId: a.productId }); expect(await ledgerSum()).toBe(total0);
    expect(await ledgerSum(`account='ad_revenue' AND seller_id='${a.sellerId}'`)).toBe(-price); expect(Number((await q(`SELECT -sum(amount_cents) o FROM ledger_entries WHERE seller_id=$1 AND account='seller_payable'`, [a.sellerId])).rows[0].o)).toBe(owedBefore - price);
    expect((await click(ad.token)).json()).toMatchObject({ charged: false, reason: 'already_used' });
    const again = await get(); expect((await app.inject({ method: 'POST', url: '/api/ads/click', payload: { token: again.token }, remoteAddress: '10.77.0.1' })).json().charged).toBe(true); const third = await get(); const same = await app.inject({ method: 'POST', url: '/api/ads/click', payload: { token: third.token }, remoteAddress: '10.77.0.1' }); expect(same.json()).toMatchObject({ charged: false, reason: 'repeat_click' });
    const detail = (await st(a.cookie, 'GET', `/api/studio/ads/${id}`)).json(); expect(detail.clicks).toBe(2); expect(detail.impressions).toBe(3); expect(detail.spendCents).toBeGreaterThan(0); expect(detail.ctr).toBeCloseTo(66.7, 0); expect(detail.daily).toHaveLength(14); expect(detail.daily[13].clicks).toBe(2);
  });
  it('the seller\'s own team is never charged, the daily budget stops serving, and an empty balance stops charging', async () => {
    const a = await advertiser({ title: 'Budget mug' }); await campaign(a, { bidCents: 60, dailyBudgetCents: 100 }); const owner = await login(app, 'shop', { role: 'seller_owner', sellerId: a.sellerId }); const get = async () => (await serve('placement=category&category=pottery-ceramics')).find(x => x.id === a.productId);
    const own = await get(); expect((await click(own.token, undefined, owner.cookie)).json()).toMatchObject({ charged: false, reason: 'own_team' });
    const t1 = await get(); const t2 = await get(); const c1 = (await click(t1.token)).json(); expect(c1.charged).toBe(true); const c2 = (await click(t2.token)).json(); expect(c2).toMatchObject({ charged: false, reason: 'budget_reached' }); expect(await get()).toBeUndefined();
    expect((await st(a.cookie, 'GET', '/api/studio/ads')).json().campaigns[0].serving).toBe('daily_budget_reached');
  });
  it('an empty balance stops charging clicks, and the campaign reports low balance', async () => {
    const b = await advertiser({ title: 'Drained mug' }); await campaign(b, { bidCents: 60, dailyBudgetCents: 1000 }); const tk = (await serve('placement=category&category=pottery-ceramics')).find(x => x.id === b.productId); expect(tk).toBeDefined();
    const owed = Number((await q(`SELECT -sum(amount_cents) o FROM ledger_entries WHERE seller_id=$1 AND account='seller_payable'`, [b.sellerId])).rows[0].o);
    await q(`INSERT INTO ledger_entries(txn_id,seller_id,account,amount_cents,memo) VALUES ('00000000-0000-4000-8000-0000000000bb',$1,'seller_payable',$2,'paid out in full'),('00000000-0000-4000-8000-0000000000bb',$1,'cash',$3,'paid out in full')`, [b.sellerId, owed, -owed]);
    const r = await click(tk.token); expect(r.json()).toMatchObject({ charged: false, reason: 'low_balance' }); expect(await ledgerSum(`account='ad_revenue' AND seller_id='${b.sellerId}'`)).toBe(0);
    expect((await serve('placement=category&category=pottery-ceramics')).map(x => x.id)).not.toContain(b.productId); expect((await st(b.cookie, 'GET', '/api/studio/ads')).json().campaigns[0].serving).toBe('low_balance');
  });
});

describe('staff control and reporting', () => {
  it('marketing can block a campaign (it stops serving, the seller cannot restart it) and unblock it; support cannot', async () => {
    const a = await advertiser({ title: 'Blocked mug' }); const id = (await campaign(a)).json().id; const m = await login(app, 'marketing', { role: 'marketing' }); const sup = await login(app, 'support', { role: 'support' });
    const mk = (cookie: string, area: 'marketing' | 'support', method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck(area, cookie) });
    expect((await mk(sup.cookie, 'support', 'GET', '/api/marketing/ads')).statusCode).toBe(401); expect((await mk(m.cookie, 'marketing', 'GET', '/api/marketing/ads')).json().map((x: any) => x.id)).toContain(id);
    expect((await mk(m.cookie, 'marketing', 'POST', `/api/marketing/ads/${id}/block`, { reason: 'x' })).statusCode).toBe(400); expect((await mk(m.cookie, 'marketing', 'POST', `/api/marketing/ads/${id}/block`, { reason: 'Misleading price claims in the shop' })).statusCode).toBe(200);
    expect((await serve('placement=category&category=pottery-ceramics')).map(x => x.id)).not.toContain(a.productId); expect((await st(a.cookie, 'PATCH', `/api/studio/ads/${id}`, { status: 'active' })).json().error).toBe('blocked_by_staff');
    expect((await st(a.cookie, 'GET', '/api/studio/ads')).json().campaigns[0]).toMatchObject({ serving: 'blocked', blockedReason: 'Misleading price claims in the shop' });
    expect((await mk(m.cookie, 'marketing', 'POST', `/api/marketing/ads/${id}/unblock`, { reason: 'Seller fixed the shop' })).statusCode).toBe(200); expect((await st(a.cookie, 'PATCH', `/api/studio/ads/${id}`, { status: 'active' })).json().status).toBe('active');
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action IN ('ad.block','ad.unblock')`, [id])).rows[0].n)).toBe(2);
  });
  it('finance sees ad revenue from the ledger, the whole ledger still balances, and the feature flag switches ads off', async () => {
    const f = await login(app, 'finance', { role: 'finance' }); const o = (await app.inject({ method: 'GET', url: '/api/finance/overview', ...ck('finance', f.cookie) })).json(); expect(o.ledger.adRevenue).toBe(-(await ledgerSum(`account='ad_revenue'`))); expect(o.ledger.adRevenue).toBeGreaterThan(0); expect(await ledgerSum()).toBe(0);
    const a = await advertiser({ title: 'Flag mug' }); await campaign(a); await q(`INSERT INTO feature_flags(key,enabled) VALUES ('ads',false) ON CONFLICT (key) DO UPDATE SET enabled=false`);
    try { expect(await serve('placement=category&category=pottery-ceramics')).toEqual([]); expect((await st(a.cookie, 'GET', '/api/studio/ads')).statusCode).toBe(404); } finally { await q(`DELETE FROM feature_flags WHERE key='ads'`); }
  });
});
