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

import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const jpeg = (w = 800, h = 600, bg = '#c8a05a') => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).jpeg().toBuffer();
export const tinyMp4 = (seconds = 2) => { const d = mkdtempSync(join(tmpdir(), 'es2-mp4-')); const f = join(d, 't.mp4'); execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`, '-pix_fmt', 'yuv420p', f], { stdio: 'ignore' }); return readFileSync(f); };
let sn = 0;
/** A seller signs up through the studio flow; returns their studio cookie and shop. */
export async function studioSeller(app: FastifyInstance, opts: { categories?: string[]; shopName?: string } = {}) {
  const email = `seller${Date.now()}${sn++}@t.test`;
  const r = await app.inject({ method: 'POST', url: '/api/studio/signup', payload: { email, password: PW, fullName: 'Sam Seller', categories: opts.categories ?? ['pottery-ceramics'], shopName: opts.shopName ?? `Test Shop ${sn}` } });
  if (r.statusCode !== 201) throw new Error(`studio signup failed ${r.statusCode} ${r.body}`);
  return { email, cookie: cookieOf(r, 'studio'), sellerId: r.json().sellerId as string, shop: r.json().shop as { id: string; slug: string; name: string } };
}
export const upload = (app: FastifyInstance, cookie: string, buf: Buffer, type = 'image/jpeg') => app.inject({ method: 'POST', url: '/api/studio/media', headers: { 'content-type': type }, payload: buf, ...ck('studio', cookie) });
