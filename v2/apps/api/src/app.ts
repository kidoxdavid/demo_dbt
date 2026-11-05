import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError } from './errors.js';
import { AREAS, AREA_ROLES, type Area, type RoleGrant } from './permissions.js';
import { cookieName } from './guards.js';
import { sha256 } from './security.js';
import { registerAuth } from './modules/auth.js';
import { registerAdmin } from './modules/admin.js';
import { registerPublicConfig } from './modules/publicConfig.js';
import { registerCategories } from './modules/categories.js';


/** The window a request belongs to. API paths decide it (so a header can never turn a shop session into an admin one); only /api/auth/* reads the x-area header. */
export function areaOf(url: string, header?: string): Area {
  const m = /^\/api\/(admin|studio|support|finance|marketing)(\/|\?|$)/.exec(url); if (m) return m[1] as Area;
  return url.startsWith('/api/auth/') && header && (AREAS as string[]).includes(header) ? header as Area : 'shop';
}

export async function buildApp(opts: { authRateLimitMax?: number } = {}) {
  const app = Fastify({ logger: false, trustProxy: process.env.TRUST_PROXY === 'true', bodyLimit: 1024 * 1024 });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  (app as any).authLimit = { rateLimit: { max: opts.authRateLimitMax ?? config.authRateLimitMax, timeWindow: '1 minute' } };

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, ...(err.detail ? { detail: err.detail } : {}) });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation_failed', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'body_too_large' : err.message });
    console.error(err); return reply.code(500).send({ error: 'internal_error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  // CSRF: cookie auth + SameSite=Lax, and mutations must come from this host or an allowed origin.
  app.addHook('onRequest', async (req) => {
    req.area = areaOf(req.url, req.headers['x-area'] as string | undefined);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin; if (origin) { let host = ''; try { host = new URL(origin).host; } catch { /* malformed */ }
        if (host !== req.headers.host && !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'cross_origin_blocked'); }
    }
  });
  // Load this window's session. Roles only count in a window they belong to, so a shop session never carries staff or seller power.
  app.addHook('preHandler', async (req) => {
    const raw = req.cookies[cookieName(req.area)]; if (!raw) return;
    const s = (await q(`SELECT s.id AS sid, s.last_seen_at, u.id, u.email, u.full_name FROM sessions s JOIN users u ON u.id=s.user_id
                        WHERE s.token_hash=$1 AND s.area=$2 AND s.expires_at>now() AND u.status='active'`, [sha256(raw), req.area])).rows[0]; if (!s) return;
    const grants = (await q('SELECT id, role, seller_id FROM user_roles WHERE user_id=$1', [s.id])).rows.map(r => ({ id: r.id, role: r.role, sellerId: r.seller_id }) as RoleGrant);
    const roles = req.area === 'shop' ? [] : grants.filter(g => AREA_ROLES[req.area as Exclude<Area, 'shop'>].includes(g.role));
    req.user = { id: s.id, email: s.email, fullName: s.full_name, area: req.area, roles, sessionId: s.sid };
    if (Date.now() - new Date(s.last_seen_at).getTime() > 10 * 60_000) q('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [s.sid]).catch(() => {});
  });

  app.get('/health', async () => ({ ok: true }));
  registerAuth(app); registerPublicConfig(app); registerCategories(app); registerAdmin(app);
  return app;
}
