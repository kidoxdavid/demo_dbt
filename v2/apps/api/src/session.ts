import type { FastifyReply } from 'fastify';
import { q } from './db.js';
import { config } from './config.js';
import { newToken, sha256 } from './security.js';
import { cookieName } from './guards.js';
import type { Area } from './permissions.js';

/** Start a session in ONE window and set that window's cookie. Only the token's hash is stored. */
export async function openSession(reply: FastifyReply, userId: string, area: Area, ip: string, ua?: string) {
  const token = newToken();
  await q(`INSERT INTO sessions(user_id,area,token_hash,expires_at,ip,user_agent) VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5, $6)`, [userId, area, sha256(token), String(config.sessionTtlHours), ip, ua?.slice(0, 200) ?? null]);
  reply.setCookie(cookieName(area), token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: config.sessionTtlHours * 3600 });
}
