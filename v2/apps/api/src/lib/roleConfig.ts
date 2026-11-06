import { q } from '../db.js';
import { applyRoleConfig, type RoleConfigRow } from '../permissions.js';

let loadedAt = 0; let inflight: Promise<void> | null = null;
/** Read the admin's role choices into the live permission tables. */
export async function loadRoleConfig(): Promise<void> {
  const rows = (await q('SELECT role, permissions, areas FROM role_config')).rows as RoleConfigRow[]; applyRoleConfig(rows); loadedAt = Date.now();
}
/** Cheap on every request: reloads at most every 5 seconds, so a change reaches every running server within moments. */
export async function ensureRoleConfig(): Promise<void> {
  if (Date.now() - loadedAt < 5000) return;
  inflight ??= loadRoleConfig().catch(() => { /* keep the last good tables */ }).finally(() => { inflight = null; });
  await inflight;
}
export const resetRoleConfigClock = () => { loadedAt = 0; };
