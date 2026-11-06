import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, q, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { cookieName, requirePerm, requireUser } from '../guards.js';
import { SELLER_FLAGS, SELLER_FLAG_META, sellerFlags, type SellerFlagKey } from '../lib/sellerFlags.js';
import { newToken, sha256, verifyPassword } from '../security.js';
import { openSession } from '../session.js';
import { config } from '../config.js';

const idp = z.object({ id: z.string().uuid() });
const ACTING_HOURS = 2;

export function registerAdminControl(app: FastifyInstance) {
  // ---- switches for one maker
  app.get('/api/admin/sellers/:id/flags', async req => {
    requirePerm(req, 'sellers.read'); const { id } = idp.parse(req.params); if (!(await q('SELECT 1 FROM sellers WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'not_found');
    const on = await sellerFlags(id); return SELLER_FLAGS.map(key => ({ key, enabled: on[key], label: SELLER_FLAG_META[key].label, help: SELLER_FLAG_META[key].help }));
  });
  app.put('/api/admin/sellers/:id/flags/:key', async req => {
    const u = requirePerm(req, 'sellers.write'); const { id, key } = z.object({ id: z.string().uuid(), key: z.enum(SELLER_FLAGS as [SellerFlagKey, ...SellerFlagKey[]]) }).parse(req.params);
    const b = z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(300) }).strict().parse(req.body);
    if (!(await q('SELECT 1 FROM sellers WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'not_found');
    await tx(async c => {
      const prev = (await sellerFlags(id))[key];
      await c.query(`INSERT INTO seller_flags(seller_id,key,enabled,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (seller_id,key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_by=EXCLUDED.updated_by, updated_at=now()`, [id, key, b.enabled, u.id]);
      await audit(c, { actor: u.id, area: 'admin', action: `seller.flag.${key}`, entityType: 'seller', entityId: id, prev: { enabled: prev }, next: { enabled: b.enabled }, reason: b.reason, ip: req.ip });
    });
    return { key, enabled: b.enabled };
  });

  // ---- act as a maker: a time-limited studio session for the admin inside one maker's shop. Needs a reason and the admin's own password.
  app.post('/api/admin/sellers/:id/act-as', async (req, reply) => {
    const u = requirePerm(req, 'sellers.write'); const { id } = idp.parse(req.params); const b = z.object({ reason: z.string().trim().min(5).max(300), password: z.string().min(1).max(200) }).strict().parse(req.body);
    const me = (await q('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0]; if (!me || !(await verifyPassword(b.password, me.password_hash))) throw new HttpError(403, 'wrong_password');
    const shop = (await q(`SELECT s.name FROM shops s JOIN sellers se ON se.id=s.seller_id WHERE se.id=$1`, [id])).rows[0]; if (!shop) throw new HttpError(404, 'not_found');
    const token = newToken();
    await tx(async c => {
      await c.query(`INSERT INTO sessions(user_id,area,token_hash,expires_at,ip,user_agent,acting_seller_id,acting_reason) VALUES ($1,'studio',$2, now() + ($3 || ' hours')::interval, $4, $5, $6, $7)`, [u.id, sha256(token), String(ACTING_HOURS), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 200), id, b.reason]);
      await audit(c, { actor: u.id, area: 'admin', action: 'seller.act_as.start', entityType: 'seller', entityId: id, reason: b.reason, next: { hours: ACTING_HOURS }, ip: req.ip });
    });
    reply.setCookie(cookieName('studio'), token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: ACTING_HOURS * 3600 });
    return { url: '/studio', shop: shop.name, hours: ACTING_HOURS };
  });
  /** Leave the maker's studio. Only works from an acting session. */
  app.post('/api/studio/acting/end', async (req, reply) => {
    const u = requireUser(req); if (!u.acting) throw new HttpError(409, 'not_acting');
    await q('DELETE FROM sessions WHERE id=$1', [u.sessionId]); reply.clearCookie(cookieName('studio'), { path: '/' });
    await audit(pool, { actor: u.id, area: 'studio', action: 'seller.act_as.end', entityType: 'seller', entityId: u.acting.sellerId, ip: req.ip });
    return { ok: true, back: `/admin/sellers/${u.acting.sellerId}` };
  });

  // ---- open another console from admin without signing in again (each console keeps its own separate session)
  app.post('/api/admin/portals/:area/enter', async (req, reply) => {
    const u = requireUser(req); if (!u.roles.some(r => r.role === 'admin')) throw new HttpError(403, 'forbidden');
    const { area } = z.object({ area: z.enum(['support', 'finance', 'marketing']) }).parse(req.params);
    await openSession(reply, u.id, area, req.ip, req.headers['user-agent']); await audit(pool, { actor: u.id, area: 'admin', action: 'portal.enter', entityType: 'portal', entityId: area, ip: req.ip });
    return { url: `/${area}` };
  });
}
