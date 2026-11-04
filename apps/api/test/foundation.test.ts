import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { withTx, pool } from '../src/lib/db.js';

let app: FastifyInstance;
const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

async function ownerQ(sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_admin','on',true)`); const r = await c.query(sql, params); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const PW = 'correct-horse-battery';
async function signup(n: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `${n}@x.test`, password: PW, fullName: n, businessName: `${n} Biz`, storeSlug: `${n}-store` } });
  return { res: r, cookie: r.cookies.find(c => c.name === 'eazy_sid')?.value ?? '' , tenantId: r.json().tenantId as string };
}
const as = (cookie: string) => ({ cookies: { eazy_sid: cookie } });

describe('auth & onboarding', () => {
  it('signs up a seller, creates tenant+business+draft store, and resumes onboarding', async () => {
    const a = await signup('alice');
    expect(a.res.statusCode).toBe(201);
    const me = await app.inject({ method: 'GET', url: '/api/seller/business', ...as(a.cookie) });
    expect(me.json().business.business_name).toBe('alice Biz');
    expect(me.json().store.status).toBe('draft');
    const p = await app.inject({ method: 'PATCH', url: '/api/seller/business', ...as(a.cookie), payload: { onboardingStep: 'location', city: 'Calgary' } });
    expect(p.json().onboarding_step).toBe('location');
  });
  it('rejects duplicate email, reserved and taken slugs, weak passwords', async () => {
    await signup('dup');
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'dup@x.test', password: PW, fullName: 'd', businessName: 'b', storeSlug: 'other-one' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'n1@x.test', password: PW, fullName: 'd', businessName: 'b', storeSlug: 'admin' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'n2@x.test', password: PW, fullName: 'd', businessName: 'b', storeSlug: 'dup-store' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'n3@x.test', password: 'short', fullName: 'd', businessName: 'b', storeSlug: 'fine-slug' } })).statusCode).toBe(400);
  });
  it('concurrent signups for the same slug: exactly one wins', async () => {
    const mk = (i: number) => app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `race${i}@x.test`, password: PW, fullName: 'r', businessName: 'r', storeSlug: 'race-slug' } });
    const codes = (await Promise.all([mk(1), mk(2), mk(3)])).map(r => r.statusCode).sort();
    expect(codes.filter(c => c === 201)).toHaveLength(1);
    expect(codes.filter(c => c === 409)).toHaveLength(2);
  });
  it('locks the account after repeated failed logins', async () => {
    await signup('locky');
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'locky@x.test', password: 'wrong-password' } });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'locky@x.test', password: PW } });
    expect(r.statusCode).toBe(429);
  });
  it('stores only a hash of the session token', async () => {
    const a = await signup('hashy');
    expect(a.cookie.length).toBeGreaterThan(20);
    const rows = (await owner.query('SELECT token_hash FROM sessions')).rows.map(r => r.token_hash);
    expect(rows).not.toContain(a.cookie);
  });
  it('blocks cross-origin mutations', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example', host: 'api.eazystores.test' }, payload: { email: 'a@x.test', password: 'x' } });
    expect(r.statusCode).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('RLS: a tenant context cannot read or write another tenant rows (database level)', async () => {
    const a = await signup('iso-a'); const b = await signup('iso-b');
    const seen = await withTx({ tenantId: a.tenantId }, async c => (await c.query('SELECT tenant_id FROM businesses')).rows);
    expect(seen.map(r => r.tenant_id)).toEqual([a.tenantId]);
    const upd = await withTx({ tenantId: a.tenantId }, c => c.query(`UPDATE businesses SET business_name='pwned' WHERE tenant_id=$1`, [b.tenantId]));
    expect(upd.rowCount).toBe(0);
    await expect(withTx({ tenantId: a.tenantId }, c => c.query(`INSERT INTO stores(tenant_id,slug,name) VALUES ($1,'sneaky-store','x')`, [b.tenantId]))).rejects.toThrow(/row-level security/);
    const none = await withTx({}, async c => (await c.query('SELECT * FROM businesses')).rowCount);
    expect(none).toBe(0); // no context → no tenant data
  });
  it('API: seller only ever sees their own business, even with manipulated input', async () => {
    const a = await signup('api-a'); const b = await signup('api-b');
    const r = await app.inject({ method: 'GET', url: `/api/seller/business?tenantId=${b.tenantId}`, headers: { 'x-tenant-id': b.tenantId }, ...as(a.cookie) });
    expect(r.json().business.tenant_id).toBe(a.tenantId);
    const strict = await app.inject({ method: 'PATCH', url: '/api/seller/business', ...as(a.cookie), payload: { tenant_id: b.tenantId, city: 'x' } });
    expect(strict.statusCode).toBe(400);
  });
  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/seller/business' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/sellers' })).statusCode).toBe(401);
  });
});

describe('publishing & public storefront', () => {
  it('draft stores are invisible; incomplete profiles cannot publish; published stores are public', async () => {
    const a = await signup('pub');
    expect((await app.inject({ method: 'GET', url: '/api/public/stores/pub-store' })).statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: '/api/seller/store/publish', ...as(a.cookie) });
    expect(bad.statusCode).toBe(422);
    await app.inject({ method: 'PATCH', url: '/api/seller/business', ...as(a.cookie), payload: { category: 'perfume', description: 'Fragrances' } });
    expect((await app.inject({ method: 'POST', url: '/api/seller/store/publish', ...as(a.cookie) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/public/stores/pub-store' })).statusCode).toBe(200);
  });
});

describe('admin RBAC, suspension & audit', () => {
  async function staff(n: string, role: string) {
    const s = await signup(n);
    const id = (await owner.query('SELECT id FROM users WHERE email=$1', [`${n}@x.test`])).rows[0].id;
    await owner.query('INSERT INTO platform_staff(user_id,role_key) VALUES ($1,$2)', [id, role]);
    return s.cookie;
  }
  it('enforces per-role permissions; sellers are not admins', async () => {
    const seller = await signup('plain');
    expect((await app.inject({ method: 'GET', url: '/api/admin/sellers', ...as(seller.cookie) })).statusCode).toBe(403);
    const support = await staff('sup1', 'support');
    expect((await app.inject({ method: 'GET', url: '/api/admin/sellers', ...as(support) })).statusCode).toBe(200);
    const t = await signup('victim');
    expect((await app.inject({ method: 'POST', url: `/api/admin/sellers/${t.tenantId}/suspend`, ...as(support), payload: { reason: 'abuse reports' } })).statusCode).toBe(403);
  });
  it('suspension requires a reason, hides the store, blocks publishing, and is audited; reinstating works', async () => {
    const mod = await staff('mod1', 'moderator');
    const t = await signup('shady');
    await app.inject({ method: 'PATCH', url: '/api/seller/business', ...as(t.cookie), payload: { category: 'x', description: 'y' } });
    await app.inject({ method: 'POST', url: '/api/seller/store/publish', ...as(t.cookie) });
    expect((await app.inject({ method: 'POST', url: `/api/admin/sellers/${t.tenantId}/suspend`, ...as(mod), payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/admin/sellers/${t.tenantId}/suspend`, ...as(mod), payload: { reason: 'prohibited listings' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/public/stores/shady-store' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/seller/store/publish', ...as(t.cookie) })).statusCode).toBe(403);
    const log = (await ownerQ(`SELECT * FROM audit_logs WHERE action='seller.suspend' AND tenant_id=$1`, [t.tenantId])).rows[0];
    expect(log.reason).toBe('prohibited listings'); expect(log.previous_value.status).toBe('active'); expect(log.actor_user_id).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: `/api/admin/sellers/${t.tenantId}/reinstate`, ...as(mod), payload: { reason: 'appeal accepted' } })).statusCode).toBe(200);
  });
  it('audit log is append-only: no delete/update/truncate succeeds, even as table owner', async () => {
    const before = (await ownerQ('SELECT count(*)::int n FROM audit_logs')).rows[0].n;
    expect(before).toBeGreaterThan(0);
    await ownerQ('DELETE FROM audit_logs'); await ownerQ(`UPDATE audit_logs SET action='x'`);
    expect((await ownerQ('SELECT count(*)::int n FROM audit_logs')).rows[0].n).toBe(before);
    expect((await ownerQ(`SELECT count(*)::int n FROM audit_logs WHERE action='x'`)).rows[0].n).toBe(0);
    await expect(ownerQ('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_logs')).rejects.toThrow(/permission denied/);
  });
  it('plan edits need plans.write and a reason, and record before/after', async () => {
    const fin = await staff('fin1', 'finance'); const mod = await staff('mod2', 'moderator');
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/plans/growth', ...as(mod), payload: { priceMonthlyCents: 100, reason: 'test test' } })).statusCode).toBe(403);
    const r = await app.inject({ method: 'PATCH', url: '/api/admin/plans/growth', ...as(fin), payload: { priceMonthlyCents: 3500, reason: 'pricing review' } });
    expect(r.json().price_monthly_cents).toBe(3500);
    const log = (await ownerQ(`SELECT * FROM audit_logs WHERE action='plan.update'`)).rows[0];
    expect(log.previous_value.price_monthly_cents).toBe(2900);
  });
});
