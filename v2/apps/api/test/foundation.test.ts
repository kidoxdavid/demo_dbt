import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { sha256 } from '../src/security.js';
import { canForSeller } from '../src/permissions.js';
import { PW, ck, cookieOf, login, makeUser } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, opts: { area?: any; cookie?: string; payload?: object; headers?: Record<string, string> } = {}) =>
  app.inject({ method, url, ...(opts.payload ? { payload: opts.payload } : {}), headers: opts.headers, ...(opts.cookie ? ck(opts.area ?? 'shop', opts.cookie) : {}) });

describe('migrations and the audit trail', () => {
  it('apply once, are recorded, and running them again changes nothing', async () => {
    const before = (await q('SELECT count(*)::int n FROM schema_migrations')).rows[0].n; await runMigrations();
    expect((await q('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(before); expect(before).toBeGreaterThanOrEqual(2);
    expect((await q('SELECT count(*)::int n FROM categories WHERE slug IN (\'toys-games\',\'art-prints\',\'3d-printing\',\'perfume-fragrance\',\'hair-wigs\',\'pottery-ceramics\',\'jewellery\',\'candles-home-fragrance\',\'home-decor\',\'clothing-accessories\',\'stationery-paper\',\'plants-planters\',\'other\')')).rows[0].n).toBe(13);
  });
  it('the audit log cannot be edited or deleted', async () => {
    await q(`INSERT INTO audit_log(action,entity_type) VALUES ('test','test')`);
    await expect(q(`UPDATE audit_log SET action='x'`)).rejects.toThrow(/append-only/); await expect(q('DELETE FROM audit_log')).rejects.toThrow(/append-only/); await expect(q('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });
});

describe('sign-up and sessions', () => {
  it('creates a buyer, sets a hardened cookie, and stores only a hash of the token', async () => {
    const r = await call('POST', '/api/auth/signup', { payload: { email: 'Maya@Example.TEST', password: PW, fullName: 'Maya' } }); expect(r.statusCode).toBe(201);
    const c = r.cookies.find(x => x.name === 'es_shop')!; expect(c.httpOnly).toBe(true); expect(String(c.sameSite).toLowerCase()).toBe('lax'); expect(c.path).toBe('/');
    expect(r.json().user).toMatchObject({ email: 'maya@example.test', roles: [] });
    expect((await q('SELECT 1 FROM sessions WHERE token_hash=$1', [sha256(c.value)])).rowCount).toBe(1); expect((await q('SELECT 1 FROM sessions WHERE token_hash=$1', [c.value])).rowCount).toBe(0);
    expect((await call('GET', '/api/me', { cookie: c.value })).json()).toMatchObject({ email: 'maya@example.test', area: 'shop' });
    expect((await q('SELECT password_hash FROM users WHERE email=$1', ['maya@example.test'])).rows[0].password_hash).toMatch(/^scrypt\$/);
  });
  it('refuses weak passwords, duplicate emails and unknown fields', async () => {
    for (const [pw, why] of [['short', 'too_short'], ['password1234', 'too_common'], ['zzzzzzzzzzzz', 'too_common'], ['dana.smith-2026', 'contains_email']] as const)
      expect((await call('POST', '/api/auth/signup', { payload: { email: 'dana.smith@x.test', password: pw, fullName: 'D' } })).json().error).toBe(`weak_password:${why}`);
    expect((await call('POST', '/api/auth/signup', { payload: { email: 'maya@example.test', password: PW, fullName: 'M' } })).json().error).toBe('email_in_use');
    expect((await call('POST', '/api/auth/signup', { payload: { email: 'e@x.test', password: PW, fullName: 'E', isAdmin: true } })).statusCode).toBe(400);
  });
  it('wrong password and unknown email look the same; five failures lock the account; success clears the count', async () => {
    const u = await makeUser(app); const bad = (e: string) => call('POST', '/api/auth/login', { payload: { email: e, password: 'wrong-wrong-wrong' } });
    expect((await bad(u.email)).json().error).toBe('invalid_credentials'); expect((await bad('nobody@x.test')).json().error).toBe('invalid_credentials');
    for (let i = 0; i < 4; i++) await bad(u.email);
    expect((await call('POST', '/api/auth/login', { payload: { email: u.email, password: PW } })).json().error).toBe('account_temporarily_locked');
    await q(`UPDATE users SET locked_until=NULL WHERE id=$1`, [u.id]);
    expect((await call('POST', '/api/auth/login', { payload: { email: u.email, password: PW } })).statusCode).toBe(200); expect((await q('SELECT failed_logins FROM users WHERE id=$1', [u.id])).rows[0].failed_logins).toBe(0);
  });
  it('logout ends the session; expired sessions and disabled users are refused', async () => {
    const s = await login(app, 'shop'); expect((await call('GET', '/api/me', { cookie: s.cookie })).statusCode).toBe(200);
    await call('POST', '/api/auth/logout', { cookie: s.cookie }); expect((await call('GET', '/api/me', { cookie: s.cookie })).statusCode).toBe(401);
    const e = await login(app, 'shop'); await q(`UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1`, [sha256(e.cookie)]); expect((await call('GET', '/api/me', { cookie: e.cookie })).statusCode).toBe(401);
    const d = await login(app, 'shop'); await q(`UPDATE users SET status='disabled' WHERE id=$1`, [d.id]); expect((await call('GET', '/api/me', { cookie: d.cookie })).statusCode).toBe(401);
  });
  it('blocks cross-origin writes, allows same-host and listed origins, and rate-limits sign-in', async () => {
    const p = { email: 'x@x.test', password: PW };
    expect((await call('POST', '/api/auth/login', { payload: p, headers: { origin: 'https://evil.example', host: 'api.local' } })).json().error).toBe('cross_origin_blocked');
    expect((await call('POST', '/api/auth/login', { payload: p, headers: { origin: 'http://api.local', host: 'api.local' } })).statusCode).not.toBe(403);
    expect((await call('POST', '/api/auth/login', { payload: p, headers: { origin: 'http://localhost:5180' } })).statusCode).not.toBe(403);
    const limited = await buildApp({ authRateLimitMax: 3 }); const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@x.test', password: 'whatever-whatever' } })).statusCode); await limited.close();
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]); expect(codes.slice(3)).toEqual([429, 429]);
  });
});

describe('independent windows and roles', () => {
  it('people only enter windows they belong to, and each window has its own session', async () => {
    const staff = await makeUser(app, { role: 'admin' }); const buyer = await makeUser(app);
    const into = (email: string, area: string) => call('POST', '/api/auth/login', { payload: { email, password: PW }, headers: { 'x-area': area } });
    expect((await into(buyer.email, 'admin')).json().error).toBe('not_allowed_in_area'); expect((await into(buyer.email, 'studio')).statusCode).toBe(403); expect((await into(staff.email, 'studio')).statusCode).toBe(403);
    const a = await into(staff.email, 'admin'); expect(a.statusCode).toBe(200); const sh = await into(staff.email, 'shop'); expect(sh.statusCode).toBe(200);
    expect((await call('GET', '/api/admin/me', { area: 'admin', cookie: cookieOf(a, 'admin') })).json()).toMatchObject({ area: 'admin', roles: [{ role: 'admin' }] });
    expect((await call('GET', '/api/me', { area: 'shop', cookie: cookieOf(sh, 'shop') })).json().roles).toEqual([]);          // the shop window carries no staff power
    await call('POST', '/api/auth/logout', { area: 'admin', cookie: cookieOf(a, 'admin'), headers: { 'x-area': 'admin' } });
    expect((await call('GET', '/api/me', { area: 'shop', cookie: cookieOf(sh, 'shop') })).statusCode).toBe(200);              // signing out of one window leaves the other
  });
  it('a shop-window cookie cannot be replayed as an admin one, and the x-area header cannot upgrade a request', async () => {
    const staff = await login(app, 'shop', { role: 'admin' });
    expect((await call('GET', '/api/admin/settings', { area: 'admin', cookie: staff.cookie })).statusCode).toBe(401);                        // es_admin cookie holding a shop token
    expect((await call('GET', '/api/admin/settings', { area: 'shop', cookie: staff.cookie, headers: { 'x-area': 'admin' } })).statusCode).toBe(401);
  });
  it('permissions follow the role: support reads users but cannot manage roles; catalogue edits categories only', async () => {
    const support = await login(app, 'support', { role: 'support' }); const target = await makeUser(app);
    expect((await call('GET', '/api/support/users?q=u', { area: 'support', cookie: support.cookie })).statusCode).toBe(200);
    expect((await call('GET', '/api/support/audit', { area: 'support', cookie: support.cookie })).statusCode).toBe(200);
    expect((await call('POST', `/api/admin/users/${target.id}/roles`, { area: 'admin', cookie: support.cookie, payload: { role: 'support' } })).statusCode).toBe(401);   // wrong window entirely
    const cat = await login(app, 'admin', { role: 'catalogue' });
    expect((await call('POST', `/api/admin/users/${target.id}/roles`, { area: 'admin', cookie: cat.cookie, payload: { role: 'support' } })).json().error).toBe('forbidden');
    expect((await call('GET', '/api/admin/settings', { area: 'admin', cookie: cat.cookie })).json().error).toBe('forbidden');
    expect((await call('GET', '/api/admin/categories', { area: 'admin', cookie: cat.cookie })).statusCode).toBe(200);
  });
  it('admins grant and revoke roles with an audit entry; seller roles need a seller; the last admin stays', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const target = await makeUser(app); const roles = `/api/admin/users/${target.id}/roles`; const o = { area: 'admin' as const, cookie: admin.cookie };
    const g = await call('POST', roles, { ...o, payload: { role: 'marketing', reason: 'Joins the team' } }); expect(g.statusCode).toBe(201);
    expect((await call('POST', roles, { ...o, payload: { role: 'marketing' } })).json().error).toBe('role_exists');
    expect((await call('POST', roles, { ...o, payload: { role: 'seller_owner' } })).json().error).toBe('seller_id_required'); expect((await call('POST', roles, { ...o, payload: { role: 'finance', sellerId: '11111111-1111-4111-8111-111111111111' } })).json().error).toBe('seller_id_not_allowed');
    expect((await call('POST', roles, { ...o, payload: { role: 'seller_manager', sellerId: '22222222-2222-4222-8222-222222222222' } })).json().error).toBe('seller_not_found');
    const sellerId = (await q(`INSERT INTO sellers(legal_name) VALUES ('Role Test Seller') RETURNING id`)).rows[0].id; expect((await call('POST', roles, { ...o, payload: { role: 'seller_manager', sellerId } })).statusCode).toBe(201);
    expect((await q(`SELECT reason, next FROM audit_log WHERE action='role.grant' AND entity_id=$1 ORDER BY id`, [target.id])).rows[0]).toMatchObject({ reason: 'Joins the team', next: { role: 'marketing' } });
    expect((await call('DELETE', `${roles}/${g.json().id}`, o)).statusCode).toBe(200); expect((await q(`SELECT count(*)::int n FROM audit_log WHERE action='role.revoke' AND entity_id=$1`, [target.id])).rows[0].n).toBe(1);
    await q(`DELETE FROM user_roles WHERE role='admin' AND user_id<>$1`, [admin.id]); const mine = (await q(`SELECT id FROM user_roles WHERE user_id=$1 AND role='admin'`, [admin.id])).rows[0].id;
    expect((await call('DELETE', `/api/admin/users/${admin.id}/roles/${mine}`, o)).json().error).toBe('last_admin');
  });
  it('seller permissions only count for the seller they were granted on', () => {
    const s1 = '33333333-3333-4333-8333-333333333333', s2 = '44444444-4444-4444-8444-444444444444'; const user = { roles: [{ id: 'r', role: 'seller_manager' as const, sellerId: s1 }] };
    expect(canForSeller(user, 'seller.orders.write', s1)).toBe(true); expect(canForSeller(user, 'seller.orders.write', s2)).toBe(false); expect(canForSeller(user, 'seller.staff.manage', s1)).toBe(false);
    expect(canForSeller({ roles: [{ id: 'r', role: 'admin', sellerId: null }] }, 'seller.shop.write', s2)).toBe(true);
  });
});

describe('settings and feature flags', () => {
  it('public settings and flags are readable by anyone; a missing flag is ON; AI descriptions start OFF', async () => {
    const pub = (await call('GET', '/api/settings/public')).json(); expect(pub).toMatchObject({ platform_look: 'atelier', free_shipping_threshold_cents: 7500, currency: 'CAD' }); expect(pub.commission_bps).toBeUndefined();
    const flags = (await call('GET', '/api/flags')).json(); expect(flags.wishlists).toBe(true); expect(flags.ai_descriptions).toBe(false);
  });
  it('admins change settings with validation and a before/after audit record; others cannot', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const o = { area: 'admin' as const, cookie: admin.cookie };
    expect((await call('GET', '/api/admin/settings', o)).json().find((s: any) => s.key === 'commission_bps')).toMatchObject({ value: 1000, default: 1000 });
    expect((await call('PUT', '/api/admin/settings/commission_bps', { ...o, payload: { value: 1200, reason: 'Spring test' } })).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/settings', o)).json().find((s: any) => s.key === 'commission_bps').value).toBe(1200);
    expect((await q(`SELECT prev, next, reason FROM audit_log WHERE action='setting.update' AND entity_id='commission_bps' ORDER BY id DESC LIMIT 1`)).rows[0]).toMatchObject({ prev: 1000, next: 1200, reason: 'Spring test' });
    expect((await call('PUT', '/api/admin/settings/commission_bps', { ...o, payload: { value: 99999 } })).json().error).toBe('invalid_value'); expect((await call('PUT', '/api/admin/settings/platform_look', { ...o, payload: { value: 'neon' } })).statusCode).toBe(400);
    expect((await call('PUT', '/api/admin/settings/nope', { ...o, payload: { value: 1 } })).statusCode).toBe(404);
    await call('PUT', '/api/admin/settings/platform_look', { ...o, payload: { value: 'noir' } }); expect((await call('GET', '/api/settings/public')).json().platform_look).toBe('noir');
    const sup = await login(app, 'support', { role: 'support' }); expect((await call('PUT', '/api/admin/settings/commission_bps', { area: 'support', cookie: sup.cookie, payload: { value: 5 } })).statusCode).toBe(401);
  });
  it('flags toggle, are audited, and unknown flags are refused', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const o = { area: 'admin' as const, cookie: admin.cookie };
    expect((await call('PUT', '/api/admin/flags/wishlists', { ...o, payload: { enabled: false, reason: 'Pause' } })).statusCode).toBe(200); expect((await call('GET', '/api/flags')).json().wishlists).toBe(false);
    expect((await q(`SELECT prev, next FROM audit_log WHERE action='flag.update' AND entity_id='wishlists'`)).rows[0]).toMatchObject({ prev: { enabled: true }, next: { enabled: false } });
    await call('PUT', '/api/admin/flags/wishlists', { ...o, payload: { enabled: true } }); expect((await call('PUT', '/api/admin/flags/nope', { ...o, payload: { enabled: true } })).statusCode).toBe(404);
  });
});

describe('categories and attributes', () => {
  it('launch categories are loaded with the attributes the brief lists, as a public tree', async () => {
    const tree = (await call('GET', '/api/categories')).json(); expect(tree.map((c: any) => c.slug)).toEqual(expect.arrayContaining(['toys-games', 'art-prints', '3d-printing', 'perfume-fragrance', 'hair-wigs', 'pottery-ceramics', 'jewellery', 'other']));
    const pot = (await call('GET', '/api/categories/pottery-ceramics')).json(); expect(pot.attributes.map((a: any) => a.key)).toEqual(expect.arrayContaining(['technique', 'glaze', 'dishwasher_safe', 'microwave_safe']));
    expect(pot.sellerTips).toMatch(/food-safe/); expect(pot.photoGuide).toBeTruthy(); expect(pot.filters.every((f: any) => f.filterable)).toBe(true);
    const perfume = (await call('GET', '/api/categories/perfume-fragrance')).json(); expect(perfume.attributes.find((a: any) => a.key === 'flammable')).toMatchObject({ type: 'boolean', required: true }); expect(perfume.restricted).toBe(true);
    expect((await call('GET', '/api/categories/other')).json()).toMatchObject({ allowsCustomAttributes: true, attributes: [] }); expect((await call('GET', '/api/categories/nope')).statusCode).toBe(404);
  });
  it('staff create sub-categories that inherit attributes, edit them, and archive them; every change is audited', async () => {
    const cat = await login(app, 'admin', { role: 'catalogue' }); const o = { area: 'admin' as const, cookie: cat.cookie }; const pot = (await call('GET', '/api/categories/pottery-ceramics')).json();
    const sub = await call('POST', '/api/admin/categories', { ...o, payload: { slug: 'mugs-cups', name: 'Mugs & cups', parentId: pot.id } }); expect(sub.statusCode).toBe(201);
    expect((await call('POST', '/api/admin/categories', { ...o, payload: { slug: 'mugs-cups', name: 'Dup' } })).json().error).toBe('slug_exists');
    const a = await call('POST', `/api/admin/categories/${sub.json().id}/attributes`, { ...o, payload: { key: 'capacity_ml', label: 'Capacity', type: 'number', unit: 'ml', filterable: true } }); expect(a.statusCode).toBe(201);
    const detail = (await call('GET', '/api/categories/mugs-cups')).json(); expect(detail.breadcrumbs.map((b: any) => b.slug)).toEqual(['pottery-ceramics', 'mugs-cups']); expect(detail.attributes.map((x: any) => x.key)).toEqual(expect.arrayContaining(['technique', 'capacity_ml']));
    expect((await call('PATCH', `/api/admin/categories/${sub.json().id}`, { ...o, payload: { name: 'Mugs and cups', restricted: false } })).json().name).toBe('Mugs and cups');
    expect((await call('PATCH', `/api/admin/categories/${pot.id}`, { ...o, payload: { parentId: sub.json().id } })).json().error).toBe('parent_cycle');
    expect((await call('PATCH', `/api/admin/categories/${sub.json().id}`, { ...o, payload: { status: 'archived' } })).statusCode).toBe(200); expect((await call('GET', '/api/categories/mugs-cups')).statusCode).toBe(404);
    expect((await call('GET', '/api/categories')).json().flatMap((c: any) => c.children).some((c: any) => c.slug === 'mugs-cups')).toBe(false);
    expect((await q(`SELECT count(*)::int n FROM audit_log WHERE entity_type IN ('category','attribute') AND actor_id=$1`, [cat.id])).rows[0].n).toBeGreaterThanOrEqual(4);
  });
  it('attribute definitions are validated: choice lists need options, only numbers have units, keys are unique', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const o = { area: 'admin' as const, cookie: admin.cookie }; const id = (await call('GET', '/api/categories/other')).json().id;
    const add = (payload: object) => call('POST', `/api/admin/categories/${id}/attributes`, { ...o, payload });
    expect((await add({ key: 'finish', label: 'Finish', type: 'select' })).statusCode).toBe(400); expect((await add({ key: 'finish', label: 'Finish', type: 'text', options: [{ value: 'a', label: 'A' }] })).statusCode).toBe(400);
    expect((await add({ key: 'finish', label: 'Finish', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] })).statusCode).toBe(400); expect((await add({ key: 'colour', label: 'Colour', type: 'text', unit: 'cm' })).statusCode).toBe(400);
    const ok = await add({ key: 'finish', label: 'Finish', type: 'select', options: [{ value: 'matte', label: 'Matte' }, { value: 'gloss', label: 'Gloss' }] }); expect(ok.statusCode).toBe(201); expect((await add({ key: 'finish', label: 'Again', type: 'text' })).json().error).toBe('key_exists');
    expect((await call('PUT', `/api/admin/attributes/${ok.json().id}`, { ...o, payload: { key: 'finish', label: 'Surface', type: 'select', options: [{ value: 'matte', label: 'Matte' }] } })).json().label).toBe('Surface');
    expect((await call('DELETE', `/api/admin/attributes/${ok.json().id}`, o)).statusCode).toBe(200); expect((await call('DELETE', `/api/admin/attributes/${ok.json().id}`, o)).statusCode).toBe(404);
  });
  it('a category the staff edited is not overwritten when migrations run again', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const o = { area: 'admin' as const, cookie: admin.cookie }; const id = (await call('GET', '/api/categories/jewellery')).json().id;
    await call('PATCH', `/api/admin/categories/${id}`, { ...o, payload: { name: 'Fine jewellery' } }); await runMigrations(); expect((await call('GET', '/api/categories/jewellery')).json().name).toBe('Fine jewellery');
  });
});

describe('errors', () => {
  it('unknown routes and malformed input return plain JSON errors', async () => {
    expect((await call('GET', '/api/nope')).json()).toEqual({ error: 'not_found' }); expect((await call('POST', '/api/auth/login', { payload: { email: 'not-an-email', password: 'x' } })).json().error).toBe('validation_failed');
    expect((await call('GET', '/api/admin/settings')).json().error).toBe('unauthenticated'); expect((await call('GET', '/health')).json()).toEqual({ ok: true });
  });
});
