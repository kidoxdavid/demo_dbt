import { registerWeb, webDist } from './lib/web.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { errorFields, log, safePath } from './lib/log.js';
import { q } from './db.js';
import { HttpError } from './errors.js';
import { AREAS, AREA_ROLES, type Area, type RoleGrant } from './permissions.js';
import { cookieName } from './guards.js';
import { sha256 } from './security.js';
import { registerAuth } from './modules/auth.js';
import { registerAdmin } from './modules/admin.js';
import { registerPublicConfig } from './modules/publicConfig.js';
import { registerCategories } from './modules/categories.js';
import { registerCatalogue } from './modules/catalogue.js';
import { registerHome } from './modules/home.js';
import { registerSaved } from './modules/saved.js';
import { registerConsoles } from './modules/consoles.js';
import { registerEngagement } from './modules/engagement.js';
import { registerAds } from './modules/ads.js';
import { registerPromotions } from './modules/promotions.js';
import { registerRoles } from './modules/roles.js';
import { ensureRoleConfig } from './lib/roleConfig.js';
import { registerNotifications } from './modules/notifications.js';
import { registerPrivacy } from './modules/privacy.js';
import { registerStudioDashboard } from './modules/studioDashboard.js';
import { registerStudio } from './modules/studio.js';
import { registerStudioProducts } from './modules/studioProducts.js';
import { registerCart } from './modules/cart.js';
import { registerOrders } from './modules/orders.js';
import { registerStudioOrders } from './modules/studioOrders.js';


/** The window a request belongs to. API paths decide it (so a header can never turn a shop session into an admin one); only /api/auth/* reads the x-area header. */
export function areaOf(url: string, header?: string): Area {
  const m = /^\/api\/(admin|studio|support|finance|marketing)(\/|\?|$)/.exec(url); if (m) return m[1] as Area;
  return url.startsWith('/api/auth/') && header && (AREAS as string[]).includes(header) ? header as Area : 'shop';
}

export async function buildApp(opts: { authRateLimitMax?: number; webDir?: string | null } = {}) {
  // The built website is served by this service in production (or when a folder is given); in development the Vite server does that.
  const webDir = opts.webDir !== undefined ? opts.webDir : (config.production ? webDist() : null);
  const app = Fastify({ logger: false, genReqId: req => { const h = req.headers['x-request-id']; return typeof h === 'string' && /^[\w-]{8,64}$/.test(h) ? h : crypto.randomUUID(); }, trustProxy: process.env.TRUST_PROXY === 'true', bodyLimit: 1024 * 1024, routerOptions: { maxParamLength: 600 } });          // signed links (unsubscribe, order tokens) are longer than the default 100
  // Every route as registered, so tests can sweep all of them for authorisation, cross-site requests and server errors.
  const routeTable: { method: string; url: string }[] = []; app.addHook('onRoute', r => { for (const m of ([] as string[]).concat(r.method)) if (m !== 'HEAD' && m !== 'OPTIONS') routeTable.push({ method: m, url: r.url }); }); (app as any).routeTable = routeTable;
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], imgSrc: ["'self'"], mediaSrc: ["'self'"] } } });          // the API only returns data and media, never pages
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  // Keep the exact bytes of every JSON body: payment webhooks are signed over the raw text, not over a re-serialised copy.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => { (req as any).rawBody = body; try { if (/\\u0000/i.test(body as string)) throw Object.assign(new Error('invalid_characters'), { statusCode: 400 }); done(null, body ? JSON.parse(body as string) : {}); } catch (e: any) { e.statusCode = 400; done(e, undefined); } });          // a NUL character cannot be stored in text and used to crash queries
  (app as any).authLimit = { rateLimit: { max: opts.authRateLimitMax ?? config.authRateLimitMax, timeWindow: '1 minute' } };

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, ...(err.detail ? { detail: err.detail } : {}) });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation_failed', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'body_too_large' : err.message });
    log('error', 'request failed', { requestId: _req.id, method: _req.method, path: safePath(_req.url), ...errorFields(err) }); return reply.code(500).send({ error: 'internal_error', requestId: _req.id });
  });
  if (!webDir) app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  // A request id on every response (and in every error), and one access-log line per request: method, safe path, status, time. No query strings, no cookies, no tokens.
  app.addHook('onRequest', async (req, reply) => { reply.header('x-request-id', req.id); });
  app.addHook('onResponse', async (req, reply) => { log('info', 'request', { requestId: req.id, method: req.method, path: safePath(req.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime), area: req.area, user: req.user?.id }); });

  // CSRF: cookie auth + SameSite=Lax, and mutations must come from this host or an allowed origin.
  app.addHook('onRequest', async (req) => {
    if (/%00|\u0000/i.test(req.url)) throw new HttpError(400, 'invalid_characters');
    req.area = areaOf(req.url, req.headers['x-area'] as string | undefined);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin; if (origin) { let host = ''; try { host = new URL(origin).host; } catch { /* malformed */ }
        if (host !== req.headers.host && !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'cross_origin_blocked'); }
    }
  });
  // Load this window's session. Roles only count in a window they belong to, so a shop session never carries staff or seller power.
  app.addHook('preHandler', async (req) => {
    const raw = req.cookies[cookieName(req.area)]; if (!raw) return; await ensureRoleConfig();
    const s = (await q(`SELECT s.id AS sid, s.last_seen_at, u.id, u.email, u.full_name FROM sessions s JOIN users u ON u.id=s.user_id
                        WHERE s.token_hash=$1 AND s.area=$2 AND s.expires_at>now() AND u.status='active'`, [sha256(raw), req.area])).rows[0]; if (!s) return;
    const grants = (await q('SELECT id, role, seller_id FROM user_roles WHERE user_id=$1', [s.id])).rows.map(r => ({ id: r.id, role: r.role, sellerId: r.seller_id }) as RoleGrant);
    const roles = req.area === 'shop' ? [] : grants.filter(g => AREA_ROLES[req.area as Exclude<Area, 'shop'>].includes(g.role));
    req.user = { id: s.id, email: s.email, fullName: s.full_name, area: req.area, roles, sessionId: s.sid };
    if (Date.now() - new Date(s.last_seen_at).getTime() > 10 * 60_000) q('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [s.sid]).catch(() => {});
  });

  // Deny by default: anything under a staff, studio or "me" path needs a signed-in session for that window, whatever the handler does. Only these are open.
  const GATED = /^\/api\/(admin|studio|support|finance|marketing|me)(\/|$)/; const OPEN = new Set(['POST /api/studio/signup', 'GET /api/me/saved/ids']);
  app.addHook('preHandler', async (req) => { const path = req.url.split('?')[0]; if (GATED.test(path) && !req.user && !OPEN.has(`${req.method} ${path}`)) throw new HttpError(401, 'unauthenticated'); });

  app.get('/health', async () => ({ ok: true }));
  app.get('/healthz', async () => ({ ok: true }));                                                                       // liveness: the process is up
  app.get('/readyz', async (_req, reply) => { try { await q('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); } });          // readiness: the database answers
  registerAuth(app); registerPublicConfig(app); registerCategories(app); registerCatalogue(app); registerHome(app); registerSaved(app); registerStudio(app); registerStudioDashboard(app); registerStudioProducts(app); registerCart(app); registerOrders(app); registerStudioOrders(app); registerAdmin(app); registerConsoles(app); registerEngagement(app); registerAds(app); registerPromotions(app); registerRoles(app); registerNotifications(app); registerPrivacy(app);
  if (webDir) await registerWeb(app, webDir);
  return app;
}
