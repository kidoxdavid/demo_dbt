import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';
import { can, type Area, type Permission, type SessionUser } from './permissions.js';

declare module 'fastify' { interface FastifyRequest { user?: SessionUser; area: Area } }
export const cookieName = (a: Area) => `es_${a}`;
export function requireUser(req: FastifyRequest): SessionUser { if (!req.user) throw new HttpError(401, 'unauthenticated'); return req.user; }
export function requirePerm(req: FastifyRequest, perm: Permission): SessionUser { const u = requireUser(req); if (!can(u, perm)) throw new HttpError(403, 'forbidden'); return u; }
