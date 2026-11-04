import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { config, allowedOrigins } from './config.js';
import { withTx, audit } from './lib/db.js';
import { hashPassword, verifyPassword, newToken, sha256 } from './lib/security.js';

const COOKIE = 'eazy_sid';
declare module 'fastify' { interface FastifyRequest { user?: { id: string; email: string; fullName: string } } }

import { HttpError } from './lib/errors.js';
import { registerCommerce } from './modules/commerce.js';
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const signupSchema = z.object({
  email: z.string().email().max(254), password: z.string().min(10).max(200), fullName: z.string().trim().min(1).max(120),
  businessName: z.string().trim().min(1).max(120), storeSlug: z.string().regex(SLUG),
  legalType: z.enum(['individual','sole_proprietorship','registered_business','partnership','creator']).default('individual'),
});
const businessPatch = z.object({
  description: z.string().max(2000), category: z.string().max(80), contactEmail: z.string().email(),
  contactPhone: z.string().max(40), city: z.string().max(80), region: z.string().max(80), country: z.string().length(2),
  currency: z.string().length(3), registrationNumber: z.string().max(80),
  fulfilment: z.object({ pickup: z.boolean(), delivery: z.boolean(), shipping: z.boolean() }),
  social: z.record(z.string(), z.string().url()),
  onboardingStep: z.enum(['business','location','fulfilment','products','review']),
}).partial().strict();

export async function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
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
      `SELECT u.id,u.email,u.full_name FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`, [sha256(raw)])).rows[0]);
    if (!u) throw new HttpError(401, 'unauthenticated');
    req.user = { id: u.id, email: u.email, fullName: u.full_name };
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
  }

  const setSession = async (reply: FastifyReply, userId: string) => {
    const token = newToken();
    await withTx({ platform: true }, c => c.query(
      `INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+($3||' hours')::interval)`,
      [userId, sha256(token), String(config.sessionTtlHours)]));
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: config.sessionTtlHours * 3600 });
  };

  app.get('/health', async () => ({ ok: true }));

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
      const user = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) RETURNING id', [b.email, pwHash, b.fullName])).rows[0];
      const plan = (await c.query(`SELECT id FROM plans WHERE code='starter'`)).rows[0];
      const t = (await c.query('INSERT INTO tenants(plan_id) VALUES ($1) RETURNING id', [plan.id])).rows[0];
      await c.query(`INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'owner')`, [t.id, user.id]);
      await c.query('INSERT INTO businesses(tenant_id,legal_type,business_name,contact_email) VALUES ($1,$2,$3,$4)', [t.id, b.legalType, b.businessName, b.email]);
      await c.query('INSERT INTO stores(tenant_id,slug,name) VALUES ($1,$2,$3)', [t.id, b.storeSlug, b.businessName]);
      await audit(c, { actor: user.id, tenantId: t.id, action: 'seller.signup', entityType: 'tenant', entityId: t.id, ip: req.ip });
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
    await setSession(reply, u.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) await withTx({ platform: true }, c => c.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(raw)]));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => { await authenticate(req); return req.user; });

  // ---- Seller: business & onboarding (tenant resolved server-side; RLS enforces isolation) ----
  app.get('/api/seller/business', async (req) => {
    const t = await tenantCtx(req);
    return withTx(t, async c => {
      const biz = (await c.query('SELECT * FROM businesses').then(r => r.rows[0]));
      // Explicit tenant filter is required: the public RLS policy also exposes other tenants' published stores.
      const store = (await c.query('SELECT id,slug,name,tagline,status,published_at,delivery_fee_cents FROM stores WHERE tenant_id=$1', [t.tenantId]).then(r => r.rows[0]));
      return { business: biz, store, role: t.role };
    });
  });

  app.patch('/api/seller/business', async (req) => {
    const t = await tenantCtx(req);
    if (!['owner','manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const p = businessPatch.parse(req.body);
    const cols: Record<string,string> = { description:'description', category:'category', contactEmail:'contact_email', contactPhone:'contact_phone',
      city:'city', region:'region', country:'country', currency:'currency', registrationNumber:'registration_number',
      fulfilment:'fulfilment', social:'social', onboardingStep:'onboarding_step' };
    const keys = Object.keys(p) as (keyof typeof p)[];
    if (!keys.length) throw new HttpError(400, 'nothing_to_update');
    return withTx(t, async c => {
      const prev = (await c.query('SELECT * FROM businesses').then(r => r.rows[0]));
      const sets = keys.map((k, i) => `${cols[k]}=$${i + 1}`);
      const vals = keys.map(k => (typeof p[k] === 'object' ? JSON.stringify(p[k]) : p[k]));
      const row = (await c.query(`UPDATE businesses SET ${sets.join(',')}, updated_at=now() WHERE tenant_id=$${keys.length + 1} RETURNING *`, [...vals, t.tenantId])).rows[0];
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'business.update', entityType: 'business', entityId: t.tenantId, prev, next: row });
      return row;
    });
  });

  app.patch('/api/seller/store', async (req) => {
    const t = await tenantCtx(req);
    if (!['owner','manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const b = z.object({ name: z.string().trim().min(1).max(120), tagline: z.string().max(200),
      deliveryFeeCents: z.number().int().min(0).max(100000) }).partial().strict().parse(req.body);
    return withTx(t, async c => {
      const prev = (await c.query('SELECT name,tagline,delivery_fee_cents FROM stores WHERE tenant_id=$1', [t.tenantId])).rows[0];
      const row = (await c.query(
        `UPDATE stores SET name=coalesce($2,name), tagline=coalesce($3,tagline), delivery_fee_cents=coalesce($4,delivery_fee_cents)
         WHERE tenant_id=$1 RETURNING id,slug,name,tagline,status,delivery_fee_cents`,
        [t.tenantId, b.name ?? null, b.tagline ?? null, b.deliveryFeeCents ?? null])).rows[0];
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
      const biz = (await c.query('SELECT * FROM businesses').then(r => r.rows[0]));
      const missing = [!biz.category && 'category', !biz.description && 'description', !biz.contact_email && 'contact_email'].filter(Boolean);
      if (missing.length) throw new HttpError(422, `incomplete_profile:${missing.join(',')}`);
      const s = (await c.query(`UPDATE stores SET status='published', published_at=coalesce(published_at,now()) WHERE tenant_id=$1 AND status<>'suspended' RETURNING id,slug,status`, [t.tenantId])).rows[0];
      if (!s) throw new HttpError(409, 'store_suspended');
      await c.query('UPDATE businesses SET onboarding_completed_at=coalesce(onboarding_completed_at,now()) WHERE tenant_id=$1', [t.tenantId]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'store.publish', entityType: 'store', entityId: s.id });
      return s;
    });
  });

  // ---- Public storefront lookup (RLS 'stores_public' only exposes published stores) ----
  app.get('/api/public/stores/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    const s = await withTx({}, async c => (await c.query('SELECT tenant_id,slug,name,tagline,published_at,delivery_fee_cents FROM stores WHERE slug=$1', [slug])).rows[0]);
    if (!s) throw new HttpError(404, 'not_found');
    // Tenant context derived from the store row (never client input) to read the offered fulfilment options.
    const f = await withTx({ tenantId: s.tenant_id }, async c => (await c.query('SELECT fulfilment, currency FROM businesses WHERE tenant_id=$1', [s.tenant_id])).rows[0]);
    return { slug: s.slug, name: s.name, tagline: s.tagline, published_at: s.published_at, deliveryFeeCents: s.delivery_fee_cents,
             fulfilment: { pickup: !!f.fulfilment?.pickup, delivery: !!f.fulfilment?.delivery }, currency: f.currency };
  });

  // ---- Admin foundation ----
  app.get('/api/admin/sellers', async (req) => {
    await platformPerm(req, 'sellers.read');
    const { limit, offset } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return withTx({ platform: true }, async c => (await c.query(
      `SELECT t.id, t.status, b.business_name, b.verification_status, s.slug, s.status AS store_status, t.created_at
       FROM tenants t JOIN businesses b ON b.tenant_id=t.id LEFT JOIN stores s ON s.tenant_id=t.id
       ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset])).rows);
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

  app.get('/api/admin/audit', async (req) => {
    await platformPerm(req, 'audit.read');
    return withTx({ platform: true }, async c => (await c.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100')).rows);
  });

  app.patch('/api/admin/plans/:code', async (req) => {
    await platformPerm(req, 'plans.write');
    const { code } = z.object({ code: z.string().max(40) }).parse(req.params);
    const b = z.object({ reason: z.string().trim().min(5), priceMonthlyCents: z.number().int().min(0).optional(),
      priceAnnualCents: z.number().int().min(0).optional(), transactionFeeBps: z.number().int().min(0).max(10000).optional(),
      limits: z.record(z.string(), z.number().nullable()).optional() }).parse(req.body);
    return withTx({ platform: true }, async c => {
      const prev = (await c.query('SELECT * FROM plans WHERE code=$1 FOR UPDATE', [code])).rows[0];
      if (!prev) throw new HttpError(404, 'not_found');
      const row = (await c.query(
        `UPDATE plans SET price_monthly_cents=coalesce($2,price_monthly_cents), price_annual_cents=coalesce($3,price_annual_cents),
           transaction_fee_bps=coalesce($4,transaction_fee_bps), limits=coalesce($5,limits) WHERE code=$1 RETURNING *`,
        [code, b.priceMonthlyCents ?? null, b.priceAnnualCents ?? null, b.transactionFeeBps ?? null, b.limits ? JSON.stringify(b.limits) : null])).rows[0];
      await audit(c, { actor: req.user!.id, action: 'plan.update', entityType: 'plan', entityId: code, prev, next: row, reason: b.reason, ip: req.ip });
      return row;
    });
  });

  registerCommerce(app, { tenantCtx });

  return app;
}
