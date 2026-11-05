import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit, pool, q, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { hashPassword, newToken, passwordProblem, sha256, verifyPassword } from '../security.js';
import { canAccessArea, type Area, type RoleGrant } from '../permissions.js';
import { cookieName, requireUser } from '../guards.js';

const email = z.string().trim().toLowerCase().email().max(254);
const LOCK_AFTER = 5; const LOCK_MINUTES = 15;

async function openSession(reply: FastifyReply, userId: string, area: Area, ip: string, ua?: string) {
  const token = newToken();
  await q(`INSERT INTO sessions(user_id,area,token_hash,expires_at,ip,user_agent) VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5, $6)`, [userId, area, sha256(token), String(config.sessionTtlHours), ip, ua?.slice(0, 200) ?? null]);
  reply.setCookie(cookieName(area), token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: config.sessionTtlHours * 3600 });
}
const userView = (u: { id: string; email: string; fullName: string; roles: RoleGrant[] }, area: Area) => ({ id: u.id, email: u.email, fullName: u.fullName, area, roles: u.roles.map(r => ({ role: r.role, sellerId: r.sellerId })) });

export function registerAuth(app: FastifyInstance) {
  const limit = { config: (app as any).authLimit };

  /** Buyer sign-up (the shop window). Sellers sign up through the studio flow, which also creates their shop. */
  app.post('/api/auth/signup', limit, async (req, reply) => {
    const b = z.object({ email, password: z.string().min(1).max(200), fullName: z.string().trim().min(1).max(120) }).strict().parse(req.body);
    const problem = passwordProblem(b.password, b.email); if (problem) throw new HttpError(400, `weak_password:${problem}`);
    const hash = await hashPassword(b.password);
    const user = await tx(async c => {
      const r = await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id', [b.email, hash, b.fullName]);
      if (!r.rowCount) throw new HttpError(409, 'email_in_use');
      await audit(c, { actor: r.rows[0].id, area: 'shop', action: 'user.signup', entityType: 'user', entityId: r.rows[0].id, ip: req.ip }); return r.rows[0];
    });
    await openSession(reply, user.id, 'shop', req.ip, req.headers['user-agent']);
    return reply.code(201).send({ user: { id: user.id, email: b.email, fullName: b.fullName, area: 'shop', roles: [] } });
  });

  /** Sign in to ONE window. The same person has separate sessions per window, and a window only lets in people who belong there. */
  app.post('/api/auth/login', limit, async (req, reply) => {
    const b = z.object({ email, password: z.string().min(1).max(200) }).strict().parse(req.body); const area = req.area;
    const u = (await q('SELECT id, email, full_name, password_hash, status, failed_logins, locked_until FROM users WHERE email=$1', [b.email])).rows[0];
    const deny = (): never => { throw new HttpError(401, 'invalid_credentials'); };
    if (!u || u.status !== 'active') { await hashPassword(b.password); return deny(); }                 // equalise timing: unknown and disabled look the same as a wrong password
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(429, 'account_temporarily_locked');
    if (!(await verifyPassword(b.password, u.password_hash))) {
      await q(`UPDATE users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1>=$2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END WHERE id=$1`, [u.id, LOCK_AFTER, String(LOCK_MINUTES)]);
      return deny();
    }
    const roles = (await q('SELECT id, role, seller_id FROM user_roles WHERE user_id=$1', [u.id])).rows.map(r => ({ id: r.id, role: r.role, sellerId: r.seller_id }) as RoleGrant);
    if (!canAccessArea(roles, area)) throw new HttpError(403, 'not_allowed_in_area');
    await q('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
    await openSession(reply, u.id, area, req.ip, req.headers['user-agent']);
    await audit(pool, { actor: u.id, area, action: 'auth.login', entityType: 'user', entityId: u.id, ip: req.ip });
    return userView({ id: u.id, email: u.email, fullName: u.full_name, roles: area === 'shop' ? [] : roles }, area);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[cookieName(req.area)]; if (raw) await q('DELETE FROM sessions WHERE token_hash=$1', [sha256(raw)]);
    reply.clearCookie(cookieName(req.area), { path: '/' }); return { ok: true };
  });

  app.get('/api/me', async (req) => userView(requireUser(req), req.area));
  app.get('/api/admin/me', async (req) => userView(requireUser(req), req.area));
  app.get('/api/studio/me', async (req) => userView(requireUser(req), req.area));
}
