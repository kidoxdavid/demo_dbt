import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
let G = 0, P = 0, PA = 0;       // plan prices are read from the database: other test files edit them
beforeAll(async () => { app = await buildApp(); const r = (await oq(`SELECT code, price_monthly_cents m, price_annual_cents a FROM plans`)).rows; G = r.find(x => x.code === 'growth').m; P = r.find(x => x.code === 'professional').m; PA = r.find(x => x.code === 'professional').a; });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const call = (method: 'GET' | 'POST', url: string, cookie?: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookie ? ck(cookie) : {}) });
let adminCookie: string;
async function admin() {
  if (adminCookie) return adminCookie;
  const s = await k.seller('bladm'); const id = (await oq('SELECT id FROM users WHERE email=$1', ['bladm@k.test'])).rows[0].id;
  await oq(`INSERT INTO platform_staff(user_id,role_key) VALUES ($1,'super_admin')`, [id]); return (adminCookie = s.cookie);
}
const DAY = 86_400_000; const later = (d: number) => new Date(Date.now() + d * DAY).toISOString();
const run = async (tenantId: string, days: number) => (await call('POST', '/api/admin/billing/run', await admin(), { now: later(days), tenantId })).json();
const bill = async (cookie: string) => (await call('GET', '/api/seller/billing', cookie)).json();
const change = (cookie: string, plan: string, interval = 'monthly') => call('POST', '/api/seller/billing/change', cookie, { plan, interval });
const planOf = async (tenantId: string) => (await oq(`SELECT p.code FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE t.id=$1`, [tenantId])).rows[0].code as string;
const invoices = async (tenantId: string) => (await oq(`SELECT status, amount_cents::int a, credit_cents::int cr, attempts, description FROM invoices WHERE tenant_id=$1 ORDER BY created_at, period_start`, [tenantId])).rows;
const mails = async (tenantId: string, template: string) => (await oq(`SELECT 1 FROM email_outbox WHERE tenant_id=$1 AND template=$2`, [tenantId, template])).rowCount!;
async function paidSeller(n: string, plan = 'growth') {
  const s = await k.seller(n); await oq(`UPDATE subscriptions SET trial_used=true WHERE tenant_id=$1`, [s.tenantId]);     // skip the one-time trial: tested separately
  const r = await change(s.cookie, plan); expect(r.statusCode).toBe(200); return s;
}

describe('plans page', () => {
  it('shows the current plan, self-serve options (no enterprise), usage, and says the provider is simulated', async () => {
    const s = await k.seller('bl1'); await k.product(s.cookie);
    const b = await bill(s.cookie);
    expect(b.provider).toMatchObject({ name: 'simulated', simulated: true });
    expect(b.plan.code).toBe('starter'); expect(b.subscription).toMatchObject({ status: 'active', pendingPlan: null });
    expect(b.plans.map((p: any) => p.code)).toEqual(['starter', 'growth', 'professional']); expect(b.usage).toMatchObject({ activeProducts: 1, staff: 1 });
    expect(b.plans.find((p: any) => p.code === 'growth')).toMatchObject({ trialAvailable: true, trialDays: 14 });
    await oq(`UPDATE memberships SET role='staff' WHERE tenant_id=$1`, [s.tenantId]);
    expect((await call('GET', '/api/seller/billing', s.cookie)).statusCode).toBe(403);
  });
  it('only owners change plans; unknown or staff-only plans are refused', async () => {
    const s = await k.seller('bl2');
    expect((await change(s.cookie, 'enterprise')).json().error).toBe('plan_not_available'); expect((await change(s.cookie, 'nope')).json().error).toBe('plan_not_available');
    expect((await change(s.cookie, 'starter')).json().error).toBe('no_change');
    await oq(`UPDATE memberships SET role='manager' WHERE tenant_id=$1`, [s.tenantId]);
    expect((await call('GET', '/api/seller/billing', s.cookie)).statusCode).toBe(200); expect((await change(s.cookie, 'growth')).statusCode).toBe(403);
  });
});

describe('trial and renewal', () => {
  it('a first upgrade starts a free trial with no charge and unlocks the plan; the trial is offered once', async () => {
    const s = await k.seller('bl3');
    const r = await change(s.cookie, 'professional'); expect(r.json()).toMatchObject({ applied: 'trial' });
    expect(await planOf(s.tenantId)).toBe('professional'); expect(await invoices(s.tenantId)).toEqual([]);
    const b = await bill(s.cookie); expect(b.subscription).toMatchObject({ status: 'trialing', trialUsed: true }); expect(new Date(b.subscription.trialEndsAt).getTime()).toBeGreaterThan(Date.now() + 13 * DAY);
    const p = await k.product(s.cookie);                                                            // professional includes POS
    expect((await call('POST', '/api/seller/pos/sales', s.cookie, { items: [{ variantId: p.variantId, quantity: 1 }], paymentMethod: 'cash' })).statusCode).toBe(201);
    expect((await change(s.cookie, 'starter')).json()).toMatchObject({ applied: 'now' });          // leaving during a trial costs nothing
    expect(await planOf(s.tenantId)).toBe('starter');
    expect((await change(s.cookie, 'growth')).json()).toMatchObject({ applied: 'now', chargedCents: G });   // no second trial
  });
  it('when the trial ends the first invoice is charged once, and the job is safe to run twice', async () => {
    const s = await k.seller('bl4'); await change(s.cookie, 'growth');
    expect((await run(s.tenantId, 5))).toEqual({});                                                // mid-trial: nothing due
    expect(await run(s.tenantId, 15)).toMatchObject({ trialConverted: 1 });
    expect(await run(s.tenantId, 15)).toEqual({});                                                  // same moment again: nothing happens
    expect(await invoices(s.tenantId)).toEqual([expect.objectContaining({ status: 'paid', a: G, attempts: 1 })]);
    const b = await bill(s.cookie); expect(b.subscription.status).toBe('active'); expect(new Date(b.subscription.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 40 * DAY);
    expect(await mails(s.tenantId, 'billing_receipt')).toBe(1);
  });
  it('renews monthly and annually at the right price', async () => {
    const s = await paidSeller('bl5'); const a = await paidSeller('bl5b', 'professional'); await call('POST', '/api/seller/billing/change', a.cookie, { plan: 'professional', interval: 'annual' });
    expect(await run(s.tenantId, 32)).toMatchObject({ renewed: 1 });
    expect((await invoices(s.tenantId)).map(i => i.a)).toEqual([G, G]);
    const inv = await invoices(a.tenantId); expect(inv.at(-1)).toMatchObject({ description: 'Professional plan, annual' }); expect(inv.at(-1)!.a + inv.at(-1)!.cr).toBe(PA);
    expect((await bill(a.cookie)).subscription.interval).toBe('annual'); expect(await run(a.tenantId, 32)).toEqual({});       // a yearly plan is not billed again after a month
    expect((await call('POST', '/api/seller/billing/change', a.cookie, { plan: 'professional', interval: 'monthly' })).json()).toMatchObject({ applied: 'period_end' });
  });
});

describe('changing plans', () => {
  it('an upgrade is charged now with a credit for the unused time', async () => {
    const s = await paidSeller('bl6');                                                              // paid $29 just now
    const r = (await change(s.cookie, 'professional')).json();
    expect(r).toMatchObject({ applied: 'now' }); expect(r.creditCents).toBeGreaterThan(G - 30); expect(r.creditCents).toBeLessThanOrEqual(G); expect(r.chargedCents + r.creditCents).toBe(P);
    expect(await planOf(s.tenantId)).toBe('professional');
    expect((await invoices(s.tenantId)).at(-1)).toMatchObject({ status: 'paid', a: r.chargedCents, cr: r.creditCents });
  });
  it('a declined card on an upgrade changes nothing and records nothing', async () => {
    const s = await paidSeller('bl7'); await call('POST', `/api/admin/billing/${s.tenantId}/simulate-card`, await admin(), { card: 'declined' });
    const r = await change(s.cookie, 'professional'); expect(r.statusCode).toBe(402); expect(r.json().error).toBe('payment_failed:card_declined');
    expect(await planOf(s.tenantId)).toBe('growth'); expect(await invoices(s.tenantId)).toHaveLength(1);
  });
  it('a downgrade waits for the end of the period, can be withdrawn, and then bills the lower price', async () => {
    const s = await paidSeller('bl8', 'professional');
    const r = (await change(s.cookie, 'growth')).json(); expect(r).toMatchObject({ applied: 'period_end' });
    expect(await planOf(s.tenantId)).toBe('professional'); expect((await bill(s.cookie)).subscription.pendingPlan).toBe('growth');
    expect((await call('POST', '/api/seller/billing/resume', s.cookie)).json()).toEqual({ resumed: true }); expect((await bill(s.cookie)).subscription.pendingPlan).toBeNull();
    expect((await call('POST', '/api/seller/billing/resume', s.cookie)).json().error).toBe('nothing_scheduled');
    await change(s.cookie, 'growth'); expect(await run(s.tenantId, 3)).toEqual({});                // not yet due
    expect(await run(s.tenantId, 32)).toMatchObject({ downgraded: 1, renewed: 1 });
    expect(await planOf(s.tenantId)).toBe('growth'); expect((await invoices(s.tenantId)).at(-1)).toMatchObject({ a: G });
  });
  it('cancelling moves to Starter at period end without a charge', async () => {
    const s = await paidSeller('bl9');
    expect((await call('POST', '/api/seller/billing/cancel', s.cookie)).json()).toMatchObject({ applied: 'period_end' });
    expect((await bill(s.cookie)).subscription).toMatchObject({ cancelAtPeriodEnd: true, pendingPlan: 'starter' }); expect(await planOf(s.tenantId)).toBe('growth');
    expect(await run(s.tenantId, 32)).toMatchObject({ downgraded: 1 });
    expect(await planOf(s.tenantId)).toBe('starter'); expect(await invoices(s.tenantId)).toHaveLength(1);
    expect((await bill(s.cookie)).subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
  });
  it('a downgrade is refused while usage is above the lower plan, and a scheduled one is dropped if usage grew', async () => {
    const s = await paidSeller('bl10'); await k.product(s.cookie); await k.product(s.cookie);
    try {
      await oq(`UPDATE plans SET limits = jsonb_set(limits,'{active_products}','1') WHERE code='starter'`);
      expect((await call('POST', '/api/seller/billing/cancel', s.cookie)).json().error).toBe('usage_exceeds_plan:active_products:2/1');
      expect((await bill(s.cookie)).plans.find((p: any) => p.code === 'starter').exceeds).toEqual([{ limit: 'active_products', max: 1, used: 2 }]);
      await oq(`UPDATE plans SET limits = jsonb_set(limits,'{active_products}','50') WHERE code='starter'`);
      await call('POST', '/api/seller/billing/cancel', s.cookie);
      await oq(`UPDATE plans SET limits = jsonb_set(limits,'{active_products}','1') WHERE code='starter'`);
      expect(await run(s.tenantId, 32)).toMatchObject({ downgradeBlocked: 1, renewed: 1 }); expect(await planOf(s.tenantId)).toBe('growth');
    } finally { await oq(`UPDATE plans SET limits = jsonb_set(limits,'{active_products}','50') WHERE code='starter'`); }
  });
});

describe('failed payments', () => {
  it('past due: retried daily, recovers when the card works, never double charged', async () => {
    const s = await paidSeller('bl11'); await call('POST', `/api/admin/billing/${s.tenantId}/simulate-card`, await admin(), { card: 'declined' });
    expect(await run(s.tenantId, 32)).toMatchObject({ failed: 1 });
    expect((await bill(s.cookie)).subscription).toMatchObject({ status: 'past_due' }); expect(await planOf(s.tenantId)).toBe('growth');     // access continues during the grace period
    expect(await mails(s.tenantId, 'billing_payment_failed')).toBe(1);
    expect(await run(s.tenantId, 32)).toEqual({});                                                  // same day: no hammering the card
    expect(await run(s.tenantId, 34)).toMatchObject({ stillFailing: 1 }); expect(await mails(s.tenantId, 'billing_payment_failed')).toBe(1);
    expect((await invoices(s.tenantId)).at(-1)).toMatchObject({ status: 'failed', attempts: 2 });
    expect((await change(s.cookie, 'professional')).json().error).toBe('payment_past_due');
    await call('POST', `/api/admin/billing/${s.tenantId}/simulate-card`, await admin(), { card: 'ok' });
    expect(await run(s.tenantId, 36)).toMatchObject({ recovered: 1 });
    expect((await invoices(s.tenantId)).at(-1)).toMatchObject({ status: 'paid', attempts: 3 }); expect((await invoices(s.tenantId)).filter(i => i.status === 'paid')).toHaveLength(2);
    expect((await bill(s.cookie)).subscription).toMatchObject({ status: 'active', pastDueSince: null });
  });
  it('unpaid past the grace period moves the store to Starter and says so', async () => {
    const s = await paidSeller('bl12'); await call('POST', `/api/admin/billing/${s.tenantId}/simulate-card`, await admin(), { card: 'declined' });
    await run(s.tenantId, 32); expect(await run(s.tenantId, 32 + 8)).toMatchObject({ downgradedUnpaid: 1 });
    expect(await planOf(s.tenantId)).toBe('starter'); expect(await mails(s.tenantId, 'billing_downgraded')).toBe(1);
    expect((await bill(s.cookie)).subscription.status).toBe('active');
  });
  it('the seller can retry from the plan page', async () => {
    const s = await paidSeller('bl13'); await call('POST', `/api/admin/billing/${s.tenantId}/simulate-card`, await admin(), { card: 'declined' });
    await run(s.tenantId, 32); await call('POST', `/api/admin/billing/${s.tenantId}/simulate-card`, await admin(), { card: 'ok' });
    await oq(`UPDATE subscriptions SET current_period_end = now() - interval '1 hour' WHERE tenant_id=$1`, [s.tenantId]);
    expect((await call('POST', '/api/seller/billing/retry', s.cookie)).json()).toEqual({ status: 'active' });
  });
});

describe('staff', () => {
  it('staff can arrange a plan (enterprise); the seller cannot buy their way around it; every step is audited', async () => {
    const s = await k.seller('bl14'); const adm = await admin();
    expect((await call('POST', `/api/admin/sellers/${s.tenantId}/plan`, adm, { plan: 'enterprise', reason: 'x' })).statusCode).toBe(400);
    expect((await call('POST', `/api/admin/sellers/${s.tenantId}/plan`, adm, { plan: 'enterprise', reason: 'Annual contract signed' })).statusCode).toBe(200);
    expect(await planOf(s.tenantId)).toBe('enterprise'); expect((await bill(s.cookie)).subscription.managedByStaff).toBe(true);
    expect((await change(s.cookie, 'professional')).json().error).toBe('managed_by_staff');
    expect(await run(s.tenantId, 40)).toMatchObject({ rolled: 1 }); expect(await invoices(s.tenantId)).toEqual([]);          // staff-managed: never charged by the platform
    expect((await call('POST', `/api/admin/sellers/${s.tenantId}/plan`, s.cookie, { plan: 'starter', reason: 'self service' })).statusCode).toBe(403);
    expect((await oq(`SELECT count(*)::int n FROM audit_logs WHERE tenant_id=$1 AND action='billing.staff_set_plan'`, [s.tenantId])).rows[0].n).toBe(1);
  });
  it('the simulated card switch and the clock override are staff-only', async () => {
    const s = await k.seller('bl15');
    expect((await call('POST', `/api/admin/billing/${s.tenantId}/simulate-card`, s.cookie, { card: 'declined' })).statusCode).toBe(403);
    expect((await call('POST', '/api/admin/billing/run', s.cookie, {})).statusCode).toBe(403);
  });
  it('the admin overview and billing page report subscription revenue', async () => {
    await paidSeller('bl16'); const adm = await admin();
    const ov = (await call('GET', '/api/admin/overview', adm)).json(); expect(ov.subscriptionRevenueCents).toBeGreaterThanOrEqual(G); expect(ov.payingSubscriptions).toBeGreaterThanOrEqual(1);
    const ab = (await call('GET', '/api/admin/billing', adm)).json(); expect(ab.provider.simulated).toBe(true); expect(ab.byPlan.find((p: any) => p.code === 'growth').tenants).toBeGreaterThanOrEqual(1); expect(ab.note).toMatch(/simulated/);
  });
});
