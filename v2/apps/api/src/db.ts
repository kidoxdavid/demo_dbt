import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export type Client = pg.PoolClient;
/** Run fn in a transaction. Rolls back on any error. */
export async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
export const q = <T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);

/** Append-only audit trail (a trigger forbids updates and deletes). Stores who, what, the old and new values, and why. */
export async function audit(c: Client | typeof pool, e: { actor?: string | null; area?: string; action: string; entityType: string; entityId?: string | null; prev?: unknown; next?: unknown; reason?: string; ip?: string }) {
  await c.query(`INSERT INTO audit_log(actor_id,area,action,entity_type,entity_id,prev,next,reason,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.actor ?? null, e.area ?? null, e.action, e.entityType, e.entityId ?? null, e.prev === undefined ? null : JSON.stringify(e.prev), e.next === undefined ? null : JSON.stringify(e.next), e.reason ?? null, e.ip ?? null]);
}
