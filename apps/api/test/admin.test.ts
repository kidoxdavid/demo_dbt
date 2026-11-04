import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

async function staff(n: string, role: string) {
  const s = await k.seller(n);
  const id = (await oq('SELECT id FROM users WHERE email=$1', [`${n}@k.test`])).rows[0].id;
  await oq('INSERT INTO platform_staff(user_id,role_key) VALUES ($1,$2)', [id, role]);
  return s.cookie;
}
const get = (cookie: string | undefined, url: string) => app.inject({ method: 'GET', url, ...(cookie ? ck(cookie) : {}) });
const put = (cookie: string, url: string, payload: object) => app.inject({ method: 'PUT', url, ...ck(cookie), payload });

describe('admin identity and overview', () => {
  it('/api/admin/me reports role and permissions; non-staff and anonymous are refused', async () => {
    const mod = await staff('ad1', 'moderator'); const plain = await k.seller('ad2');
    expect((await get(mod, '/api/admin/me')).json()).toMatchObject({ role: 'moderator', permissions: ['reviews.write', 'sellers.read', 'sellers.suspend'] });
    expect((await get(plain.cookie, '/api/admin/me')).statusCode).toBe(403);
    expect((await get(undefined, '/api/admin/me')).statusCode).toBe(401);
    expect((await get(plain.cookie, '/api/admin/overview')).statusCode).toBe(403);
  });
  it('overview totals reflect real orders, fees and refunds', async () => {
    const adm = await staff('ad3', 'super_admin'); const before = (await get(adm, '/api/admin/overview')).json();
    const s = await k.seller('ad4'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 2); // 4000, fee 120
    await app.inject({ method: 'POST', url: `/api/seller/orders/${o.orderId}/refunds`, ...ck(s.cookie), payload: { amountCents: 1000, reason: 'Goodwill refund' } });
    const after = (await get(adm, '/api/admin/overview')).json();
    expect(after.paidOrders - before.paidOrders).toBe(1); expect(after.gmvCents - before.gmvCents).toBe(4000);
    expect(after.platformFeesCents - before.platformFeesCents).toBe(120 - 30); expect(after.refundsCents - before.refundsCents).toBe(1000);
    expect(after.sellers.total).toBeGreaterThan(before.sellers.total);
  });
  it('sellers list supports search and shows the owner, active products and paid orders', async () => {
    const adm = await staff('ad5', 'support'); const s = await k.seller('zzfindme'); const p = await k.product(s.cookie); await k.paidOrder(s, p.variantId, 1);
    const r = (await get(adm, '/api/admin/sellers?q=zzfindme')).json();
    expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ slug: 'zzfindme-shop', owner_email: 'zzfindme@k.test', active_products: 1, paid_orders: 1 });
    expect((await get(adm, '/api/admin/sellers?q=%25')).json()).toEqual([]); // wildcard is literal
  });
  it('lists plans for any staff member', async () => {
    const sup = await staff('ad6', 'support');
    expect((await get(sup, '/api/admin/plans')).json().map((p: any) => p.code)).toEqual(['starter', 'growth', 'professional', 'enterprise']);
  });
});

describe('featured maker', () => {
  it('needs settings.write and a reason; only publishable stores; is audited; leads the marketplace; can be cleared', async () => {
    const adm = await staff('ad7', 'super_admin'); const mod = await staff('ad8', 'moderator');
    const a = await k.seller('feat-a', { category: 'FeatCat' }); await k.product(a.cookie, { name: 'A item' });
    const b = await k.seller('feat-b', { category: 'FeatCat' }); await k.product(b.cookie, { name: 'B item' });
    const un = await k.seller('feat-c', { category: 'FeatCat' }); // no products -> not eligible to lead
    expect((await put(mod, '/api/admin/featured', { slug: 'feat-a-shop', reason: 'Editors pick' })).statusCode).toBe(403);
    expect((await put(adm, '/api/admin/featured', { slug: 'feat-a-shop' })).statusCode).toBe(400);
    expect((await put(adm, '/api/admin/featured', { slug: 'does-not-exist', reason: 'Editors pick' })).statusCode).toBe(422);
    void un;
    const home = async () => (await app.inject({ method: 'GET', url: '/api/public/marketplace' })).json().stores[0].slug;
    expect(await home()).toBe('feat-b-shop');                              // newest published store with products leads by default
    expect((await put(adm, '/api/admin/featured', { slug: 'feat-a-shop', reason: 'Editors pick for November' })).json()).toEqual({ slug: 'feat-a-shop' });
    expect(await home()).toBe('feat-a-shop');
    expect((await get(adm, '/api/admin/featured')).json()).toEqual({ slug: 'feat-a-shop' });
    const log = (await oq(`SELECT * FROM audit_logs WHERE action='marketplace.featured' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log.reason).toBe('Editors pick for November'); expect(log.new_value).toEqual({ slug: 'feat-a-shop' });
    // a suspended featured store silently stops leading
    await oq(`UPDATE tenants SET status='suspended' WHERE id=$1`, [a.tenantId]); await oq(`UPDATE stores SET status='suspended' WHERE tenant_id=$1`, [a.tenantId]);
    expect(await home()).not.toBe('feat-a-shop');
    expect((await put(adm, '/api/admin/featured', { slug: null, reason: 'Clearing the feature' })).json()).toEqual({ slug: null });
    expect((await get(adm, '/api/admin/featured')).json()).toEqual({ slug: null });
  });
  it('filtered marketplace views are not affected by the featured pick', async () => {
    const adm = await staff('ad9', 'super_admin'); const x = await k.seller('feat-x', { category: 'OnlyHere' }); await k.product(x.cookie);
    const y = await k.seller('feat-y', { category: 'Elsewhere' }); await k.product(y.cookie);
    await put(adm, '/api/admin/featured', { slug: 'feat-y-shop', reason: 'Editors pick again' });
    const r = (await app.inject({ method: 'GET', url: '/api/public/marketplace?category=OnlyHere' })).json();
    expect(r.stores.map((s: any) => s.slug)).toEqual(['feat-x-shop']);
  });
});
