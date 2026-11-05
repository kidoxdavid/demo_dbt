import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool, q, type Client } from '../db.js';
import { sha256 } from '../security.js';

export const GUEST_COOKIE = 'es_cart';
/** The cart of whoever is asking: the signed-in buyer, or the guest holding the es_cart cookie (created on first use). */
export async function cartFor(req: FastifyRequest, reply: FastifyReply, create = true): Promise<string | null> {
  if (req.user) { const r = await q('INSERT INTO carts(user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at=now() RETURNING id', [req.user.id]); return r.rows[0].id; }
  const raw = req.cookies[GUEST_COOKIE];
  if (raw) { const r = await q('SELECT id FROM carts WHERE guest_hash=$1', [sha256(raw)]); if (r.rows[0]) return r.rows[0].id; }
  if (!create) return null;
  const token = randomBytes(24).toString('base64url'); const r = await q('INSERT INTO carts(guest_hash) VALUES ($1) RETURNING id', [sha256(token)]);
  reply.setCookie(GUEST_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: 60 * 60 * 24 * 30 }); return r.rows[0].id;
}
/** When a guest signs in, their basket joins their account basket (quantities add up, capped at 20; one-of-a-kind stays at 1). */
export async function mergeGuestCart(userId: string, rawGuestToken: string | undefined, reply: FastifyReply) {
  if (!rawGuestToken) return; const guest = (await pool.query('SELECT id FROM carts WHERE guest_hash=$1', [sha256(rawGuestToken)])).rows[0];
  reply.clearCookie(GUEST_COOKIE, { path: '/' }); if (!guest) return;
  const c: Client = await pool.connect();
  try {
    await c.query('BEGIN'); const mine = (await c.query('INSERT INTO carts(user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at=now() RETURNING id', [userId])).rows[0].id;
    await c.query(`INSERT INTO cart_items(cart_id,variant_id,quantity,personalisation) SELECT $1, ci.variant_id, LEAST(ci.quantity, CASE WHEN p.one_of_a_kind THEN 1 ELSE 20 END), ci.personalisation FROM cart_items ci JOIN variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id WHERE ci.cart_id=$2
      ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, CASE WHEN (SELECT one_of_a_kind FROM products p JOIN variants v ON v.product_id=p.id WHERE v.id=cart_items.variant_id) THEN 1 ELSE 20 END)`, [mine, guest.id]);
    await c.query('DELETE FROM carts WHERE id=$1', [guest.id]); await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
