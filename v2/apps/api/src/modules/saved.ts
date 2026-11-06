import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, q } from '../db.js';
import { HttpError } from '../errors.js';
import { requireFlag } from '../settings.js';
import { requireUser } from '../guards.js';
import { CARD_COLUMNS, CARD_FROM, VISIBLE, toCard } from '../lib/cards.js';

const id = z.object({ id: z.string().uuid() }); const slug = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/) });
/** Hearts and follows. Everything here needs a signed-in buyer; the storefront sends guests to sign in first. */
export function registerSaved(app: FastifyInstance) {
  /** What the signed-in buyer has saved, as ids (to fill the hearts on any page) and shop slugs. Guests get empty lists. */
  app.get('/api/me/saved/ids', async (req) => {
    if (!req.user) return { products: [], shops: [] };
    const p = (await q('SELECT product_id FROM saved_products WHERE user_id=$1', [req.user.id])).rows.map(r => r.product_id as string);
    const s = (await q('SELECT s.slug FROM shop_follows f JOIN shops s ON s.id=f.shop_id WHERE f.user_id=$1', [req.user.id])).rows.map(r => r.slug as string); return { products: p, shops: s };
  });
  app.get('/api/me/saved', async (req) => {
    const u = requireUser(req);
    const rows = (await pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} JOIN saved_products sp ON sp.product_id=p.id AND sp.user_id=$1 WHERE ${VISIBLE} ORDER BY sp.created_at DESC LIMIT 200`, [u.id])).rows; return { items: rows.map(toCard) };
  });
  app.put('/api/me/saved/:id', async (req, reply) => {
    await requireFlag('wishlists'); const u = requireUser(req); const { id: pid } = id.parse(req.params);
    if (!(await pool.query(`SELECT 1 ${CARD_FROM} WHERE ${VISIBLE} AND p.id=$1`, [pid])).rowCount) throw new HttpError(404, 'not_found');
    await q('INSERT INTO saved_products(user_id,product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, pid]); return reply.code(204).send();
  });
  app.delete('/api/me/saved/:id', async (req, reply) => { const u = requireUser(req); await q('DELETE FROM saved_products WHERE user_id=$1 AND product_id=$2', [u.id, id.parse(req.params).id]); return reply.code(204).send(); });
  app.put('/api/shops/:slug/follow', async (req, reply) => {
    await requireFlag('shop_follows'); const u = requireUser(req); const s = (await q(`SELECT id FROM shops WHERE slug=$1 AND status='live'`, [slug.parse(req.params).slug])).rows[0]; if (!s) throw new HttpError(404, 'not_found');
    await q('INSERT INTO shop_follows(user_id,shop_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, s.id]); return reply.code(204).send();
  });
  app.delete('/api/shops/:slug/follow', async (req, reply) => {
    const u = requireUser(req); await q('DELETE FROM shop_follows WHERE user_id=$1 AND shop_id=(SELECT id FROM shops WHERE slug=$2)', [u.id, slug.parse(req.params).slug]); return reply.code(204).send();
  });
}
