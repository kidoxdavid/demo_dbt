import type pg from 'pg';
import { newToken, sha256 } from './security.js';

/** One-time emailed tokens. Only a hash is stored, so a database leak does not leak working links. */
export async function issueToken(c: pg.PoolClient, userId: string, kind: 'verify' | 'reset', minutes: number): Promise<string> {
  await c.query(`UPDATE email_tokens SET used_at=now() WHERE user_id=$1 AND kind=$2 AND used_at IS NULL`, [userId, kind]);   // newest link wins
  const raw = newToken();
  await c.query(`INSERT INTO email_tokens(user_id,kind,token_hash,expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`, [userId, kind, sha256(raw), String(minutes)]);
  return raw;
}

/** Atomically spend a token: two concurrent requests with the same link cannot both succeed. Returns the user id or null. */
export async function consumeToken(c: pg.PoolClient, raw: string, kind: 'verify' | 'reset'): Promise<string | null> {
  const r = await c.query(`UPDATE email_tokens SET used_at=now() WHERE token_hash=$1 AND kind=$2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha256(raw), kind]);
  return r.rows[0]?.user_id ?? null;
}
