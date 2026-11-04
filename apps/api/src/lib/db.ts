import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 10 });

export interface Ctx { tenantId?: string; userId?: string; platform?: boolean; signup?: boolean }

/** Run fn in a transaction with RLS context set (transaction-local, so pooled connections never leak context). */
export async function withTx<T>(ctx: Ctx, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true),
              set_config('app.platform_admin',$3,true), set_config('app.signup',$4,true)`,
      [ctx.tenantId ?? '', ctx.userId ?? '', ctx.platform ? 'on' : '', ctx.signup ? 'on' : '']);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

export async function audit(c: pg.PoolClient, e: {
  actor?: string; tenantId?: string; action: string; entityType: string; entityId?: string;
  prev?: unknown; next?: unknown; reason?: string; ip?: string;
}) {
  await c.query(
    `INSERT INTO audit_logs(actor_user_id,tenant_id,action,entity_type,entity_id,previous_value,new_value,reason,ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.actor ?? null, e.tenantId ?? null, e.action, e.entityType, e.entityId ?? null,
     e.prev ? JSON.stringify(e.prev) : null, e.next ? JSON.stringify(e.next) : null, e.reason ?? null, e.ip ?? null]);
}
