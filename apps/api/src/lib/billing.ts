import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { billingProvider } from '../config.js';
import { withTx, audit } from './db.js';
import { HttpError } from './errors.js';
import { enqueue, ownerEmail, url } from './mail.js';

/** Port every subscription-billing adapter must implement. Card details never touch our servers. */
export interface BillingProvider {
  readonly name: string;
  readonly status: 'live' | 'sandbox' | 'simulated';
  charge(a: { tenantId: string; amountCents: number; currency: string; description: string; idempotencyKey: string; simCard?: string }): Promise<{ ok: true; providerRef: string } | { ok: false; reason: string }>;
}
/** Simulated adapter: moves no money. A seller's simulated card approves unless staff switch it to "declined" (to exercise failure handling). */
const simulated: BillingProvider = {
  name: 'simulated', status: 'simulated',
  async charge(a) { return a.simCard === 'declined' ? { ok: false, reason: 'card_declined' } : { ok: true, providerRef: 'simbill_' + randomBytes(10).toString('hex') }; },
};
export const getBillingProvider = (): BillingProvider | null => (billingProvider === 'simulated' ? simulated : null);

export type Interval = 'monthly' | 'annual';
interface Plan { id: string; code: string; name: string; price_monthly_cents: number; price_annual_cents: number; currency: string; limits: Record<string, number | null>; features: Record<string, boolean>; trial_days: number; is_public: boolean; transaction_fee_bps: number }
interface Sub { tenant_id: string; plan_id: string; billing_interval: Interval; status: 'active' | 'trialing' | 'past_due'; current_period_start: Date; current_period_end: Date; trial_ends_at: Date | null; trial_used: boolean;
  pending_plan_id: string | null; pending_interval: Interval | null; cancel_at_period_end: boolean; past_due_since: Date | null; last_attempt_at: Date | null; provider: string; sim_card: string }

export const priceOf = (p: Plan, i: Interval) => (i === 'annual' ? p.price_annual_cents : p.price_monthly_cents);
export const monthlyEq = (p: Plan, i: Interval) => (i === 'annual' ? p.price_annual_cents / 12 : p.price_monthly_cents);
/** Plans a seller can choose for themselves. Enterprise (and anything priced at zero except Starter) is arranged with staff. */
export const selfServe = (p: Plan) => p.is_public && (p.price_monthly_cents > 0 || p.code === 'starter');
const DAY = 86_400_000;

export async function allPlans(c: pg.PoolClient): Promise<Plan[]> { return (await c.query('SELECT * FROM plans ORDER BY sort_order, code')).rows; }
const planBy = (plans: Plan[], key: string, by: 'id' | 'code' = 'id') => plans.find(p => p[by] === key);
async function addPeriod(c: pg.PoolClient, from: Date, i: Interval): Promise<Date> {
  return (await c.query(`SELECT ($1::timestamptz + ($2)::interval) AS d`, [from.toISOString(), i === 'annual' ? '1 year' : '1 month'])).rows[0].d;
}
export async function graceDays(c: pg.PoolClient) { return Number((await c.query(`SELECT value FROM platform_settings WHERE key='billing_grace_days'`)).rows[0]?.value ?? 7); }

/** The business's subscription row, created on first use for businesses that pre-date billing. Locks the row for the rest of the transaction. */
export async function lockSubscription(c: pg.PoolClient, tenantId: string): Promise<Sub> {
  await c.query(`INSERT INTO subscriptions(tenant_id, plan_id) SELECT id, plan_id FROM tenants WHERE id=$1 ON CONFLICT DO NOTHING`, [tenantId]);
  const s = (await c.query('SELECT * FROM subscriptions WHERE tenant_id=$1 FOR UPDATE', [tenantId])).rows[0] as Sub;
  const t = (await c.query('SELECT plan_id FROM tenants WHERE id=$1', [tenantId])).rows[0];
  if (t && t.plan_id !== s.plan_id) { await c.query('UPDATE subscriptions SET plan_id=$2 WHERE tenant_id=$1', [tenantId, t.plan_id]); s.plan_id = t.plan_id; }   // tenants.plan_id is the truth
  return s;
}

export async function usageOf(c: pg.PoolClient, tenantId: string) {
  return {
    activeProducts: Number((await c.query(`SELECT count(*) n FROM products WHERE tenant_id=$1 AND status='active'`, [tenantId])).rows[0].n),
    staff: Number((await c.query(`SELECT count(*) n FROM memberships WHERE tenant_id=$1`, [tenantId])).rows[0].n),
  };
}
/** What a plan's limits would be broken by the business's current usage. */
export function exceeds(plan: Plan, u: { activeProducts: number; staff: number }) {
  const out: { limit: string; max: number; used: number }[] = [];
  const ap = plan.limits.active_products; if (ap != null && u.activeProducts > ap) out.push({ limit: 'active_products', max: ap, used: u.activeProducts });
  const st = plan.limits.staff; if (st != null && u.staff > st) out.push({ limit: 'staff', max: st, used: u.staff });
  return out;
}

async function setPlan(c: pg.PoolClient, tenantId: string, planId: string) { await c.query('UPDATE tenants SET plan_id=$2 WHERE id=$1', [tenantId, planId]); }
async function receipt(c: pg.PoolClient, tenantId: string, plan: Plan, amount: number, periodEnd: Date) {
  const to = await ownerEmail(c, tenantId); if (to && amount > 0) await enqueue(c, { tenantId, to, template: 'billing_receipt', data: { plan: plan.name, amount, currency: plan.currency, periodEnd: new Date(periodEnd).toISOString().slice(0, 10), url: url('/dashboard/plan') } });
}

/** Customer-initiated plan change. Upgrades apply now (prorated credit for unused time); downgrades and cancellation apply at the end of the paid period. */
export async function changePlan(c: pg.PoolClient, a: { tenantId: string; actor: string; planCode: string; interval: Interval; now?: Date; ip?: string }) {
  const now = a.now ?? new Date();
  const plans = await allPlans(c); const sub = await lockSubscription(c, a.tenantId);
  const cur = planBy(plans, sub.plan_id)!; const target = planBy(plans, a.planCode, 'code');
  if (!target || !selfServe(target)) throw new HttpError(422, 'plan_not_available');
  const interval: Interval = target.price_monthly_cents === 0 ? 'monthly' : a.interval;
  if (target.id === cur.id && interval === sub.billing_interval) {
    if (sub.pending_plan_id || sub.cancel_at_period_end) { await c.query(`UPDATE subscriptions SET pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, updated_at=now() WHERE tenant_id=$1`, [a.tenantId]); return { applied: 'resumed' as const }; }
    throw new HttpError(409, 'no_change');
  }
  const fit = exceeds(target, await usageOf(c, a.tenantId));
  // Moving to annual on the same plan applies now (with credit for the unused month); moving back to monthly waits for the end of the paid year.
  const upgrade = target.id === cur.id ? interval === 'annual' : monthlyEq(target, interval) > monthlyEq(cur, sub.billing_interval);
  const prev = { plan: cur.code, interval: sub.billing_interval };

  if (!upgrade) {
    if (fit.length) throw new HttpError(409, `usage_exceeds_plan:${fit.map(f => `${f.limit}:${f.used}/${f.max}`).join(',')}`);
    if (sub.status === 'trialing' && target.price_monthly_cents === 0) {                         // leaving a trial: nothing was paid, so end it now
      await setPlan(c, a.tenantId, target.id);
      const end = await addPeriod(c, now, 'monthly');
      await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval='monthly', status='active', trial_ends_at=NULL, current_period_start=$3, current_period_end=$4, pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, updated_at=now() WHERE tenant_id=$1`, [a.tenantId, target.id, now.toISOString(), end]);
      await audit(c, { actor: a.actor, tenantId: a.tenantId, action: 'billing.change', entityType: 'subscription', entityId: a.tenantId, prev, next: { plan: target.code, interval, applied: 'now' }, ip: a.ip });
      return { applied: 'now' as const };
    }
    await c.query(`UPDATE subscriptions SET pending_plan_id=$2, pending_interval=$3, cancel_at_period_end=$4, updated_at=now() WHERE tenant_id=$1`, [a.tenantId, target.id, interval, target.price_monthly_cents === 0]);
    await audit(c, { actor: a.actor, tenantId: a.tenantId, action: 'billing.schedule_change', entityType: 'subscription', entityId: a.tenantId, prev, next: { plan: target.code, interval, applied: 'period_end' }, ip: a.ip });
    return { applied: 'period_end' as const, effectiveAt: sub.current_period_end };
  }

  if (sub.status === 'past_due') throw new HttpError(409, 'payment_past_due');
  const provider = getBillingProvider(); if (!provider) throw new HttpError(503, 'billing_not_configured');
  if (sub.provider === 'manual') throw new HttpError(409, 'managed_by_staff');

  // Free trial: once per business, only when moving up from a free plan.
  if (cur.price_monthly_cents === 0 && target.trial_days > 0 && !sub.trial_used) {
    const end = new Date(now.getTime() + target.trial_days * DAY);
    await setPlan(c, a.tenantId, target.id);
    await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval=$3, status='trialing', trial_used=true, trial_ends_at=$5, current_period_start=$4, current_period_end=$5, pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, provider=$6, updated_at=now() WHERE tenant_id=$1`,
      [a.tenantId, target.id, interval, now.toISOString(), end.toISOString(), provider.name]);
    await audit(c, { actor: a.actor, tenantId: a.tenantId, action: 'billing.trial_start', entityType: 'subscription', entityId: a.tenantId, prev, next: { plan: target.code, interval, trialEnds: end.toISOString() }, ip: a.ip });
    return { applied: 'trial' as const, trialEndsAt: end };
  }
  if (sub.status === 'trialing') {                                                               // switching plans during a trial: no charge until the trial ends
    await setPlan(c, a.tenantId, target.id);
    await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval=$3, pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, updated_at=now() WHERE tenant_id=$1`, [a.tenantId, target.id, interval]);
    await audit(c, { actor: a.actor, tenantId: a.tenantId, action: 'billing.change', entityType: 'subscription', entityId: a.tenantId, prev, next: { plan: target.code, interval, applied: 'now' }, ip: a.ip });
    return { applied: 'now' as const };
  }

  // Immediate upgrade: charge the new price now, minus a credit for the unused part of what was already paid.
  const full = priceOf(target, interval);
  const periodMs = new Date(sub.current_period_end).getTime() - new Date(sub.current_period_start).getTime();
  const leftMs = Math.max(0, new Date(sub.current_period_end).getTime() - now.getTime());
  const credit = priceOf(cur, sub.billing_interval) > 0 && periodMs > 0 ? Math.floor((priceOf(cur, sub.billing_interval) * leftMs) / periodMs) : 0;
  const amount = Math.max(0, full - credit);
  const end = await addPeriod(c, now, interval);
  const desc = `${target.name} plan, ${interval}`;
  let ref: string | null = null;
  if (amount > 0) {
    const r = await provider.charge({ tenantId: a.tenantId, amountCents: amount, currency: target.currency, description: desc, idempotencyKey: `${a.tenantId}:${now.toISOString()}`, simCard: sub.sim_card });
    if (!r.ok) throw new HttpError(402, `payment_failed:${r.reason}`);                          // nothing changes: the transaction rolls back
    ref = r.providerRef;
  }
  await c.query(`INSERT INTO invoices(tenant_id,plan_id,billing_interval,description,amount_cents,credit_cents,currency,status,period_start,period_end,provider,provider_ref,paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8,$9,$10,$11,now())`,
    [a.tenantId, target.id, interval, desc, amount, credit, target.currency, now.toISOString(), end, provider.name, ref]);
  await setPlan(c, a.tenantId, target.id);
  await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval=$3, status='active', current_period_start=$4, current_period_end=$5, pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, past_due_since=NULL, provider=$6, updated_at=now() WHERE tenant_id=$1`,
    [a.tenantId, target.id, interval, now.toISOString(), end, provider.name]);
  await audit(c, { actor: a.actor, tenantId: a.tenantId, action: 'billing.change', entityType: 'subscription', entityId: a.tenantId, prev, next: { plan: target.code, interval, applied: 'now', chargedCents: amount, creditCents: credit }, ip: a.ip });
  await receipt(c, a.tenantId, target, amount, end);
  return { applied: 'now' as const, chargedCents: amount, creditCents: credit };
}

/** Charge for the period starting at `periodStart`. Records or updates the period's single invoice. Returns whether it was paid. */
async function attempt(c: pg.PoolClient, sub: Sub, plan: Plan, interval: Interval, periodStart: Date, now: Date): Promise<boolean> {
  const provider = getBillingProvider(); const amount = priceOf(plan, interval); const end = await addPeriod(c, periodStart, interval); const desc = `${plan.name} plan, ${interval}`;
  const r = provider ? await provider.charge({ tenantId: sub.tenant_id, amountCents: amount, currency: plan.currency, description: desc, idempotencyKey: `${sub.tenant_id}:${new Date(periodStart).toISOString()}`, simCard: sub.sim_card })
                     : { ok: false as const, reason: 'billing_not_configured' };
  const ps = new Date(periodStart).toISOString();
  if (r.ok) {
    await c.query(`INSERT INTO invoices(tenant_id,plan_id,billing_interval,description,amount_cents,currency,status,period_start,period_end,provider,provider_ref,paid_at) VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,$8,$9,$10,$11)
                   ON CONFLICT (tenant_id, period_start) DO UPDATE SET status='paid', attempts=invoices.attempts+1, provider_ref=EXCLUDED.provider_ref, failure_reason=NULL, paid_at=EXCLUDED.paid_at, plan_id=EXCLUDED.plan_id, amount_cents=EXCLUDED.amount_cents, description=EXCLUDED.description`,
      [sub.tenant_id, plan.id, interval, desc, amount, plan.currency, ps, end, provider!.name, r.providerRef, now.toISOString()]);
    await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval=$3, status='active', trial_ends_at=NULL, current_period_start=$4, current_period_end=$5, past_due_since=NULL, last_attempt_at=$6, pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, updated_at=now() WHERE tenant_id=$1`,
      [sub.tenant_id, plan.id, interval, ps, end, now.toISOString()]);
    await receipt(c, sub.tenant_id, plan, amount, end); return true;
  }
  await c.query(`INSERT INTO invoices(tenant_id,plan_id,billing_interval,description,amount_cents,currency,status,period_start,period_end,provider,failure_reason) VALUES ($1,$2,$3,$4,$5,$6,'failed',$7,$8,$9,$10)
                 ON CONFLICT (tenant_id, period_start) DO UPDATE SET attempts=invoices.attempts+1, failure_reason=EXCLUDED.failure_reason`,
    [sub.tenant_id, plan.id, interval, desc, amount, plan.currency, ps, end, provider?.name ?? 'none', r.reason]);
  const first = sub.status !== 'past_due';
  await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval=$3, status='past_due', past_due_since=coalesce(past_due_since,$4), last_attempt_at=$4, updated_at=now() WHERE tenant_id=$1`, [sub.tenant_id, plan.id, interval, now.toISOString()]);
  if (first) {
    const to = await ownerEmail(c, sub.tenant_id); const grace = await graceDays(c);
    if (to) await enqueue(c, { tenantId: sub.tenant_id, to, template: 'billing_payment_failed', data: { plan: plan.name, amount, currency: plan.currency, graceDays: grace, url: url('/dashboard/plan') } });
  }
  await audit(c, { action: 'billing.payment_failed', tenantId: sub.tenant_id, entityType: 'subscription', entityId: sub.tenant_id, next: { plan: plan.code, reason: r.reason } });
  return false;
}

async function downgradeToStarter(c: pg.PoolClient, sub: Sub, plans: Plan[], now: Date, why: string, notify: boolean) {
  const starter = planBy(plans, 'starter', 'code')!; const old = planBy(plans, sub.plan_id)!; const end = await addPeriod(c, now, 'monthly');
  await setPlan(c, sub.tenant_id, starter.id);
  await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval='monthly', status='active', trial_ends_at=NULL, current_period_start=$3, current_period_end=$4, past_due_since=NULL, pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, updated_at=now() WHERE tenant_id=$1`, [sub.tenant_id, starter.id, now.toISOString(), end]);
  await audit(c, { action: 'billing.downgrade', tenantId: sub.tenant_id, entityType: 'subscription', entityId: sub.tenant_id, prev: { plan: old.code }, next: { plan: 'starter' }, reason: why });
  if (notify) { const to = await ownerEmail(c, sub.tenant_id); if (to) await enqueue(c, { tenantId: sub.tenant_id, to, template: 'billing_downgraded', data: { plan: old.name, url: url('/dashboard/plan') } }); }
}

async function processOne(c: pg.PoolClient, tenantId: string, now: Date, out: Record<string, number>) {
  const sub = (await c.query('SELECT * FROM subscriptions WHERE tenant_id=$1 FOR UPDATE SKIP LOCKED', [tenantId])).rows[0] as Sub | undefined; if (!sub) return;
  const plans = await allPlans(c); const cur = planBy(plans, sub.plan_id)!; const bump = (k: string) => { out[k] = (out[k] ?? 0) + 1; };

  if (sub.status === 'past_due') {
    const grace = await graceDays(c);
    if (new Date(sub.past_due_since!).getTime() + grace * DAY <= now.getTime()) { await downgradeToStarter(c, sub, plans, now, 'unpaid after grace period', true); return bump('downgradedUnpaid'); }
    if (!sub.last_attempt_at || new Date(sub.last_attempt_at).getTime() + DAY <= now.getTime()) {
      const open = (await c.query(`SELECT period_start FROM invoices WHERE tenant_id=$1 AND status='failed' ORDER BY period_start DESC LIMIT 1`, [tenantId])).rows[0];
      return (await attempt(c, sub, cur, sub.billing_interval, open?.period_start ?? sub.current_period_end, now)) ? bump('recovered') : bump('stillFailing');
    }
    return;
  }
  if (new Date(sub.current_period_end).getTime() > now.getTime()) return;

  let plan = cur; let interval = sub.billing_interval;
  if (sub.pending_plan_id || sub.cancel_at_period_end) {
    const target = planBy(plans, sub.pending_plan_id ?? plans.find(p => p.code === 'starter')!.id)!;
    if (exceeds(target, await usageOf(c, tenantId)).length) {                                   // usage grew since the change was scheduled: keep the current plan
      await c.query(`UPDATE subscriptions SET pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false WHERE tenant_id=$1`, [tenantId]);
      await audit(c, { action: 'billing.downgrade_blocked', tenantId, entityType: 'subscription', entityId: tenantId, next: { wanted: target.code }, reason: 'usage exceeds the lower plan' });
      bump('downgradeBlocked');
    } else if (target.price_monthly_cents === 0) { await downgradeToStarter(c, sub, plans, new Date(sub.current_period_end), 'scheduled change', false); return bump('downgraded'); }
    else { plan = target; interval = sub.pending_interval ?? interval; await setPlan(c, tenantId, plan.id); bump('downgraded'); }
  }
  if (sub.provider === 'manual' || priceOf(plan, interval) === 0) {                              // free or staff-managed: just roll the period
    const end = await addPeriod(c, sub.current_period_end, interval);
    await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval=$3, current_period_start=current_period_end, current_period_end=$4, status='active', trial_ends_at=NULL, pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, updated_at=now() WHERE tenant_id=$1`, [tenantId, plan.id, interval, end]);
    return bump('rolled');
  }
  const wasTrial = sub.status === 'trialing';
  (await attempt(c, sub, plan, interval, sub.current_period_end, now)) ? bump(wasTrial ? 'trialConverted' : 'renewed') : bump('failed');
}

/** The scheduled job: renew what is due, retry unpaid subscriptions daily, downgrade those unpaid past the grace period. Safe to run repeatedly and from several processes. */
export async function runBilling(now = new Date(), onlyTenant?: string) {
  const ids = (await withTx({ platform: true }, async c => (await c.query(
    `SELECT tenant_id FROM subscriptions WHERE (status='past_due' OR current_period_end <= $1) AND ($2::uuid IS NULL OR tenant_id=$2) ORDER BY current_period_end LIMIT 500`, [now.toISOString(), onlyTenant ?? null])).rows)).map(r => r.tenant_id as string);
  const out: Record<string, number> = {};
  for (const id of ids) {
    try { await withTx({ platform: true }, c => processOne(c, id, now, out)); }
    catch (e) { console.error('billing failed for', id, e); out.errors = (out.errors ?? 0) + 1; }
  }
  return out;
}
