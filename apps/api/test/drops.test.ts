import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { notifyWaitlists } from '../src/modules/drops.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie?: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookie ? ck(cookie) : {}) });
const wl = (slug: string, pid: string, body: object = {}, cookie?: string) => call('POST', `/api/public/stores/${slug}/products/${pid}/waitlist`, cookie, body);
const mails = async (to: string, template: string) => (await oq(`SELECT 1 FROM email_outbox WHERE to_email=$1 AND template=$2`, [to, template])).rowCount!;
async function customer(n: string) { const r = await call('POST', '/api/auth/signup-customer', undefined, { email: `${n}@drop.test`, password: 'correct-horse-battery', fullName: n }); return { cookie: r.cookies.find(c => c.name === 'eazy_sid')!.value, email: `${n}@drop.test` }; }
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe('waitlist for sold-out products', () => {
  it('only when it cannot be bought; idempotent; guests give an email, members use theirs; restock tells them once', async () => {
    const s = await k.seller('dr1'); const p = await k.product(s.cookie, { variants: [{ title: 'A', priceCents: 2000, stock: 2 }] });
    expect((await wl(s.slug, p.id, { email: 'a@drop.test' })).json().error).toBe('available_now');
    await oq('UPDATE inventory_levels SET on_hand=0 WHERE variant_id=$1', [p.variantId]);
    expect((await wl(s.slug, p.id, {})).json().error).toBe('email_required'); expect((await wl(s.slug, p.id, { email: 'nope' })).statusCode).toBe(400);
    expect((await wl(s.slug, p.id, { email: 'A@Drop.test' })).statusCode).toBe(201);
    const again = await wl(s.slug, p.id, { email: 'a@drop.test' }); expect(again.statusCode).toBe(200); expect(again.json().already).toBe(true);
    const m = await customer('dr1m'); expect((await wl(s.slug, p.id, {}, m.cookie)).json()).toMatchObject({ joined: true, kind: 'restock' });
    const draft = await k.product(s.cookie, { name: 'Hidden', status: 'draft' }); expect((await wl(s.slug, draft.id, { email: 'a@drop.test' })).statusCode).toBe(404);
    const dem = (await call('GET', '/api/seller/demand', s.cookie)).json(); expect(dem.products[0]).toMatchObject({ name: 'Stand', waiting: 2, available: 0 });
    expect((await call('POST', `/api/seller/variants/${p.variantId}/stock`, s.cookie, { delta: 5 })).statusCode).toBe(200);          // restock
    expect(await mails('a@drop.test', 'back_in_stock')).toBe(1); expect(await mails(m.email, 'back_in_stock')).toBe(1);
    await call('POST', `/api/seller/variants/${p.variantId}/stock`, s.cookie, { delta: 1 }); await notifyWaitlists();
    expect(await mails('a@drop.test', 'back_in_stock')).toBe(1);                                                                      // never twice
    expect((await call('GET', '/api/seller/demand', s.cookie)).json().products[0]).toMatchObject({ waiting: 0, notified: 2 });
  });
});

describe('drops', () => {
  it('visible but not purchasable until the time; waitlist and followers hear once when it goes live', async () => {
    const s = await k.seller('dr2'); const p = await k.product(s.cookie); const f = await customer('dr2f'); const w = await customer('dr2w');
    expect((await call('PUT', `/api/account/follows/${s.slug}`, f.cookie)).json()).toEqual({ following: true }); await call('PUT', `/api/account/follows/${s.slug}`, w.cookie);
    expect((await call('PUT', `/api/seller/products/${p.id}/drop`, s.cookie, { availableFrom: '2020-01-01T00:00:00Z' })).json().error).toBe('drop_in_past');
    expect((await call('PUT', `/api/seller/products/${p.id}/drop`, s.cookie, { availableFrom: inHours(2) })).statusCode).toBe(200);
    const pub = (await call('GET', `/api/public/stores/${s.slug}/products/${p.id}`)).json(); expect(pub.comingSoon).toBe(true);
    expect((await call('GET', `/api/public/stores/${s.slug}/products`)).json()[0].comingSoon).toBe(true);
    expect((await k.checkout(s.slug, p.variantId)).json().error).toBe('not_released');
    expect((await call('POST', `/api/public/stores/${s.slug}/quote`, undefined, { items: [{ variantId: p.variantId, quantity: 1 }], fulfilment: 'pickup' })).json().error).toBe('not_released');
    expect((await wl(s.slug, p.id, {}, w.cookie)).json()).toMatchObject({ joined: true, kind: 'drop' });                             // in stock, but not yet released
    expect(await notifyWaitlists()).toMatchObject({ waitlist: 0 }); expect(await mails(w.email, 'drop_live')).toBe(0);                  // too early: nothing is sent
    await oq(`UPDATE products SET available_from = now() - interval '1 minute' WHERE id=$1`, [p.id]);                                   // the clock reaches the drop
    expect(await notifyWaitlists({ tenantId: s.tenantId })).toEqual({ waitlist: 1, followers: 1 });
    expect(await mails(w.email, 'drop_live')).toBe(1); expect(await mails(f.email, 'new_drop')).toBe(1); expect(await mails(w.email, 'new_drop')).toBe(0);   // no double email to someone already on the waitlist
    expect(await notifyWaitlists({ tenantId: s.tenantId })).toEqual({ waitlist: 0, followers: 0 });
    expect((await k.checkout(s.slug, p.variantId)).statusCode).toBe(201);
    expect((await call('GET', `/api/public/stores/${s.slug}/products/${p.id}`)).json().comingSoon).toBe(false);
  });
  it('a drop can be cancelled, and only managers schedule them; other stores cannot', async () => {
    const s = await k.seller('dr3'); const o = await k.seller('dr3x'); const p = await k.product(s.cookie);
    await call('PUT', `/api/seller/products/${p.id}/drop`, s.cookie, { availableFrom: inHours(5) });
    expect((await call('PUT', `/api/seller/products/${p.id}/drop`, o.cookie, { availableFrom: null })).statusCode).toBe(404);
    expect((await call('PUT', `/api/seller/products/${p.id}/drop`, s.cookie, { availableFrom: null })).statusCode).toBe(200);
    expect((await k.checkout(s.slug, p.variantId)).statusCode).toBe(201);
    expect((await call('GET', '/api/seller/demand', o.cookie)).json().products).toEqual([]);
    await oq(`UPDATE memberships SET role='staff' WHERE tenant_id=$1`, [s.tenantId]); expect((await call('GET', '/api/seller/demand', s.cookie)).statusCode).toBe(403);
  });
});

describe('following makers', () => {
  it('follow, list, unfollow; guests are asked to sign in; unpublished or unknown stores cannot be followed', async () => {
    const s = await k.seller('dr4'); const c = await customer('dr4c');
    expect((await call('PUT', `/api/account/follows/${s.slug}`)).statusCode).toBe(401);
    expect((await call('GET', `/api/public/stores/${s.slug}/following`)).json()).toEqual({ following: false, signedIn: false });
    await call('PUT', `/api/account/follows/${s.slug}`, c.cookie);
    expect((await call('GET', `/api/public/stores/${s.slug}/following`, c.cookie)).json()).toEqual({ following: true, signedIn: true });
    expect((await call('GET', '/api/account/follows', c.cookie)).json()).toEqual([expect.objectContaining({ slug: s.slug })]);
    expect((await call('GET', '/api/seller/demand', s.cookie)).json().followers).toBe(1);
    await call('DELETE', `/api/account/follows/${s.slug}`, c.cookie); expect((await call('GET', '/api/account/follows', c.cookie)).json()).toEqual([]);
    expect((await call('PUT', '/api/account/follows/no-such-store', c.cookie)).statusCode).toBe(404);
  });
});
