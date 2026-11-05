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
  'sellers.read', 'sellers.write', 'orders.read', 'orders.write', 'refunds.write', 'finance.read', 'finance.write', 'marketing.write', 'support.write'] as const;
export type Permission = (typeof ALL_PERMISSIONS)[number];
export const SELLER_PERMISSIONS = ['seller.shop.write', 'seller.products.read', 'seller.products.write', 'seller.orders.read', 'seller.orders.write', 'seller.messages.write', 'seller.payouts.read', 'seller.staff.manage'] as const;
export type SellerPermission = (typeof SELLER_PERMISSIONS)[number];

export const STAFF_PERMS: Record<StaffRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  support: ['users.read', 'audit.read', 'orders.read', 'sellers.read', 'support.write'],
  finance: ['audit.read', 'orders.read', 'finance.read', 'finance.write', 'refunds.write'],
  catalogue: ['categories.write', 'sellers.read'],
  marketing: ['marketing.write'],
};
export const SELLER_PERMS: Record<SellerRole, SellerPermission[]> = {
  seller_owner: [...SELLER_PERMISSIONS],
  seller_manager: ['seller.shop.write', 'seller.products.read', 'seller.products.write', 'seller.orders.read', 'seller.orders.write', 'seller.messages.write'],
  seller_staff: ['seller.products.read', 'seller.orders.read', 'seller.orders.write', 'seller.messages.write'],
};
/** Who may sign in to which window. The shop window is for everyone (a buyer has no role). */
export const AREA_ROLES: Record<Exclude<Area, 'shop'>, Role[]> = {
  studio: SELLER_ROLES, admin: ['admin', 'catalogue'], support: ['support', 'admin'], finance: ['finance', 'admin'], marketing: ['marketing', 'admin'],
};
export interface RoleGrant { id: string; role: Role; sellerId: string | null }
export interface SessionUser { id: string; email: string; fullName: string; area: Area; roles: RoleGrant[]; sessionId: string }

export function canAccessArea(roles: RoleGrant[], area: Area) { return area === 'shop' || roles.some(r => AREA_ROLES[area].includes(r.role)); }
export function can(user: Pick<SessionUser, 'roles'>, perm: Permission): boolean { return user.roles.some(r => isStaffRole(r.role) && STAFF_PERMS[r.role].includes(perm)); }
/** Seller permissions only count for the seller the role was granted on. Staff with `sellers.write` may act on any seller. */
export function canForSeller(user: Pick<SessionUser, 'roles'>, perm: SellerPermission, sellerId: string): boolean {
  return user.roles.some(r => (isSellerRole(r.role) && r.sellerId === sellerId && SELLER_PERMS[r.role].includes(perm))) || can(user, 'sellers.write');
}
