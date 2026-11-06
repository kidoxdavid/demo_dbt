/** Roles, areas and permissions. Staff roles are platform-wide; seller roles are scoped to ONE seller. Authorisation is always per resource. */
export type Area = 'shop' | 'studio' | 'admin' | 'support' | 'finance' | 'marketing';
export const AREAS: Area[] = ['shop', 'studio', 'admin', 'support', 'finance', 'marketing'];
export type StaffRole = 'admin' | 'support' | 'finance' | 'catalogue' | 'marketing';
export type SellerRole = 'seller_owner' | 'seller_manager' | 'seller_staff';
export type Role = StaffRole | SellerRole;
export const STAFF_ROLES: StaffRole[] = ['admin', 'support', 'finance', 'catalogue', 'marketing'];
export const SELLER_ROLES: SellerRole[] = ['seller_owner', 'seller_manager', 'seller_staff'];
export const isSellerRole = (r: string): r is SellerRole => (SELLER_ROLES as string[]).includes(r);
export const isStaffRole = (r: string): r is StaffRole => (STAFF_ROLES as string[]).includes(r);

export const ALL_PERMISSIONS = ['users.read', 'users.write', 'roles.manage', 'settings.write', 'flags.write', 'categories.write', 'audit.read',
  'sellers.read', 'sellers.write', 'orders.read', 'orders.write', 'refunds.write', 'finance.read', 'finance.write', 'marketing.write', 'support.write', 'catalogue.moderate'] as const;
export type Permission = (typeof ALL_PERMISSIONS)[number];
export const SELLER_PERMISSIONS = ['seller.shop.write', 'seller.products.read', 'seller.products.write', 'seller.orders.read', 'seller.orders.write', 'seller.messages.write', 'seller.payouts.read', 'seller.staff.manage'] as const;
export type SellerPermission = (typeof SELLER_PERMISSIONS)[number];

const DEFAULT_STAFF_PERMS: Record<StaffRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  support: ['users.read', 'audit.read', 'orders.read', 'sellers.read', 'support.write'],
  finance: ['audit.read', 'orders.read', 'finance.read', 'finance.write', 'refunds.write'],
  catalogue: ['categories.write', 'sellers.read', 'catalogue.moderate'],
  marketing: ['marketing.write'],
};
const DEFAULT_SELLER_PERMS: Record<SellerRole, SellerPermission[]> = {
  seller_owner: [...SELLER_PERMISSIONS],
  seller_manager: ['seller.shop.write', 'seller.products.read', 'seller.products.write', 'seller.orders.read', 'seller.orders.write', 'seller.messages.write'],
  seller_staff: ['seller.products.read', 'seller.orders.read', 'seller.orders.write', 'seller.messages.write'],
};
/** Who may sign in to which window. The shop window is for everyone (a buyer has no role). */
const DEFAULT_AREA_ROLES: Record<Exclude<Area, 'shop'>, Role[]> = {
  studio: SELLER_ROLES, admin: ['admin', 'catalogue'], support: ['support', 'admin'], finance: ['finance', 'admin'], marketing: ['marketing', 'admin'],
};
/** The live tables. They start as the defaults and are reshaped in place by `applyRoleConfig` when the admin edits a role. */
export const STAFF_PERMS: Record<StaffRole, Permission[]> = structuredClone(DEFAULT_STAFF_PERMS);
export const SELLER_PERMS: Record<SellerRole, SellerPermission[]> = structuredClone(DEFAULT_SELLER_PERMS);
export const AREA_ROLES: Record<Exclude<Area, 'shop'>, Role[]> = structuredClone(DEFAULT_AREA_ROLES);
/** Permissions only the admin role can ever hold, so nobody can be talked into granting the power to grant. */
export const ADMIN_ONLY: readonly string[] = ['roles.manage', 'seller.staff.manage'];
export const CONSOLE_AREAS = ['admin', 'support', 'finance', 'marketing'] as const;
export type RoleConfigRow = { role: string; permissions: string[]; areas: string[] };
export const defaultsFor = (role: string) => ({
  permissions: [...((DEFAULT_STAFF_PERMS as Record<string, string[]>)[role] ?? (DEFAULT_SELLER_PERMS as Record<string, string[]>)[role] ?? [])],
  areas: CONSOLE_AREAS.filter(a => (DEFAULT_AREA_ROLES[a] as string[]).includes(role)) as string[],
});
export const isEditableRole = (r: string) => ['support', 'finance', 'catalogue', 'marketing', 'seller_manager', 'seller_staff'].includes(r);
/** Rebuild the live tables from the defaults plus the admin's choices. Admin and seller_owner are never changed. */
export function applyRoleConfig(rows: RoleConfigRow[]) {
  for (const k of Object.keys(DEFAULT_STAFF_PERMS) as StaffRole[]) STAFF_PERMS[k] = [...DEFAULT_STAFF_PERMS[k]];
  for (const k of Object.keys(DEFAULT_SELLER_PERMS) as SellerRole[]) SELLER_PERMS[k] = [...DEFAULT_SELLER_PERMS[k]];
  const areasByRole = new Map<string, Set<string>>(); for (const a of CONSOLE_AREAS) for (const r of DEFAULT_AREA_ROLES[a]) (areasByRole.get(r) ?? areasByRole.set(r, new Set()).get(r)!).add(a);
  for (const row of rows) {
    if (!isEditableRole(row.role)) continue; const allowed = row.permissions.filter(p => !ADMIN_ONLY.includes(p));
    if (isStaffRole(row.role)) { STAFF_PERMS[row.role] = allowed.filter((p): p is Permission => (ALL_PERMISSIONS as readonly string[]).includes(p)); areasByRole.set(row.role, new Set(row.areas.filter(a => (CONSOLE_AREAS as readonly string[]).includes(a)))); }
    else if (isSellerRole(row.role)) SELLER_PERMS[row.role] = allowed.filter((p): p is SellerPermission => (SELLER_PERMISSIONS as readonly string[]).includes(p));
  }
  for (const a of CONSOLE_AREAS) AREA_ROLES[a] = ['admin', ...[...areasByRole].filter(([r, set]) => r !== 'admin' && set.has(a)).map(([r]) => r as Role)];       // admin can always enter every console
}
export interface RoleGrant { id: string; role: Role; sellerId: string | null }
export interface SessionUser { id: string; email: string; fullName: string; area: Area; roles: RoleGrant[]; sessionId: string }

export function canAccessArea(roles: RoleGrant[], area: Area) { return area === 'shop' || roles.some(r => AREA_ROLES[area].includes(r.role)); }
export function can(user: Pick<SessionUser, 'roles'>, perm: Permission): boolean { return user.roles.some(r => isStaffRole(r.role) && STAFF_PERMS[r.role].includes(perm)); }
/** Seller permissions only count for the seller the role was granted on. Staff with `sellers.write` may act on any seller. */
export function canForSeller(user: Pick<SessionUser, 'roles'>, perm: SellerPermission, sellerId: string): boolean {
  return user.roles.some(r => (isSellerRole(r.role) && r.sellerId === sellerId && SELLER_PERMS[r.role].includes(perm))) || can(user, 'sellers.write');
}
