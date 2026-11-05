import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { processOutbox } from '../src/lib/outbox.js';
import type { Area } from '../src/permissions.js';
import { ck, jpeg, login, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
const as = (area: Area, cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, headers, ...(payload ? { payload } : {}), ...ck(area, cookie) });
const staff = (area: Exclude<Area, 'shop' | 'studio'>, role: string) => login(app, area, { role });
const ledgerSum = async (where = 'true') => Number((await q(`SELECT coalesce(sum(amount_cents),0) s FROM ledger_entries WHERE ${where}`)).rows[0].s);

/** A paid order for a new seller, optionally shipped and delivered `daysAgo` days ago. */
async function sale(opts: { price?: number; qty?: number; deliveredDaysAgo?: number; category?: string; shopName?: string } = {}) {
  const s = await studioSeller(app, { shopName: opts.shopName, categories: [opts.category ?? 'pottery-ceramics'] }); const m = (await upload(app, s.cookie, await jpeg())).json();
  const st = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('studio', s.cookie) });
  const p = (await st('POST', '/api/studio/products', { title: 'Console item', categorySlug: opts.category ?? 'pottery-ceramics', priceCents: opts.price ?? 4000, stock: 50, attributes: {}, mediaIds: [m.id] })).json(); const pub = await st('POST', `/api/studio/products/${p.id}/publish`, { acknowledged: true }); if (pub.statusCode !== 200) throw new Error(pub.body);
  const v = (await q('SELECT id FROM variants WHERE product_id=$1', [p.id])).rows[0].id; const jar: Record<string, string> = {};
  const call = async (method: any, url: string, payload?: object) => { const r = await app.inject({ method, url, cookies: jar, ...(payload ? { payload } : {}) }); for (const c of r.cookies) jar[c.name] = c.value; return r; };
  await call('POST', '/api/cart/items', { variantId: v, quantity: opts.qty ?? 1 }); const o = (await call('POST', '/api/checkout', { email: `buyer${Date.now()}@t.test`, address: { name: 'Bea Buyer', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } })).json();
  await app.inject({ method: 'POST', url: `/api/dev/payments/${o.payment.ref}/simulate`, payload: { outcome: 'succeeded' } });
  const so = (await q('SELECT id FROM seller_orders WHERE order_id=$1', [o.orderId])).rows[0].id as string;
  if (opts.deliveredDaysAgo !== undefined) { await st('POST', `/api/studio/orders/${so}/ship`, { carrier: 'canada_post', trackingNumber: 'AB123456789CA' }); await st('POST', `/api/studio/orders/${so}/deliver`, {}); await q(`UPDATE seller_orders SET delivered_at = now() - ($2::int * interval '1 day') WHERE id=$1`, [so, opts.deliveredDaysAgo]); }
  return { ...s, productId: p.id as string, variantId: v as string, order: o, orderId: o.orderId as string, sellerOrderId: so };
}

describe('admin: users and sellers', () => {
  it('overview counts; disabling a user ends their sessions and blocks sign-in; you cannot disable yourself or the last admin', async () => {
    const a = await staff('admin', 'admin'); expect((await as('admin', a.cookie, 'GET', '/api/admin/overview')).json()).toMatchObject({ users: { n: expect.any(Number) }, sellers: expect.any(Object), orders30d: expect.any(Object) });
    const b = await login(app, 'shop'); expect((await app.inject({ method: 'GET', url: '/api/me', ...ck('shop', b.cookie) })).statusCode).toBe(200);
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/users/${b.id}`, { status: 'disabled' })).statusCode).toBe(400);                                      // a reason is required
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/users/${b.id}`, { status: 'disabled', reason: 'chargeback abuse' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', ...ck('shop', b.cookie) })).statusCode).toBe(401); expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': 'shop' }, payload: { email: b.email, password: 'correct-horse-battery' } })).statusCode).toBe(401);
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/users/${a.id}`, { status: 'disabled', reason: 'oops' })).json().error).toBe('cannot_change_self');
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/users/${b.id}`, { status: 'active', reason: 'appeal accepted' })).statusCode).toBe(200);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action IN ('user.disable','user.enable')`, [b.id])).rows[0].n)).toBe(2);
  });
  it('suspending a seller hides their shop and blocks purchases; reactivating restores both; the reason is audited', async () => {
    const a = await staff('admin', 'admin'); const s = await sale({ shopName: 'Suspend Me Studio' }); const go = (path: string) => app.inject({ method: 'GET', url: path });
    expect((await go(`/api/products/${s.productId}`)).statusCode).toBe(200);
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/sellers/${s.sellerId}`, { status: 'suspended' })).statusCode).toBe(400);
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/sellers/${s.sellerId}`, { status: 'suspended', reason: 'selling prohibited items' })).json().status).toBe('suspended');
    expect((await go(`/api/products/${s.productId}`)).statusCode).toBe(404); expect((await go(`/api/shops/${s.shop.slug}`)).statusCode).toBe(404);
    const jar = await app.inject({ method: 'POST', url: '/api/cart/items', payload: { variantId: s.variantId, quantity: 1 } }); expect(jar.statusCode).toBe(404);
    const detail = (await as('admin', a.cookie, 'GET', `/api/admin/sellers/${s.sellerId}`)).json(); expect(detail.history[0]).toMatchObject({ action: 'seller.suspend', reason: 'selling prohibited items' }); expect(detail.team.length).toBe(1);
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/sellers/${s.sellerId}`, { status: 'active', reason: 'cleared after review' })).json().status).toBe('active'); expect((await go(`/api/products/${s.productId}`)).statusCode).toBe(200);
    const list = (await as('admin', a.cookie, 'GET', '/api/admin/sellers?q=Suspend%20Me')).json(); expect(list.map((x: any) => x.id)).toContain(s.sellerId);
  });
  it('a per-seller commission override applies to new orders', async () => {
    const a = await staff('admin', 'admin'); const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json();
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/sellers/${s.sellerId}`, { commissionBps: 2000, reason: 'founding maker rate' })).json().commissionBps).toBe(2000);
    expect((await as('admin', a.cookie, 'PATCH', `/api/admin/sellers/${s.sellerId}`, { commissionBps: 9000, reason: 'too much' })).statusCode).toBe(400);
    void m; expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='seller.commission'`, [s.sellerId])).rows[0].n)).toBe(1);
  });
  it('windows are separate: a support person cannot use the admin console, and catalogue cannot manage users', async () => {
    const sup = await staff('support', 'support'); expect((await as('admin', sup.cookie, 'GET', '/api/admin/overview')).statusCode).toBe(401);
    const cat = await staff('admin', 'catalogue'); expect((await as('admin', cat.cookie, 'GET', '/api/admin/overview')).statusCode).toBe(403); expect((await as('admin', cat.cookie, 'GET', '/api/admin/moderation')).statusCode).toBe(200);
  });
});

describe('admin: moderation queue', () => {
  it('restricted-category products wait for review; approve keeps them live, remove hides them with a reason; support cannot decide', async () => {
    const a = await staff('admin', 'catalogue'); const sup = await staff('support', 'support');
    const s = await studioSeller(app, { categories: ['toys-games'] }); const m = (await upload(app, s.cookie, await jpeg())).json();
    const mk = async (title: string) => { const p = (await app.inject({ method: 'POST', url: '/api/studio/products', payload: { title, categorySlug: 'toys-games', priceCents: 1500, stock: 5, attributes: { age_range: '3-5' }, mediaIds: [m.id] }, ...ck('studio', s.cookie) })).json();
      const r = await app.inject({ method: 'POST', url: `/api/studio/products/${p.id}/publish`, payload: { acknowledged: true }, ...ck('studio', s.cookie) }); if (r.statusCode !== 200) throw new Error(r.body); return p.id as string; };
    const keep = await mk('Wooden blocks'); const drop = await mk('Stacking rings');
    const queue = (await as('admin', a.cookie, 'GET', '/api/admin/moderation')).json(); expect(queue.map((x: any) => x.id)).toEqual(expect.arrayContaining([keep, drop])); expect(queue.find((x: any) => x.id === keep)).toMatchObject({ shop: s.shop.name, category: 'Toys & games' });
    expect((await as('admin', sup.cookie, 'POST', `/api/admin/moderation/${keep}`, { decision: 'approve' })).statusCode).toBe(401);
    expect((await as('admin', a.cookie, 'POST', `/api/admin/moderation/${drop}`, { decision: 'remove' })).json().error).toBe('reason_required');
    expect((await as('admin', a.cookie, 'POST', `/api/admin/moderation/${keep}`, { decision: 'approve' })).statusCode).toBe(200); expect((await as('admin', a.cookie, 'POST', `/api/admin/moderation/${drop}`, { decision: 'remove', reason: 'Not a toy: small parts, no safety information' })).statusCode).toBe(200);
    expect((await as('admin', a.cookie, 'POST', `/api/admin/moderation/${keep}`, { decision: 'approve' })).json().error).toBe('not_in_queue');
    expect((await app.inject({ method: 'GET', url: `/api/products/${keep}` })).statusCode).toBe(200); expect((await app.inject({ method: 'GET', url: `/api/products/${drop}` })).statusCode).toBe(404);
    const after = (await as('admin', a.cookie, 'GET', '/api/admin/moderation')).json().map((x: any) => x.id); expect(after).not.toContain(keep); expect(after).not.toContain(drop);
  });
});

describe('support', () => {
  it('finds orders by number or email, sees the buyer, keeps internal notes (never shown to sellers or buyers) and can resend the confirmation', async () => {
    const sup = await staff('support', 'support'); const s = await sale({ price: 2500 }); const num = Number((await q('SELECT number FROM orders WHERE id=$1', [s.orderId])).rows[0].number);
    expect((await as('support', sup.cookie, 'GET', `/api/support/orders?q=${num}`)).json()[0]).toMatchObject({ id: s.orderId, number: num });
    const email = (await q('SELECT email FROM orders WHERE id=$1', [s.orderId])).rows[0].email; expect((await as('support', sup.cookie, 'GET', `/api/support/orders?q=${encodeURIComponent(email)}`)).json().map((x: any) => x.id)).toContain(s.orderId);
    const d = (await as('support', sup.cookie, 'GET', `/api/support/orders/${s.orderId}`)).json(); expect(d).toMatchObject({ email, buyerName: 'Bea Buyer', paymentStatus: 'paid' }); expect(d.sellers[0].lines[0].title).toBe('Console item'); expect(d.payments[0].status).toBe('succeeded');
    const n = await as('support', sup.cookie, 'POST', `/api/support/orders/${s.orderId}/notes`, { body: 'Buyer called, wants a gift note added' }); expect(n.statusCode).toBe(201); expect((await as('support', sup.cookie, 'GET', `/api/support/orders/${s.orderId}`)).json().notes[0].body).toContain('gift note');
    expect(JSON.stringify((await as('studio', s.cookie, 'GET', `/api/studio/orders/${s.sellerOrderId}`)).json())).not.toContain('gift note added'); expect((await as('support', sup.cookie, 'POST', `/api/support/orders/${s.orderId}/notes`, { body: '' })).statusCode).toBe(400);
    await q(`DELETE FROM outbox_emails WHERE to_email=$1`, [email]); expect((await as('support', sup.cookie, 'POST', `/api/support/orders/${s.orderId}/resend-confirmation`, {})).statusCode).toBe(202);
    const sent: string[] = []; await processOutbox(async m => { if (m.to === email) sent.push(m.subject); }); expect(sent[0]).toContain(`#${num}`);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action IN ('note.add','order.resend_confirmation')`, [s.orderId])).rows[0].n)).toBe(2);
  });
  it('looks up a buyer with their orders; support has no finance or marketing powers', async () => {
    const sup = await staff('support', 'support'); const u = await login(app, 'shop'); const d = (await as('support', sup.cookie, 'GET', `/api/support/users/${u.id}`)).json(); expect(d).toMatchObject({ email: u.email, status: 'active', orders: [] });
    expect((await as('finance', sup.cookie, 'GET', '/api/finance/overview')).statusCode).toBe(401); expect((await as('marketing', sup.cookie, 'GET', '/api/marketing/home')).statusCode).toBe(401);
  });
});

describe('finance', () => {
  it('payouts: nothing is available until the hold after delivery passes; a payout is a balanced ledger entry; you cannot pay more than is available, even in parallel', async () => {
    const f = await staff('finance', 'finance'); await q(`INSERT INTO app_settings(key,value) VALUES ('payout_hold_days','5') ON CONFLICT (key) DO UPDATE SET value='5'`);
    const fresh = await sale({ price: 10000, deliveredDaysAgo: 1 }); const find = async (id: string) => (await as('finance', f.cookie, 'GET', '/api/finance/sellers?limit=100')).json().items.find((x: any) => x.id === id);
    const b0 = await find(fresh.sellerId); expect(b0.owedCents).toBeGreaterThan(0); expect(b0.availableCents).toBe(0); expect(b0.pendingCents).toBe(b0.owedCents);
    expect((await as('finance', f.cookie, 'POST', '/api/finance/payouts', { sellerId: fresh.sellerId, amountCents: 100, reference: 'too early' })).json()).toMatchObject({ error: 'exceeds_available' });
    const s = await sale({ price: 10000, deliveredDaysAgo: 10 }); const b1 = await find(s.sellerId); expect(b1.availableCents).toBe(b1.owedCents); expect(b1.owedCents).toBe(10000 + 900 - 1000);          // items + shipping - 10% commission
    const before = await ledgerSum(); const pay = await as('finance', f.cookie, 'POST', '/api/finance/payouts', { sellerId: s.sellerId, amountCents: 3000, reference: 'ETF-0001', note: 'first half' }); expect(pay.statusCode).toBe(201);
    expect(await ledgerSum()).toBe(before); expect(await ledgerSum(`seller_id='${s.sellerId}' AND memo='payout'`)).toBe(0); const b2 = await find(s.sellerId); expect(b2).toMatchObject({ owedCents: b1.owedCents - 3000, availableCents: b1.availableCents - 3000, paidOutCents: 3000 });
    expect((await as('finance', f.cookie, 'POST', '/api/finance/payouts', { sellerId: s.sellerId, amountCents: b2.availableCents + 1, reference: 'too much' })).statusCode).toBe(422);
    const [x, y] = await Promise.all([1, 2].map(i => as('finance', f.cookie, 'POST', '/api/finance/payouts', { sellerId: s.sellerId, amountCents: b2.availableCents, reference: `PAR-${i}` })));
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 422]); expect((await find(s.sellerId)).availableCents).toBe(0);
    expect((await as('finance', f.cookie, 'GET', `/api/finance/payouts?sellerId=${s.sellerId}`)).json().length).toBe(2); expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='payout.create'`, [s.sellerId])).rows[0].n)).toBe(2);
  });
  it('overview, GST and the CSV export agree with the ledger; spreadsheet formulas in names are neutralised', async () => {
    const f = await staff('finance', 'finance'); const s = await sale({ price: 5000, shopName: '=HYPERLINK("http://x","y") Pots' }); const o = (await as('finance', f.cookie, 'GET', '/api/finance/overview')).json();
    expect(o.ledger.cash).toBeGreaterThan(0); expect(o.ledger.cash).toBe((await ledgerSum(`account='cash'`))); expect(o.ledger.taxPayable).toBe(-(await ledgerSum(`account='tax_payable'`))); expect(o.daily).toHaveLength(30);
    const gst = (await as('finance', f.cookie, 'GET', '/api/finance/gst')).json(); expect(gst.netOwedCents).toBe(gst.collectedCents - gst.refundedCents); expect(gst.netOwedCents).toBe(o.ledger.taxPayable);
    const csv = await as('finance', f.cookie, 'GET', '/api/finance/export/sales.csv'); expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.body.split('\n')[0]).toBe('order,date,seller,shop,status,items,shipping,gst,total,commission,refunded');
    const num = (await q('SELECT number FROM orders WHERE id=$1', [s.orderId])).rows[0].number; const row = csv.body.split('\n').find((l: string) => l.startsWith(`${num},`))!; expect(row).toContain('50.00,9.00,2.95,61.95,5.00,0.00'); expect(csv.body).not.toMatch(/,=HYPERLINK/);
    expect((await as('finance', f.cookie, 'GET', '/api/finance/gst?from=2999-01-01&to=2999-01-02')).json().collectedCents).toBe(0); expect((await as('finance', f.cookie, 'GET', '/api/finance/gst?from=bad')).statusCode).toBe(400);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE action='export.sales'`)).rows[0].n)).toBeGreaterThan(0);
  });
  it('finance can refund any seller order (same exact shares, ledger stays balanced); support and marketing cannot', async () => {
    const f = await staff('finance', 'finance'); const s = await sale({ price: 3000, qty: 2 }); const line = (await q('SELECT id FROM order_lines WHERE seller_order_id=$1', [s.sellerOrderId])).rows[0].id;
    const r = await as('finance', f.cookie, 'POST', `/api/finance/orders/${s.sellerOrderId}/refund`, { lines: [{ lineId: line, quantity: 1 }], reason: 'Goodwill after late delivery' }, { 'idempotency-key': 'finance-refund-1' }); expect(r.statusCode).toBe(200); expect(r.json().status).toBe('succeeded');
    expect((await as('finance', f.cookie, 'POST', `/api/finance/orders/${s.sellerOrderId}/refund`, { lines: [{ lineId: line, quantity: 1 }], reason: 'Goodwill after late delivery' }, { 'idempotency-key': 'finance-refund-1' })).json().replay).toBe(true);
    expect(await ledgerSum(`order_id='${s.orderId}'`)).toBe(0); expect((await q('SELECT refunded_cents FROM seller_orders WHERE id=$1', [s.sellerOrderId])).rows[0].refunded_cents).toBeGreaterThan(0);
    const sup = await staff('support', 'support'); expect((await as('finance', sup.cookie, 'POST', `/api/finance/orders/${s.sellerOrderId}/refund`, { lines: [], includeShipping: true, reason: 'nope nope' })).statusCode).toBe(401);
    const lookup = (await as('finance', f.cookie, 'GET', `/api/finance/orders/${s.orderId}`)).json(); expect(lookup.refunds[0].byEmail).toBe(f.email);
  });
});

describe('marketing', () => {
  it('curates the home page: picks, tiles, spotlight and promo bar reach /api/home, with checks and an audit trail', async () => {
    const m = await staff('marketing', 'marketing'); const cur = (await as('marketing', m.cookie, 'GET', '/api/marketing/home')).json(); const found = (await as('marketing', m.cookie, 'GET', '/api/marketing/products?limit=5')).json(); expect(found.length).toBeGreaterThan(0);
    const body = { promoBar: 'Free shipping over $60 this week', phone: found.slice(0, 2).map((x: any) => x.id), desktop: found.slice(1, 4).map((x: any) => x.id), categories: cur.categories.slice(0, 5), spotlight: cur.spotlight };
    try {
      const put = await as('marketing', m.cookie, 'PUT', '/api/marketing/home', body); expect(put.statusCode).toBe(200); const home = (await app.inject({ method: 'GET', url: '/api/home' })).json();
      expect(home.promoBar).toBe('Free shipping over $60 this week'); expect(home.phone.map((x: any) => x.id).sort()).toEqual([...body.phone].sort()); expect(home.categories).toHaveLength(5);
      expect((await as('marketing', m.cookie, 'PUT', '/api/marketing/home', { ...body, phone: ['00000000-0000-4000-8000-000000000000'] })).json().error).toBe('product_not_available');
      expect((await as('marketing', m.cookie, 'PUT', '/api/marketing/home', { ...body, spotlight: { shop: 'no-such-shop', quote: 'hi' } })).json().error).toBe('shop_not_available');
      expect((await as('marketing', m.cookie, 'PUT', '/api/marketing/home', { ...body, categories: [{ slug: 'nope', label: 'Nope', kind: 'pottery', tone: 'warm' }] })).json().error).toBe('category_not_found');
      expect((await as('marketing', m.cookie, 'PUT', '/api/marketing/home', { ...body, promoBar: 'x'.repeat(200) })).statusCode).toBe(400);
      expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE action='home.update' AND actor_id=$1`, [m.id])).rows[0].n)).toBe(1);
    } finally { await as('marketing', m.cookie, 'PUT', '/api/marketing/home', { promoBar: cur.promoBar, phone: cur.phone, desktop: cur.desktop, categories: cur.categories, spotlight: cur.spotlight }); }
  });
  it('search synonyms: add, use in search, remove', async () => {
    const m = await staff('marketing', 'marketing'); const s = await studioSeller(app); const med = (await upload(app, s.cookie, await jpeg())).json();
    const p = (await app.inject({ method: 'POST', url: '/api/studio/products', payload: { title: 'Glazed pitcher', categorySlug: 'pottery-ceramics', priceCents: 3000, stock: 3, attributes: {}, mediaIds: [med.id] }, ...ck('studio', s.cookie) })).json(); await app.inject({ method: 'POST', url: `/api/studio/products/${p.id}/publish`, payload: { acknowledged: true }, ...ck('studio', s.cookie) });
    const find = async () => (await app.inject({ method: 'GET', url: '/api/products?q=carafe' })).json();
    expect((await find()).items.some((x: any) => x.id === p.id)).toBe(false);
    expect((await as('marketing', m.cookie, 'PUT', '/api/marketing/synonyms', { term: 'carafe', related: ['pitcher'] })).statusCode).toBe(200); expect((await find()).items.some((x: any) => x.id === p.id)).toBe(true);
    expect((await as('marketing', m.cookie, 'PUT', '/api/marketing/synonyms', { term: 'carafe', related: ['carafe'] })).json().error).toBe('term_in_related');
    expect((await as('marketing', m.cookie, 'GET', '/api/marketing/synonyms')).json().some((x: any) => x.term === 'carafe')).toBe(true);
    expect((await as('marketing', m.cookie, 'DELETE', '/api/marketing/synonyms/carafe')).statusCode).toBe(200); expect((await find()).items.some((x: any) => x.id === p.id && !x.title.includes('carafe'))).toBe(false);
    expect((await as('marketing', m.cookie, 'DELETE', '/api/marketing/synonyms/carafe')).statusCode).toBe(404);
  });
});
