import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { requirePerm } from '../guards.js';
import { loadRoleConfig } from '../lib/roleConfig.js';
import { ADMIN_ONLY, ALL_PERMISSIONS, CONSOLE_AREAS, SELLER_PERMISSIONS, SELLER_PERMS, STAFF_PERMS, AREA_ROLES, defaultsFor, isEditableRole, type Role } from '../permissions.js';

/** Plain words for every permission, grouped, so the admin screen needs no jargon. */
const WORDS: Record<string, [string, string]> = {
  'users.read': ['People', 'See accounts and their history'], 'users.write': ['People', 'Disable or re-enable accounts'], 'roles.manage': ['People', 'Give people staff roles (admin only)'],
  'sellers.read': ['Makers', 'See makers and their shops'], 'sellers.write': ['Makers', 'Change a maker\'s standing and settings'],
  'orders.read': ['Orders and money', 'See orders'], 'orders.write': ['Orders and money', 'Change orders'], 'refunds.write': ['Orders and money', 'Issue refunds'], 'finance.read': ['Orders and money', 'See balances and reports'], 'finance.write': ['Orders and money', 'Record payouts'],
  'catalogue.moderate': ['Catalogue', 'Review and remove listings'], 'categories.write': ['Catalogue', 'Edit categories and their fields'],
  'marketing.write': ['Marketing', 'Edit the home page, ads, promotions and search words'], 'support.write': ['Support', 'Write notes on orders and people'],
  'settings.write': ['Platform', 'Change business rules'], 'flags.write': ['Platform', 'Switch features on and off'], 'audit.read': ['Platform', 'Read the audit log'],
  'seller.shop.write': ['Shop', 'Edit the shop, its shipping and its ads and promotions'], 'seller.products.read': ['Shop', 'See products'], 'seller.products.write': ['Shop', 'Create and change products'],
  'seller.orders.read': ['Shop', 'See orders'], 'seller.orders.write': ['Shop', 'Pack, ship and refund orders'], 'seller.messages.write': ['Shop', 'Reply to buyers and reviews'], 'seller.payouts.read': ['Shop', 'See payouts'], 'seller.staff.manage': ['Shop', 'Add and remove team members (owner only)'],
};
const ROLE_LABEL: Record<string, string> = { admin: 'Admin', support: 'Support', finance: 'Finance', catalogue: 'Catalogue', marketing: 'Marketing', seller_owner: 'Maker: owner', seller_manager: 'Maker: manager', seller_staff: 'Maker: staff' };
const AREA_LABEL: Record<string, string> = { admin: 'Admin console', support: 'Support console', finance: 'Finance console', marketing: 'Marketing console' };

export function registerRoles(app: FastifyInstance) {
  app.get('/api/admin/roles', async req => {
    requirePerm(req, 'roles.manage');
    const roleList = ['admin', 'support', 'finance', 'catalogue', 'marketing', 'seller_owner', 'seller_manager', 'seller_staff'] as const;
    const permList = (r: string): string[] => r === 'admin' ? [...ALL_PERMISSIONS] : r === 'seller_owner' ? [...SELLER_PERMISSIONS] : ((STAFF_PERMS as Record<string, string[]>)[r] ?? (SELLER_PERMS as Record<string, string[]>)[r] ?? []);
    return {
      roles: roleList.map(r => {
        const staff = ['admin', 'support', 'finance', 'catalogue', 'marketing'].includes(r); const mine = new Set(permList(r)); const def = defaultsFor(r);
        const universe: string[] = staff ? [...ALL_PERMISSIONS] : [...SELLER_PERMISSIONS];
        return { role: r, label: ROLE_LABEL[r], editable: isEditableRole(r), kind: staff ? 'staff' : 'maker',
          areas: staff ? CONSOLE_AREAS.map(a => ({ area: a, label: AREA_LABEL[a], on: (AREA_ROLES[a] as Role[]).includes(r as Role), locked: r === 'admin' })) : [],
          permissions: universe.map(p => ({ key: p, group: WORDS[p]?.[0] ?? 'Other', label: WORDS[p]?.[1] ?? p, on: mine.has(p), locked: !isEditableRole(r) || ADMIN_ONLY.includes(p), isDefault: def.permissions.includes(p) })) };
      }),
    };
  });
  app.put('/api/admin/roles/:role', async req => {
    const u = requirePerm(req, 'roles.manage'); const { role } = z.object({ role: z.string().max(30) }).parse(req.params); if (!isEditableRole(role)) throw new HttpError(403, 'role_locked');
    const b = z.object({ permissions: z.array(z.string().max(40)).max(40), areas: z.array(z.enum(CONSOLE_AREAS)).max(4).default([]), reason: z.string().trim().max(300).optional() }).strict().parse(req.body);
    const universe: string[] = role.startsWith('seller_') ? [...SELLER_PERMISSIONS] : [...ALL_PERMISSIONS];
    if (b.permissions.some(p => !universe.includes(p))) throw new HttpError(422, 'unknown_permission'); if (b.permissions.some(p => ADMIN_ONLY.includes(p))) throw new HttpError(422, 'admin_only_permission');
    const staff = !role.startsWith('seller_'); const areas = staff ? b.areas : [];
    await tx(async c => {
      const prev = (await c.query('SELECT permissions, areas FROM role_config WHERE role=$1', [role])).rows[0] ?? defaultsFor(role);
      await c.query(`INSERT INTO role_config(role,permissions,areas,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (role) DO UPDATE SET permissions=EXCLUDED.permissions, areas=EXCLUDED.areas, updated_by=EXCLUDED.updated_by, updated_at=now()`, [role, b.permissions, areas, u.id]);
      await audit(c, { actor: u.id, area: 'admin', action: 'role.configure', entityType: 'role', entityId: role, prev, next: { permissions: b.permissions, areas }, reason: b.reason, ip: req.ip });
    });
    await loadRoleConfig(); return { ok: true };
  });
  app.delete('/api/admin/roles/:role', async req => {
    const u = requirePerm(req, 'roles.manage'); const { role } = z.object({ role: z.string().max(30) }).parse(req.params); if (!isEditableRole(role)) throw new HttpError(403, 'role_locked');
    await tx(async c => { const prev = (await c.query('SELECT permissions, areas FROM role_config WHERE role=$1', [role])).rows[0]; if (!prev) return; await c.query('DELETE FROM role_config WHERE role=$1', [role]);
      await audit(c, { actor: u.id, area: 'admin', action: 'role.reset', entityType: 'role', entityId: role, prev, next: defaultsFor(role), ip: req.ip }); });
    await loadRoleConfig(); return { ok: true };
  });
}
