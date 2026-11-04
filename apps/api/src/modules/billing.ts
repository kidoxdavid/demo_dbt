import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { allPlans, changePlan, exceeds, getBillingProvider, graceDays, lockSubscription, runBilling, selfServe, usageOf, priceOf } from '../lib/billing.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const interval = z.enum(['monthly', 'annual']);

/**
 * Plans and billing. Honest scope: with BILLING_PROVIDER=simulated no money moves (every screen says so); with none, paid plans cannot be bought.
 * A real card processor adapter is not built yet. Subscription fees are shown and recorded WITHOUT sales tax: GST/HST on EazyStores' own fees is an
 * accounting question that has to be settled before real invoices are issued.
 */
export function registerBilling(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx>; platformPerm: (r: FastifyRequest, perm: string) => Promise<void> }) {
  const { tenantCtx, platformPerm } = deps;
  const viewOk = (t: TenantCtx) => { if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden'); };
  const ownerOnly = (t: TenantCtx) => { if (t.role !== 'owner') throw new HttpError(403, 'forbidden'); };

  app.get('/api/seller/billing', async (req) => {
    const t = await tenantCtx(req); viewOk(t);
    return withTx({ tenantId: t.tenantId, platform: true }, async c => {
      const sub = await lockSubscription(c, t.tenantId); const plans = await allPlans(c); const use = await usageOf(c, t.tenantId);
      const cur = plans.find(p => p.id === sub.plan_id)!; const pend = plans.find(p => p.id === sub.pending_plan_id);
      const provider = getBillingProvider(); const grace = await graceDays(c);
      const invoices = (await c.query(`SELECT id, description, amount_cents AS "amountCents", credit_cents AS "creditCents", currency, status, attempts, period_start AS "periodStart", period_end AS "periodEnd", failure_reason AS "failureReason", created_at AS "createdAt"
                                       FROM invoices WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 24`, [t.tenantId])).rows;
      return {
        provider: { name: provider?.name ?? 'none', simulated: provider?.status === 'simulated', configured: !!provider },
        plan: { code: cur.code, name: cur.name, priceMonthlyCents: cur.price_monthly_cents, priceAnnualCents: cur.price_annual_cents, transactionFeeBps: cur.transaction_fee_bps, limits: cur.limits, features: cur.features, currency: cur.currency },
        subscription: { status: sub.status, interval: sub.billing_interval, currentPeriodEnd: sub.current_period_end, trialEndsAt: sub.trial_ends_at, trialUsed: sub.trial_used,
          pendingPlan: pend?.code ?? null, pendingInterval: sub.pending_interval, cancelAtPeriodEnd: sub.cancel_at_period_end, pastDueSince: sub.past_due_since,
          graceEndsAt: sub.past_due_since ? new Date(new Date(sub.past_due_since).getTime() + grace * 86_400_000) : null, managedByStaff: sub.provider === 'manual' },
        usage: use,
        plans: plans.filter(selfServe).map(p => ({ code: p.code, name: p.name, priceMonthlyCents: p.price_monthly_cents, priceAnnualCents: p.price_annual_cents, transactionFeeBps: p.transaction_fee_bps, limits: p.limits, features: p.features, trialDays: p.trial_days,
          current: p.id === cur.id, trialAvailable: p.trial_days > 0 && !sub.trial_used && cur.price_monthly_cents === 0, exceeds: exceeds(p, use) })),
        invoices,
        note: 'Prices are shown without sales tax.',
      };
    });
  });

  app.post('/api/seller/billing/change', async (req) => {
    const t = await tenantCtx(req); ownerOnly(t);
    const b = z.object({ plan: z.string().max(40), interval: interval.default('monthly') }).strict().parse(req.body);
    return withTx({ tenantId: t.tenantId, platform: true }, c => changePlan(c, { tenantId: t.tenantId, actor: t.userId, planCode: b.plan, interval: b.interval, ip: req.ip }));
  });
  app.post('/api/seller/billing/cancel', async (req) => {
    const t = await tenantCtx(req); ownerOnly(t);
    return withTx({ tenantId: t.tenantId, platform: true }, c => changePlan(c, { tenantId: t.tenantId, actor: t.userId, planCode: 'starter', interval: 'monthly', ip: req.ip }));
  });
  /** Undo a scheduled downgrade or cancellation before it takes effect. */
  app.post('/api/seller/billing/resume', async (req) => {
    const t = await tenantCtx(req); ownerOnly(t);
    return withTx({ tenantId: t.tenantId, platform: true }, async c => {
      const sub = await lockSubscription(c, t.tenantId);
      if (!sub.pending_plan_id && !sub.cancel_at_period_end) throw new HttpError(409, 'nothing_scheduled');
      await c.query(`UPDATE subscriptions SET pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false, updated_at=now() WHERE tenant_id=$1`, [t.tenantId]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'billing.resume', entityType: 'subscription', entityId: t.tenantId, ip: req.ip });
      return { resumed: true };
    });
  });
  /** Retry an unpaid subscription right now (the job also retries daily). */
  app.post('/api/seller/billing/retry', async (req) => {
    const t = await tenantCtx(req); ownerOnly(t);
    const sub = await withTx({ tenantId: t.tenantId, platform: true }, async c => (await lockSubscription(c, t.tenantId)));
    if (sub.status !== 'past_due') throw new HttpError(409, 'nothing_to_retry');
    await withTx({ platform: true }, c => c.query(`UPDATE subscriptions SET last_attempt_at=NULL WHERE tenant_id=$1`, [t.tenantId]));
    await runBilling(new Date(), t.tenantId);
    const after = await withTx({ tenantId: t.tenantId }, c => c.query('SELECT status FROM subscriptions WHERE tenant_id=$1', [t.tenantId]));
    return { status: after.rows[0].status };
  });

  // ---------------- Staff ----------------
  app.get('/api/admin/billing', async (req) => {
    await platformPerm(req, 'sellers.read');
    return withTx({ platform: true }, async c => {
      const byPlan = (await c.query(`SELECT p.code, p.name, count(*)::int AS tenants, count(*) FILTER (WHERE s.status='trialing')::int AS trialing, count(*) FILTER (WHERE s.status='past_due')::int AS "pastDue",
                                            coalesce(sum(CASE WHEN s.status='active' AND s.provider<>'manual' THEN (CASE WHEN s.billing_interval='annual' THEN p.price_annual_cents/12.0 ELSE p.price_monthly_cents END) END),0)::int AS "mrrCents"
                                     FROM subscriptions s JOIN plans p ON p.id=s.plan_id GROUP BY p.code, p.name, p.sort_order ORDER BY p.sort_order`)).rows;
      const paid = (await c.query(`SELECT coalesce(sum(amount_cents),0)::int AS total, count(*)::int AS n FROM invoices WHERE status='paid'`)).rows[0];
      const pastDue = (await c.query(`SELECT s.tenant_id AS "tenantId", st.slug AS "storeSlug", p.name AS plan, s.past_due_since AS "pastDueSince", s.last_attempt_at AS "lastAttemptAt"
                                      FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN stores st ON st.tenant_id=s.tenant_id WHERE s.status='past_due' ORDER BY s.past_due_since LIMIT 100`)).rows;
      const provider = getBillingProvider();
      return { provider: { name: provider?.name ?? 'none', simulated: provider?.status === 'simulated' }, byPlan, mrrCents: byPlan.reduce((n, r) => n + r.mrrCents, 0), invoicedCents: paid.total, invoices: paid.n, pastDue,
               note: 'Recurring revenue is an estimate from current subscriptions. With the simulated provider no money was collected.' };
    });
  });
  /** Run the billing job now. The clock can only be moved when the simulated provider is on, so it can never be used to skip real charges. */
  app.post('/api/admin/billing/run', async (req) => {
    await platformPerm(req, 'plans.write');
    const b = z.object({ now: z.string().datetime().optional(), tenantId: z.string().uuid().optional() }).strict().parse(req.body ?? {});
    if (b.now && getBillingProvider()?.status !== 'simulated') throw new HttpError(403, 'now_override_forbidden');
    const result = await runBilling(b.now ? new Date(b.now) : new Date(), b.tenantId);
    await withTx({ platform: true }, c => audit(c, { actor: req.user!.id, action: 'billing.run', entityType: 'platform', entityId: 'billing', next: { ...result, now: b.now ?? null, tenantId: b.tenantId ?? null }, ip: req.ip }));
    return result;
  });
  /** Simulated provider only: make a business's pretend card decline (or approve) to exercise the failed-payment path. */
  app.post('/api/admin/billing/:tenantId/simulate-card', async (req) => {
    await platformPerm(req, 'plans.write');
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params); const b = z.object({ card: z.enum(['ok', 'declined']) }).strict().parse(req.body);
    if (getBillingProvider()?.status !== 'simulated') throw new HttpError(404, 'not_found');
    return withTx({ platform: true }, async c => {
      await lockSubscription(c, tenantId); await c.query('UPDATE subscriptions SET sim_card=$2 WHERE tenant_id=$1', [tenantId, b.card]);
      await audit(c, { actor: req.user!.id, tenantId, action: 'billing.simulate_card', entityType: 'subscription', entityId: tenantId, next: { card: b.card }, ip: req.ip });
      return { card: b.card };
    });
  });
  /** Staff-arranged plan (enterprise contracts, goodwill upgrades). Not charged by the platform; the seller cannot self-serve change it. */
  app.post('/api/admin/sellers/:id/plan', async (req) => {
    await platformPerm(req, 'plans.write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ plan: z.string().max(40), reason: z.string().trim().min(5).max(500), managed: z.boolean().default(true) }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      const plans = await allPlans(c); const target = plans.find(p => p.code === b.plan); if (!target) throw new HttpError(404, 'plan_not_found');
      if (!(await c.query('SELECT 1 FROM tenants WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'not_found');
      const sub = await lockSubscription(c, id); const prev = plans.find(p => p.id === sub.plan_id)!;
      await c.query('UPDATE tenants SET plan_id=$2 WHERE id=$1', [id, target.id]);
      await c.query(`UPDATE subscriptions SET plan_id=$2, billing_interval='monthly', status='active', trial_ends_at=NULL, past_due_since=NULL, pending_plan_id=NULL, pending_interval=NULL, cancel_at_period_end=false,
                       provider=CASE WHEN $3 THEN 'manual' ELSE 'none' END, current_period_start=now(), current_period_end=now()+interval '1 month', updated_at=now() WHERE tenant_id=$1`, [id, target.id, b.managed]);
      await audit(c, { actor: req.user!.id, tenantId: id, action: 'billing.staff_set_plan', entityType: 'subscription', entityId: id, prev: { plan: prev.code }, next: { plan: target.code, managed: b.managed }, reason: b.reason, ip: req.ip });
      return { plan: target.code, price: priceOf(target, 'monthly') };
    });
  });
}
