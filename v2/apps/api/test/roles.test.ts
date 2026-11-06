import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { loadRoleConfig } from '../src/lib/roleConfig.js';
import { ck, jpeg, login, makeUser, PW, studioSeller, upload, cookieOf } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 1_000_000 }); });
afterAll(async () => { await app.close(); await pool.end(); });
afterEach(async () => { await q('DELETE FROM role_config'); await loadRoleConfig(); });

const put = (cookie: string, role: string, payload: object) => app.inject({ method: 'PUT', url: `/api/admin/roles/${role}`, payload, ...ck('admin', cookie) });
const view = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/admin/roles', ...ck('admin', cookie) })).json();

describe('admin edits what each role may do', () => {
  it('lists every role in plain words; admin and the maker owner are locked; only admin can see or change this', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const v = await view(admin.cookie); const by = (r: string) => v.roles.find((x: any) => x.role === r);
    expect(v.roles.map((r: any) => r.role)).toEqual(['admin', 'support', 'finance', 'catalogue', 'marketing', 'seller_owner', 'seller_manager', 'seller_staff']);
    expect(by('admin').editable).toBe(false); expect(by('seller_owner').editable).toBe(false); expect(by('finance').editable).toBe(true);
    expect(by('finance').permissions.find((p: any) => p.key === 'refunds.write')).toMatchObject({ on: true, label: 'Issue refunds', group: 'Orders and money', locked: false });
    expect(by('finance').permissions.find((p: any) => p.key === 'roles.manage')).toMatchObject({ on: false, locked: true });
    expect(by('finance').areas.filter((a: any) => a.on).map((a: any) => a.area)).toEqual(['finance']);
    const support = await login(app, 'support', { role: 'support' }); expect((await app.inject({ method: 'GET', url: '/api/admin/roles', ...ck('support', support.cookie) })).statusCode).toBe(401);
  });
  it('removing a permission takes effect at once, and resetting restores the default; every change is audited', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const mkt = await login(app, 'marketing', { role: 'marketing' }); const ads = () => app.inject({ method: 'GET', url: '/api/marketing/ads', ...ck('marketing', mkt.cookie) });
    expect((await ads()).statusCode).toBe(200);
    expect((await put(admin.cookie, 'marketing', { permissions: [], areas: ['marketing'], reason: 'pause marketing' })).statusCode).toBe(200); expect((await ads()).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/roles/marketing', ...ck('admin', admin.cookie) })).statusCode).toBe(200); expect((await ads()).statusCode).toBe(200);
    const rows = (await q(`SELECT action FROM audit_log WHERE entity_type='role' AND entity_id='marketing' ORDER BY id`)).rows.map(r => r.action); expect(rows).toEqual(['role.configure', 'role.reset']);
  });
  it('changing which consoles a role may enter decides who can sign in where', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const u = await makeUser(app, { role: 'support' }); const signIn = (area: string) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': area }, payload: { email: u.email, password: PW } });
    expect((await signIn('finance')).statusCode).toBe(403);
    await put(admin.cookie, 'support', { permissions: ['users.read', 'audit.read', 'orders.read', 'sellers.read', 'support.write'], areas: ['support', 'finance'] }); const r = await signIn('finance'); expect(r.statusCode).toBe(200); expect(cookieOf(r, 'finance')).toBeTruthy();
    await put(admin.cookie, 'support', { permissions: [], areas: [] }); expect((await signIn('support')).statusCode).toBe(403);
  });
  it('refuses to hand out admin-only powers, to edit admin or the maker owner, or to invent permissions; locks nobody out', async () => {
    const admin = await login(app, 'admin', { role: 'admin' });
    expect((await put(admin.cookie, 'finance', { permissions: ['roles.manage'], areas: ['finance'] })).statusCode).toBe(422); expect((await put(admin.cookie, 'finance', { permissions: ['everything'], areas: ['finance'] })).statusCode).toBe(422);
    expect((await put(admin.cookie, 'admin', { permissions: [], areas: [] })).statusCode).toBe(403); expect((await put(admin.cookie, 'seller_owner', { permissions: [], areas: [] })).statusCode).toBe(403);
    expect((await put(admin.cookie, 'seller_manager', { permissions: ['seller.staff.manage'] })).statusCode).toBe(422);
    await put(admin.cookie, 'finance', { permissions: [], areas: [] }); const still = await view(admin.cookie); expect(still.roles.find((r: any) => r.role === 'admin').areas.every((a: any) => a.on)).toBe(true);
  });
  it('maker team roles are editable too: a manager loses product editing when the admin turns it off', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const owner = await studioSeller(app); const mgr = await login(app, 'studio', { role: 'seller_manager', sellerId: owner.sellerId }); const m = (await upload(app, owner.cookie, await jpeg())).json();
    const create = () => app.inject({ method: 'POST', url: '/api/studio/products', payload: { title: 'Manager mug', categorySlug: 'pottery-ceramics', priceCents: 1500, stock: 3, attributes: {}, mediaIds: [m.id] }, ...ck('studio', mgr.cookie) });
    expect((await create()).statusCode).toBe(201);
    await put(admin.cookie, 'seller_manager', { permissions: ['seller.shop.write', 'seller.products.read', 'seller.orders.read'] }); expect((await create()).statusCode).toBe(403);
  });
});
