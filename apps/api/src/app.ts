import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { config, allowedOrigins, requireVerifiedEmail, requireStaffMfa, requireTerms, TERMS_VERSION } from './config.js';
import { withTx, audit } from './lib/db.js';
import { hashPassword, verifyPassword, newToken, sha256 } from './lib/security.js';

const COOKIE = 'eazy_sid';
declare module 'fastify' { interface FastifyRequest { user?: { id: string; email: string; fullName: string; sid: string; mfaAt: Date | null; mfaEnabledAt: Date | null; emailVerified: boolean; termsAccepted: boolean } } }

import { HttpError } from './lib/errors.js';
import { registerCommerce } from './modules/commerce.js';
import { registerImport } from './modules/import.js';
import { registerMarketplace } from './modules/marketplace.js';
import { registerRefunds } from './modules/refunds.js';
import { registerShare } from './modules/share.js';
import { registerAccount, createMfaChallenge } from './modules/account.js';
import { registerGovernance } from './modules/governance.js';
import { registerPricing } from './modules/pricing.js';
import { registerPos } from './modules/pos.js';
import { registerCustomers } from './modules/customers.js';
import { registerBilling } from './modules/billing.js';
import { registerAssist } from './modules/assist.js';
import { registerAi } from './modules/ai.js';
import { registerProfit } from './modules/profit.js';
import { issueToken } from './lib/tokens.js';
import { enqueue, url as mailUrl } from './lib/mail.js';
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const signupSchema = z.object({
  email: z.string().email().max(254), password: z.string().min(10).max(200), fullName: z.string().trim().min(1).max(120),
  businessName: z.string().trim().min(1).max(120), storeSlug: z.string().regex(SLUG),
  legalType: z.enum(['individual','sole_proprietorship','registered_business','partnership','creator']).default('individual'),
  acceptTerms: z.boolean().optional(),
});
const businessPatch = z.object({
  description: z.string().max(2000), category: z.string().max(80), contactEmail: z.string().email(),
  contactPhone: z.string().max(40), city: z.string().max(80), region: z.string().max(80), country: z.string().length(2),
  currency: z.string().length(3), registrationNumber: z.string().max(80),
  fulfilment: z.object({ pickup: z.boolean(), delivery: z.boolean(), shipping: z.boolean() }),
  social: z.record(z.string(), z.string().url()),
  onboardingStep: z.enum(['business','location','fulfilment','products','review']),
  taxFederal: z.boolean(), taxProvincial: z.array(z.string().length(2).toUpperCase()).max(13), taxNumber: z.string().trim().max(40),
}).partial().strict();

export async function buildApp() {
  const app = Fastify({
    // Structured JSON logs in production, with cookies and auth headers redacted so sessions never reach log storage.
    logger: process.env.NODE_ENV === 'production' ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] } : false,
    bodyLimit: 3_000_000,
    trustProxy: process.env.TRUST_PROXY === 'true',   // set when behind a load balancer so rate limits see real client addresses
  });
  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation_failed', issues: err.issues });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error(err);
    return reply.code(500).send({ error: 'internal_error' });
  });

  // CSRF: cookie auth + SameSite=Lax + require JSON content type and same-origin Origin on mutations.
  app.addHook('onRequest', async (req) => {
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host && !allowedOrigins.includes(origin)) throw new HttpError(403, 'cross_origin_blocked');
    }
  });

  async function authenticate(req: FastifyRequest) {
    const raw = req.cookies[COOKIE];
    if (!raw) throw new HttpError(401, 'unauthenticated');
    const u = await withTx({ platform: true }, async c => (await c.query(
      `SELECT u.id,u.email,u.full_name,s.id AS sid,s.mfa_at,u.mfa_enabled_at,u.email_verified_at,u.terms_accepted_at FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`, [sha256(raw)])).rows[0]);
    if (!u) throw new HttpError(401, 'unauthenticated');
    req.user = { id: u.id, email: u.email, fullName: u.full_name, sid: u.sid, mfaAt: u.mfa_at, mfaEnabledAt: u.mfa_enabled_at, emailVerified: !!u.email_verified_at, termsAccepted: !!u.terms_accepted_at };
  }

  /** Resolve membership for the tenant selected by the session user (never trusting a client tenant id). */
  async function tenantCtx(req: FastifyRequest) {
    await authenticate(req);
    const m = await withTx({ userId: req.user!.id }, async c => (await c.query(
      `SELECT tenant_id, role FROM memberships WHERE user_id=$1 ORDER BY created_at LIMIT 1`, [req.user!.id])).rows[0]);
    if (!m) throw new HttpError(403, 'no_business');
    return { tenantId: m.tenant_id as string, role: m.role as string, userId: req.user!.id };
  }

  async function platformPerm(req: FastifyRequest, perm: string) {
    await authenticate(req);
    const ok = await withTx({ platform: true }, async c => (await c.query(
      `SELECT 1 FROM platform_staff ps JOIN platform_role_permissions p ON p.role_key=ps.role_key
       WHERE ps.user_id=$1 AND p.permission=$2`, [req.user!.id, perm])).rowCount);
    if (!ok) throw new HttpError(403, 'forbidden');
    if (requireStaffMfa()) {   // staff can change fees and suspend sellers: a password alone is not enough
      if (!req.user!.mfaEnabledAt) throw new HttpError(403, 'mfa_setup_required');
      if (!req.user!.mfaAt) throw new HttpError(403, 'mfa_required');
    }
  }

  const setSession = async (reply: FastifyReply, userId: string, mfa = false) => {
    const token = newToken();
    await withTx({ platform: true }, c => c.query(
      `INSERT INTO sessions(user_id,token_hash,expires_at,mfa_at) VALUES ($1,$2,now()+($3||' hours')::interval, CASE WHEN $4 THEN now() END)`,
      [userId, sha256(token), String(config.sessionTtlHours), mfa]));
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: config.sessionTtlHours * 3600 });
  };

  app.get('/health', async () => ({ ok: true }));                       // process is up
  app.get('/ready', async (_req, reply) => {                             // process can serve traffic: database reachable
    try { await withTx({}, c => c.query('SELECT 1')); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  // ---- Seller signup: user + tenant + business + draft store in one transaction ----
  app.post('/api/auth/signup', { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = signupSchema.parse(req.body);
    if (b.storeSlug.includes('--')) throw new HttpError(400, 'invalid_slug');
    const pwHash = await hashPassword(b.password);
    const out = await withTx({ signup: true, platform: true }, async c => {
      const reserved = await c.query('SELECT 1 FROM reserved_slugs WHERE slug=$1', [b.storeSlug]);
      if (reserved.rowCount) throw new HttpError(409, 'slug_unavailable');
      const dupe = await c.query('SELECT 1 FROM users WHERE email=$1', [b.email]);
      if (dupe.rowCount) throw new HttpError(409, 'email_in_use');
      const slugTaken = await c.query('SELECT 1 FROM stores WHERE slug=$1', [b.storeSlug]);
      if (slugTaken.rowCount) throw new HttpError(409, 'slug_unavailable');
      const user = (await c.query('INSERT INTO users(email,password_hash,full_name,terms_accepted_at,terms_version) VALUES ($1,$2,$3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN $5 END) RETURNING id', [b.email, pwHash, b.fullName, !!b.acceptTerms, TERMS_VERSION])).rows[0];
      const plan = (await c.query(`SELECT id FROM plans WHERE code='starter'`)).rows[0];
      const t = (await c.query('INSERT INTO tenants(plan_id) VALUES ($1) RETURNING id', [plan.id])).rows[0];
      await c.query(`INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'owner')`, [t.id, user.id]);
      await c.query(`INSERT INTO subscriptions(tenant_id, plan_id, provider) VALUES ($1,$2,'none')`, [t.id, plan.id]);
      await c.query('INSERT INTO businesses(tenant_id,legal_type,business_name,contact_email) VALUES ($1,$2,$3,$4)', [t.id, b.legalType, b.businessName, b.email]);
      await c.query('INSERT INTO stores(tenant_id,slug,name) VALUES ($1,$2,$3)', [t.id, b.storeSlug, b.businessName]);
      await audit(c, { actor: user.id, tenantId: t.id, action: 'seller.signup', entityType: 'tenant', entityId: t.id, ip: req.ip });
      const vtoken = await issueToken(c, user.id, 'verify', 60 * 24);
      await enqueue(c, { tenantId: t.id, to: b.email, template: 'verify_email', data: { url: mailUrl(`/verify?token=${vtoken}`) } });
      return { userId: user.id as string, tenantId: t.id as string };
    });
    await setSession(reply, out.userId);
    return reply.code(201).send({ tenantId: out.tenantId });
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const u = await withTx({ platform: true }, async c => (await c.query('SELECT * FROM users WHERE email=$1', [b.email])).rows[0]);
    const deny = () => { throw new HttpError(401, 'invalid_credentials'); };
    if (!u || u.disabled_at) { await hashPassword(b.password); return deny(); } // equalise timing
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(429, 'account_temporarily_locked');
    if (!(await verifyPassword(b.password, u.password_hash))) {
      await withTx({ platform: true }, c => c.query(
        `UPDATE users SET failed_logins=failed_logins+1,
           locked_until=CASE WHEN failed_logins+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1`, [u.id]));
      return deny();
    }
    await withTx({ platform: true }, c => c.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]));
    if (u.mfa_enabled_at) return { mfaRequired: true, challenge: await createMfaChallenge(u.id) };   // no session until the code is verified
    await setSession(reply, u.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) await withTx({ platform: true }, c => c.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(raw)]));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => { await authenticate(req); const u = req.user!; return { id: u.id, email: u.email, fullName: u.fullName, emailVerified: u.emailVerified, termsAccepted: u.termsAccepted, mfaEnabled: !!u.mfaEnabledAt }; });

  registerAccount(app, { authenticate, createSession: async (reply, userId, mfa) => { await setSession(reply, userId, mfa); } });
  registerGovernance(app, { tenantCtx, platformPerm, authenticate });
  registerPricing(app, { tenantCtx });
  registerPos(app, { tenantCtx });

  // ---- Seller: business & onboarding (tenant resolved server-side; RLS enforces isolation) ----
  app.get('/api/seller/business', async (req) => {
    const t = await tenantCtx(req);
    return withTx(t, async c => {
      const biz = (await c.query('SELECT * FROM businesses').then(r => r.rows[0]));
      // Explicit tenant filter is required: the public RLS policy also exposes other tenants' published stores.
      const store = (await c.query('SELECT id,slug,name,tagline,status,published_at,delivery_fee_cents,theme,review_note FROM stores WHERE tenant_id=$1', [t.tenantId]).then(r => r.rows[0]));
      return { business: biz, store, role: t.role };
    });
  });

  app.patch('/api/seller/business', async (req) => {
    const t = await tenantCtx(req);
    if (!['owner','manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const p = businessPatch.parse(req.body);
    const cols: Record<string,string> = { description:'description', category:'category', contactEmail:'contact_email', contactPhone:'contact_phone',
      city:'city', region:'region', country:'country', currency:'currency', registrationNumber:'registration_number',
      fulfilment:'fulfilment', social:'social', onboardingStep:'onboarding_step', taxFederal:'tax_federal', taxProvincial:'tax_provincial', taxNumber:'tax_number' };
    const keys = Object.keys(p) as (keyof typeof p)[];
    if (!keys.length) throw new HttpError(400, 'nothing_to_update');
    return withTx(t, async c => {
      const prev = (await c.query('SELECT * FROM businesses').then(r => r.rows[0]));
      const sets = keys.map((k, i) => `${cols[k]}=$${i + 1}`);
      const vals = keys.map(k => (typeof p[k] === 'object' && !Array.isArray(p[k]) ? JSON.stringify(p[k]) : p[k]));
      const row = (await c.query(`UPDATE businesses SET ${sets.join(',')}, updated_at=now() WHERE tenant_id=$${keys.length + 1} RETURNING *`, [...vals, t.tenantId])).rows[0];
      // Tax settings only make sense with a province whose rates we know; provincial registrations must name a province that has a provincial tax.
      if (row.tax_federal || row.tax_provincial.length) {
        const reg = String(row.region ?? '').toUpperCase();
        if (!(await c.query(`SELECT 1 FROM tax_rates WHERE country='CA' AND region=$1`, [reg])).rowCount) throw new HttpError(422, 'tax_needs_province');
        for (const code of row.tax_provincial) {
          const ok = (await c.query(`SELECT 1 FROM tax_rates WHERE country='CA' AND region=$1 AND components @> '[{"kind":"provincial"}]'::jsonb`, [code])).rowCount;
          if (!ok) throw new HttpError(422, `no_provincial_tax:${code}`);
        }
      }
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'business.update', entityType: 'business', entityId: t.tenantId, prev, next: row });
      return row;
    });
  });

  app.patch('/api/seller/store', async (req) => {
    const t = await tenantCtx(req);
    if (!['owner','manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const b = z.object({ name: z.string().trim().min(1).max(120), tagline: z.string().max(200),
      deliveryFeeCents: z.number().int().min(0).max(100000),
      theme: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/), hero: z.enum(['light', 'dark']), layout: z.enum(['grid', 'spacious']) }).partial().strict() }).partial().strict().parse(req.body);
    return withTx(t, async c => {
      const prev = (await c.query('SELECT name,tagline,delivery_fee_cents,theme FROM stores WHERE tenant_id=$1', [t.tenantId])).rows[0];
      const row = (await c.query(
        `UPDATE stores SET name=coalesce($2,name), tagline=coalesce($3,tagline), delivery_fee_cents=coalesce($4,delivery_fee_cents),
           theme = CASE WHEN $5::jsonb IS NULL THEN theme ELSE theme || $5::jsonb END
         WHERE tenant_id=$1 RETURNING id,slug,name,tagline,status,delivery_fee_cents,theme`,
        [t.tenantId, b.name ?? null, b.tagline ?? null, b.deliveryFeeCents ?? null, b.theme ? JSON.stringify(b.theme) : null])).rows[0];
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'store.update', entityType: 'store', entityId: row.id, prev, next: row });
      return row;
    });
  });

  app.post('/api/seller/store/publish', async (req) => {
    const t = await tenantCtx(req);
    if (t.role !== 'owner') throw new HttpError(403, 'forbidden');
    return withTx(t, async c => {
      const tenant = (await c.query('SELECT status FROM tenants').then(r => r.rows[0]));
      if (tenant.status !== 'active') throw new HttpError(403, 'tenant_suspended');
      const me = (await c.query('SELECT email_verified_at, terms_accepted_at FROM users WHERE id=$1', [t.userId])).rows[0];
      if (requireVerifiedEmail() && !me?.email_verified_at) throw new HttpError(403, 'email_not_verified');
      if (requireTerms() && !me?.terms_accepted_at) throw new HttpError(403, 'terms_not_accepted');
      const biz = (await c.query('SELECT * FROM businesses').then(r => r.rows[0]));
      const missing = [!biz.category && 'category', !biz.description && 'description', !biz.contact_email && 'contact_email'].filter(Boolean);
      if (missing.length) throw new HttpError(422, `incomplete_profile:${missing.join(',')}`);
      // When the platform requires review, a new store waits for staff approval instead of going live; an already live store stays live.
      const target = (await c.query(`SELECT value FROM platform_settings WHERE key='store_review_required'`)).rows[0]?.value === true ? 'pending_review' : 'published';
      const s = (await c.query(`UPDATE stores SET status = CASE WHEN status='published' THEN 'published' ELSE $2 END,
                                  published_at = CASE WHEN $2='published' THEN coalesce(published_at,now()) ELSE published_at END,
                                  submitted_at = CASE WHEN $2='pending_review' AND status<>'published' THEN now() ELSE submitted_at END, review_note=NULL
                                WHERE tenant_id=$1 AND status<>'suspended' RETURNING id,slug,status`, [t.tenantId, target])).rows[0];
      if (!s) throw new HttpError(409, 'store_suspended');
      await c.query('UPDATE businesses SET onboarding_completed_at=coalesce(onboarding_completed_at,now()) WHERE tenant_id=$1', [t.tenantId]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'store.publish', entityType: 'store', entityId: s.id });
      return s;
    });
  });

  // ---- Public storefront lookup (RLS 'stores_public' only exposes published stores) ----
  app.get('/api/public/stores/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    const s = await withTx({}, async c => (await c.query('SELECT tenant_id,slug,name,tagline,published_at,delivery_fee_cents,theme FROM stores WHERE slug=$1', [slug])).rows[0]);
    if (!s) throw new HttpError(404, 'not_found');
    // Tenant context derived from the store row (never client input) to read the offered fulfilment options.
    const f = await withTx({ tenantId: s.tenant_id }, async c => (await c.query('SELECT fulfilment, currency, category, city, region, verification_status, (tax_federal OR cardinality(tax_provincial) > 0) AS taxes, EXISTS (SELECT 1 FROM shipping_rules sr WHERE sr.tenant_id=$1) AS has_rules FROM businesses WHERE tenant_id=$1', [s.tenant_id])).rows[0]);
    return { slug: s.slug, name: s.name, tagline: s.tagline, published_at: s.published_at, deliveryFeeCents: s.delivery_fee_cents, theme: s.theme, category: f.category, city: f.city, region: f.region, chargesTax: f.taxes, shippingRules: f.has_rules, verified: f.verification_status === 'verified',
             fulfilment: { pickup: !!f.fulfilment?.pickup, delivery: !!f.fulfilment?.delivery }, currency: f.currency };
  });

  // ---- Admin foundation ----
  app.get('/api/admin/sellers', async (req) => {
    await platformPerm(req, 'sellers.read');
    const { limit, offset, q } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0), q: z.string().trim().max(80).optional() }).parse(req.query);
    const like = q ? `%${q.replace(/[\\%_]/g, c => '\\' + c)}%` : null;
    return withTx({ platform: true }, async c => (await c.query(
      `SELECT t.id, t.status, t.suspended_reason, b.business_name, b.category, b.verification_status, s.slug, s.status AS store_status, t.created_at,
              (SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t.id AND m.role='owner' LIMIT 1) AS owner_email,
              (SELECT count(*)::int FROM products p WHERE p.tenant_id=t.id AND p.status='active') AS active_products,
              (SELECT count(*)::int FROM orders o WHERE o.tenant_id=t.id AND o.status IN ('paid','processing','ready','shipped','completed')) AS paid_orders
       FROM tenants t JOIN businesses b ON b.tenant_id=t.id LEFT JOIN stores s ON s.tenant_id=t.id
       WHERE ($3::text IS NULL OR b.business_name ILIKE $3 ESCAPE '\\' OR s.slug ILIKE $3 ESCAPE '\\')
       ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset, like])).rows);
  });

  app.post('/api/admin/sellers/:id/suspend', async (req) => {
    await platformPerm(req, 'sellers.suspend');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body); // reason mandatory for sensitive actions
    return withTx({ platform: true }, async c => {
      const prev = (await c.query('SELECT status FROM tenants WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!prev) throw new HttpError(404, 'not_found');
      await c.query(`UPDATE tenants SET status='suspended', suspended_reason=$2 WHERE id=$1`, [id, reason]);
      await c.query(`UPDATE stores SET status='suspended' WHERE tenant_id=$1`, [id]);
      await audit(c, { actor: req.user!.id, tenantId: id, action: 'seller.suspend', entityType: 'tenant', entityId: id, prev, next: { status: 'suspended' }, reason, ip: req.ip });
      return { ok: true };
    });
  });

  app.post('/api/admin/sellers/:id/reinstate', async (req) => {
    await platformPerm(req, 'sellers.suspend');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    return withTx({ platform: true }, async c => {
      const r = await c.query(`UPDATE tenants SET status='active', suspended_reason=NULL WHERE id=$1 AND status='suspended' RETURNING id`, [id]);
      if (!r.rowCount) throw new HttpError(404, 'not_suspended');
      // Stores return to draft; owner must republish (conservative).
      await c.query(`UPDATE stores SET status='draft' WHERE tenant_id=$1 AND status='suspended'`, [id]);
      await audit(c, { actor: req.user!.id, tenantId: id, action: 'seller.reinstate', entityType: 'tenant', entityId: id, prev: { status: 'suspended' }, next: { status: 'active' }, reason, ip: req.ip });
      return { ok: true };
    });
  });

  app.get('/api/admin/me', async (req) => {
    await authenticate(req);
    const r = await withTx({ platform: true }, async c => (await c.query(
      `SELECT ps.role_key AS role, coalesce(array_agg(p.permission ORDER BY p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
       FROM platform_staff ps LEFT JOIN platform_role_permissions p ON p.role_key=ps.role_key WHERE ps.user_id=$1 GROUP BY ps.role_key`, [req.user!.id])).rows[0]);
    if (!r) throw new HttpError(403, 'forbidden');
    const mfaOk = !requireStaffMfa() || (!!req.user!.mfaEnabledAt && !!req.user!.mfaAt);
    return { role: r.role, email: req.user!.email, permissions: mfaOk ? r.permissions : [], mfaEnabled: !!req.user!.mfaEnabledAt, mfaSatisfied: mfaOk };
  });

  app.get('/api/admin/overview', async (req) => {
    await platformPerm(req, 'sellers.read');
    return withTx({ platform: true }, async c => {
      const n = async (sql: string) => Number((await c.query(sql)).rows[0].n);
      const counted = `status IN ('paid','processing','ready','shipped','completed')`;
      return {
        sellers: { total: await n('SELECT count(*) n FROM tenants'), active: await n(`SELECT count(*) n FROM tenants WHERE status='active'`), suspended: await n(`SELECT count(*) n FROM tenants WHERE status='suspended'`) },
        publishedStores: await n(`SELECT count(*) n FROM stores WHERE status='published'`), activeProducts: await n(`SELECT count(*) n FROM products WHERE status='active'`),
        paidOrders: await n(`SELECT count(*) n FROM orders WHERE ${counted}`), gmvCents: await n(`SELECT coalesce(sum(total_cents),0) n FROM orders WHERE ${counted}`),
        platformFeesCents: await n(`SELECT coalesce(-sum(amount_cents) FILTER (WHERE account='platform_fee'),0) n FROM ledger_entries`),
        refundsCents: await n('SELECT coalesce(sum(amount_cents),0) n FROM refunds'),
        subscriptionRevenueCents: await n(`SELECT coalesce(sum(amount_cents),0) n FROM invoices WHERE status='paid'`),
        payingSubscriptions: await n(`SELECT count(*) n FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status='active' AND s.provider<>'manual' AND p.price_monthly_cents>0`),
        pastDueSubscriptions: await n(`SELECT count(*) n FROM subscriptions WHERE status='past_due'`),
        unresolvedUnfulfilledPayments: await n('SELECT count(*) n FROM payments WHERE needs_refund AND refund_resolved_at IS NULL'),
        note: 'Figures are in each seller\'s currency summed as-is; all current stores use CAD.',
      };
    });
  });

  app.get('/api/admin/plans', async (req) => {
    await platformPerm(req, 'sellers.read');
    return withTx({ platform: true }, async c => (await c.query('SELECT code,name,price_monthly_cents,price_annual_cents,transaction_fee_bps,limits,features,trial_days,sort_order FROM plans ORDER BY sort_order, code')).rows);
  });

  // Featured maker on the marketplace home: an editorial choice, never purchasable by plan.
  app.get('/api/admin/featured', async (req) => {
    await platformPerm(req, 'sellers.read');
    return withTx({ platform: true }, async c => ({ slug: (await c.query(`SELECT value->>'slug' AS slug FROM platform_settings WHERE key='featured_store'`)).rows[0]?.slug ?? null }));
  });
  app.put('/api/admin/featured', async (req) => {
    await platformPerm(req, 'settings.write');
    const b = z.object({ slug: z.string().regex(SLUG).nullable(), reason: z.string().trim().min(5).max(300) }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      if (b.slug) { const ok = (await c.query(`SELECT 1 FROM stores s JOIN tenants t ON t.id=s.tenant_id WHERE s.slug=$1 AND s.status='published' AND t.status='active'`, [b.slug])).rowCount;
        if (!ok) throw new HttpError(422, 'store_not_publishable'); }
      const prev = (await c.query(`SELECT value FROM platform_settings WHERE key='featured_store'`)).rows[0]?.value ?? null;
      if (b.slug) await c.query(`INSERT INTO platform_settings(key,value) VALUES ('featured_store',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify({ slug: b.slug })]);
      else await c.query(`DELETE FROM platform_settings WHERE key='featured_store'`);
      await audit(c, { actor: req.user!.id, action: 'marketplace.featured', entityType: 'setting', entityId: 'featured_store', prev, next: b.slug ? { slug: b.slug } : null, reason: b.reason, ip: req.ip });
      return { slug: b.slug };
    });
  });

  app.get('/api/admin/tax-rates', async (req) => {
    await platformPerm(req, 'sellers.read');
    return withTx({ platform: true }, async c => (await c.query(`SELECT country, region, name, components, notes, updated_at FROM tax_rates ORDER BY country, region`)).rows);
  });

  // Tax rates are data. Every change needs a reason and records the old and new values.
  app.patch('/api/admin/tax-rates/:country/:region', async (req) => {
    await platformPerm(req, 'tax.write');
    const { country, region } = z.object({ country: z.string().length(2), region: z.string().min(1).max(10) }).parse(req.params);
    const b = z.object({ reason: z.string().trim().min(5).max(300), components: z.array(z.object({
      name: z.string().trim().min(1).max(20), kind: z.enum(['federal', 'provincial']), ppm: z.number().int().min(0).max(300000) }).strict()).min(1).max(4) }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      const prev = (await c.query('SELECT * FROM tax_rates WHERE country=$1 AND region=$2 FOR UPDATE', [country.toUpperCase(), region.toUpperCase()])).rows[0];
      if (!prev) throw new HttpError(404, 'not_found');
      const row = (await c.query(`UPDATE tax_rates SET components=$3, notes=NULL, updated_at=now() WHERE country=$1 AND region=$2 RETURNING *`,
        [country.toUpperCase(), region.toUpperCase(), JSON.stringify(b.components)])).rows[0];
      await audit(c, { actor: req.user!.id, action: 'tax_rate.update', entityType: 'tax_rate', entityId: `${row.country}-${row.region}`, prev: { components: prev.components }, next: { components: row.components }, reason: b.reason, ip: req.ip });
      return row;
    });
  });

  app.get('/api/admin/audit', async (req) => {
    await platformPerm(req, 'audit.read');
    return withTx({ platform: true }, async c => (await c.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100')).rows);
  });

  app.patch('/api/admin/plans/:code', async (req) => {
    await platformPerm(req, 'plans.write');
    const { code } = z.object({ code: z.string().max(40) }).parse(req.params);
    const b = z.object({ reason: z.string().trim().min(5), priceMonthlyCents: z.number().int().min(0).optional(),
      priceAnnualCents: z.number().int().min(0).optional(), transactionFeeBps: z.number().int().min(0).max(10000).optional(),
      limits: z.record(z.string(), z.number().nullable()).optional(), features: z.record(z.string(), z.boolean()).optional(), trialDays: z.number().int().min(0).max(90).optional() }).parse(req.body);
    return withTx({ platform: true }, async c => {
      const prev = (await c.query('SELECT * FROM plans WHERE code=$1 FOR UPDATE', [code])).rows[0];
      if (!prev) throw new HttpError(404, 'not_found');
      const row = (await c.query(
        `UPDATE plans SET price_monthly_cents=coalesce($2,price_monthly_cents), price_annual_cents=coalesce($3,price_annual_cents),
           transaction_fee_bps=coalesce($4,transaction_fee_bps), limits=coalesce($5,limits), features=coalesce($6,features), trial_days=coalesce($7,trial_days) WHERE code=$1 RETURNING *`,
        [code, b.priceMonthlyCents ?? null, b.priceAnnualCents ?? null, b.transactionFeeBps ?? null, b.limits ? JSON.stringify(b.limits) : null, b.features ? JSON.stringify(b.features) : null, b.trialDays ?? null])).rows[0];
      await audit(c, { actor: req.user!.id, action: 'plan.update', entityType: 'plan', entityId: code, prev, next: row, reason: b.reason, ip: req.ip });
      return row;
    });
  });

  const optionalUserId = async (req: FastifyRequest) => { if (!req.cookies[COOKIE]) return null; try { await authenticate(req); return req.user!.id; } catch { return null; } };
  registerCommerce(app, { tenantCtx, optionalUserId });
  registerCustomers(app, { tenantCtx, authenticate, platformPerm, setSession });
  registerBilling(app, { tenantCtx, platformPerm });
  registerAssist(app, { tenantCtx });
  registerAi(app, { tenantCtx });
  registerProfit(app, { tenantCtx });
  registerImport(app, { tenantCtx });
  registerMarketplace(app);
  registerRefunds(app, { tenantCtx });
  registerShare(app, { tenantCtx });

  return app;
}
