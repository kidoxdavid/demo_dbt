import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, q, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { requirePerm } from '../guards.js';
import { isSellerRole, SELLER_ROLES, STAFF_ROLES, type Role } from '../permissions.js';
import { FLAGS, FLAG_META, type FlagKey, SETTINGS, allFlags, allSettings, isSettingKey } from '../settings.js';

const reason = z.string().trim().min(3).max(500).optional();

export function registerAdmin(app: FastifyInstance) {
  // ---- Users and roles
  for (const win of ['admin', 'support']) app.get(`/api/${win}/users`, async (req) => {
    requirePerm(req, 'users.read'); const { q: term, limit } = z.object({ q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const like = term ? `%${term.replace(/[\\%_]/g, c => '\\' + c)}%` : null;
    return (await q(`SELECT u.id, u.email, u.full_name AS "fullName", u.status, u.created_at AS "createdAt",
        coalesce((SELECT json_agg(json_build_object('id',r.id,'role',r.role,'sellerId',r.seller_id) ORDER BY r.created_at) FROM user_roles r WHERE r.user_id=u.id),'[]'::json) AS roles
      FROM users u WHERE ($1::text IS NULL OR u.email ILIKE $1 ESCAPE '\\' OR u.full_name ILIKE $1 ESCAPE '\\') ORDER BY u.created_at DESC LIMIT $2`, [like, limit])).rows;
  });
  app.post('/api/admin/users/:id/roles', async (req, reply) => {
    const actor = requirePerm(req, 'roles.manage'); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ role: z.enum([...STAFF_ROLES, ...SELLER_ROLES] as [Role, ...Role[]]), sellerId: z.string().uuid().optional(), reason }).strict().parse(req.body);
    if (isSellerRole(b.role) !== !!b.sellerId) throw new HttpError(422, isSellerRole(b.role) ? 'seller_id_required' : 'seller_id_not_allowed');
    const row = await tx(async c => {
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'not_found');
      if (b.sellerId && !(await c.query('SELECT 1 FROM sellers WHERE id=$1', [b.sellerId])).rowCount) throw new HttpError(422, 'seller_not_found');
      const r = await c.query('INSERT INTO user_roles(user_id,role,seller_id,granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [id, b.role, b.sellerId ?? null, actor.id]);
      if (!r.rowCount) throw new HttpError(409, 'role_exists');
      await audit(c, { actor: actor.id, area: 'admin', action: 'role.grant', entityType: 'user', entityId: id, next: { role: b.role, sellerId: b.sellerId ?? null }, reason: b.reason, ip: req.ip }); return r.rows[0];
    });
    return reply.code(201).send({ id: row.id, role: b.role, sellerId: b.sellerId ?? null });
  });
  app.delete('/api/admin/users/:id/roles/:roleId', async (req) => {
    const actor = requirePerm(req, 'roles.manage'); const { id, roleId } = z.object({ id: z.string().uuid(), roleId: z.string().uuid() }).parse(req.params);
    return tx(async c => {
      const r = (await c.query('SELECT role, seller_id FROM user_roles WHERE id=$1 AND user_id=$2 FOR UPDATE', [roleId, id])).rows[0]; if (!r) throw new HttpError(404, 'not_found');
      if (r.role === 'admin' && Number((await c.query(`SELECT count(*) n FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE ur.role='admin' AND u.status='active'`)).rows[0].n) <= 1) throw new HttpError(409, 'last_admin');
      await c.query('DELETE FROM user_roles WHERE id=$1', [roleId]);
      await audit(c, { actor: actor.id, area: 'admin', action: 'role.revoke', entityType: 'user', entityId: id, prev: { role: r.role, sellerId: r.seller_id }, ip: req.ip }); return { revoked: true };
    });
  });

  // ---- Audit log
  for (const win of ['admin', 'support', 'finance']) app.get(`/api/${win}/audit`, async (req) => {
    requirePerm(req, 'audit.read'); const f = z.object({ entityType: z.string().max(40).optional(), entityId: z.string().max(80).optional(), action: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return (await q(`SELECT a.id, a.at, a.actor_id AS "actorId", u.email AS "actorEmail", a.area, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.prev, a.next, a.reason
      FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE ($1::text IS NULL OR a.entity_type=$1) AND ($2::text IS NULL OR a.entity_id=$2) AND ($3::text IS NULL OR a.action=$3) ORDER BY a.id DESC LIMIT $4`,
      [f.entityType ?? null, f.entityId ?? null, f.action ?? null, f.limit])).rows;
  });

  // ---- Settings (validated by schema, audited with old and new value)
  app.get('/api/admin/settings', async (req) => { requirePerm(req, 'settings.write'); const all = await allSettings();
    return Object.entries(SETTINGS).map(([key, s]) => ({ key, value: all[key], default: s.default, help: s.help, public: s.public, unit: (s as any).unit ?? null, label: (s as any).label ?? key.replace(/_/g, ' '), schema: z.toJSONSchema(s.schema, { io: 'input' }) })); });
  app.put('/api/admin/settings/:key', async (req) => {
    const u = requirePerm(req, 'settings.write'); const { key } = z.object({ key: z.string().max(60) }).parse(req.params); if (!isSettingKey(key)) throw new HttpError(404, 'unknown_setting');
    const b = z.object({ value: z.unknown(), reason }).strict().parse(req.body); const parsed = SETTINGS[key].schema.safeParse(b.value); if (!parsed.success) throw new HttpError(400, 'invalid_value', parsed.error.issues.map(i => i.message));
    return tx(async c => {
      const prev = (await c.query('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [key])).rows[0]?.value ?? SETTINGS[key].default;
      await c.query(`INSERT INTO app_settings(key,value,updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [key, JSON.stringify(parsed.data), u.id]);
      await audit(c, { actor: u.id, area: 'admin', action: 'setting.update', entityType: 'setting', entityId: key, prev, next: parsed.data, reason: b.reason, ip: req.ip }); return { key, value: parsed.data };
    });
  });

  // ---- Feature flags
  app.get('/api/admin/flags', async (req) => { requirePerm(req, 'flags.write'); const on = await allFlags(); return FLAGS.map(key => ({ key, enabled: on[key], default: FLAG_META[key].default, portal: FLAG_META[key].portal, label: FLAG_META[key].label, help: FLAG_META[key].help })); });
  app.put('/api/admin/flags/:key', async (req) => {
    const u = requirePerm(req, 'flags.write'); const { key } = z.object({ key: z.string().max(60) }).parse(req.params); if (!(FLAGS as readonly string[]).includes(key)) throw new HttpError(404, 'unknown_flag');
    const b = z.object({ enabled: z.boolean(), reason }).strict().parse(req.body);
    return tx(async c => {
      const prev = (await allFlags())[key as FlagKey];
      await c.query(`INSERT INTO feature_flags(key,enabled,updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_by=EXCLUDED.updated_by, updated_at=now()`, [key, b.enabled, u.id]);
      await audit(c, { actor: u.id, area: 'admin', action: 'flag.update', entityType: 'flag', entityId: key, prev: { enabled: prev }, next: { enabled: b.enabled }, reason: b.reason, ip: req.ip }); return { key, enabled: b.enabled };
    });
  });
}
