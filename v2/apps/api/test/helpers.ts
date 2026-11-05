import type { FastifyInstance } from 'fastify';
import { pool, q } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import type { Area } from '../src/permissions.js';

export const PW = 'correct-horse-battery';
export const ck = (area: Area, v: string) => ({ cookies: { [`es_${area}`]: v } });
export const cookieOf = (res: { cookies: { name: string; value: string }[] }, area: Area) => res.cookies.find(c => c.name === `es_${area}`)?.value as string;
let n = 0;
export async function makeUser(app: FastifyInstance, opts: { role?: string; sellerId?: string; email?: string; password?: string } = {}) {
  const email = opts.email ?? `u${Date.now()}${n++}@t.test`;
  const u = (await q('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) RETURNING id', [email, await hashPassword(opts.password ?? PW), 'Test User'])).rows[0];
  if (opts.role) await q('INSERT INTO user_roles(user_id,role,seller_id) VALUES ($1,$2,$3)', [u.id, opts.role, opts.sellerId ?? null]);
  return { id: u.id as string, email };
}
/** Create a user, sign in to a window, return the cookie. */
export async function login(app: FastifyInstance, area: Area, opts: { role?: string; sellerId?: string; email?: string } = {}) {
  const u = await makeUser(app, opts);
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': area }, payload: { email: u.email, password: PW } });
  if (r.statusCode !== 200) throw new Error(`login failed ${r.statusCode} ${r.body}`);
  return { ...u, cookie: cookieOf(r, area) };
}
export const end = async () => { await pool.end(); };
