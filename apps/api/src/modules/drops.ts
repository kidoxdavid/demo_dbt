import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { enqueue, url as mailUrl } from '../lib/mail.js';
import { config } from '../config.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const LIVE = `p.status='active' AND (p.available_from IS NULL OR p.available_from <= now())`;
const IN_STOCK = `EXISTS (SELECT 1 FROM product_variants v JOIN inventory_levels l ON l.variant_id=v.id WHERE v.product_id=p.id AND (NOT v.track_inventory OR l.on_hand-l.reserved>0))`;

/**
 * Tell people who asked: everyone on a product's waitlist once it can be bought (restocked, or its drop time arrived), and, for drops, the store's followers once.
 * Safe to run any number of times and from several processes: each person is marked notified in the same transaction that queues their email.
 */
export async function notifyWaitlists(only?: { tenantId?: string }) {
  return withTx({ platform: true }, async c => {
    let waitlist = 0, followers = 0;
    const live = (await c.query(
      `SELECT p.id, p.tenant_id, p.name, p.available_from, p.drop_announced_at, s.slug, s.name AS store_name FROM products p JOIN stores s ON s.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id
       WHERE ${LIVE} AND ${IN_STOCK} AND s.status='published' AND t.status='active' AND ($1::uuid IS NULL OR p.tenant_id=$1)
         AND (EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.product_id=p.id AND w.notified_at IS NULL) OR (p.available_from IS NOT NULL AND p.drop_announced_at IS NULL))
       FOR UPDATE OF p SKIP LOCKED`, [only?.tenantId ?? null])).rows;
    for (const p of live) {
      const link = mailUrl(`/store/${p.slug}/p/${p.id}`); const drop = !!p.available_from;
      const people = (await c.query(`UPDATE waitlist_entries SET notified_at=now() WHERE product_id=$1 AND notified_at IS NULL RETURNING email`, [p.id])).rows;
      for (const w of people) { await enqueue(c, { tenantId: p.tenant_id, to: w.email, template: drop ? 'drop_live' : 'back_in_stock', data: { name: p.name, storeName: p.store_name, url: link } }); waitlist++; }
      if (drop && !p.drop_announced_at) {
        await c.query('UPDATE products SET drop_announced_at=now() WHERE id=$1', [p.id]);
        const f = (await c.query(`SELECT u.email FROM store_follows sf JOIN users u ON u.id=sf.user_id WHERE sf.tenant_id=$1 AND u.disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.product_id=$2 AND lower(w.email)=lower(u.email))`, [p.tenant_id, p.id])).rows;
        for (const u of f) { await enqueue(c, { tenantId: p.tenant_id, to: u.email, template: 'new_drop', data: { name: p.name, storeName: p.store_name, url: link } }); followers++; }
      }
    }
    return { waitlist, followers };
  });
}

export function registerDrops(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx>; authenticate: (r: FastifyRequest) => Promise<void> }) {
  const { tenantCtx, authenticate } = deps;
  const rate = { config: { rateLimit: { max: Math.max(config.authRateLimitMax, 10), timeWindow: '1 minute' } } };
  const ids = z.object({ slug: z.string().regex(SLUG), id: z.string().uuid() });
  const optionalUser = async (req: FastifyRequest) => { if (!req.cookies['eazy_sid']) return null; try { await authenticate(req); return req.user!; } catch { return null; } };

  // ---- Buyer: join a product's waitlist (sold out, or a drop that has not started)
  app.post('/api/public/stores/:slug/products/:id/waitlist', rate, async (req, reply) => {
    const { slug, id } = ids.parse(req.params); const b = z.object({ email: z.string().email().max(254).optional() }).strict().parse(req.body ?? {});
    const me = await optionalUser(req); const email = (b.email ?? me?.email)?.trim().toLowerCase(); if (!email) throw new HttpError(422, 'email_required');
    const s = await withTx({}, async c => (await c.query('SELECT tenant_id FROM stores WHERE slug=$1', [slug])).rows[0]); if (!s) throw new HttpError(404, 'not_found');     // RLS: published only
    return withTx({ tenantId: s.tenant_id }, async c => {
      const p = (await c.query(`SELECT p.id, p.available_from > now() AS upcoming, ${IN_STOCK} AS in_stock FROM products p WHERE p.id=$1 AND p.status='active'`, [id])).rows[0];
      if (!p) throw new HttpError(404, 'not_found');
      if (!p.upcoming && p.in_stock) throw new HttpError(409, 'available_now');
      const r = await c.query(`INSERT INTO waitlist_entries(tenant_id,product_id,email,user_id,kind) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (product_id,email) DO NOTHING RETURNING id`, [s.tenant_id, id, email, me?.id ?? null, p.upcoming ? 'drop' : 'restock']);
      return reply.code(r.rowCount ? 201 : 200).send({ joined: true, already: !r.rowCount, kind: p.upcoming ? 'drop' : 'restock' });
    });
  });

  // ---- Buyer: follow a maker to hear about drops
  app.put('/api/account/follows/:slug', async (req) => {
    await authenticate(req); const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    return withTx({ platform: true }, async c => {
      const s = (await c.query(`SELECT s.tenant_id FROM stores s JOIN tenants t ON t.id=s.tenant_id WHERE s.slug=$1 AND s.status='published' AND t.status='active'`, [slug])).rows[0]; if (!s) throw new HttpError(404, 'not_found');
      await c.query('INSERT INTO store_follows(user_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user!.id, s.tenant_id]); return { following: true };
    });
  });
  app.delete('/api/account/follows/:slug', async (req) => {
    await authenticate(req); const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    await withTx({ platform: true }, c => c.query('DELETE FROM store_follows WHERE user_id=$1 AND tenant_id=(SELECT tenant_id FROM stores WHERE slug=$2)', [req.user!.id, slug])); return { following: false };
  });
  app.get('/api/account/follows', async (req) => {
    await authenticate(req);
    return withTx({ platform: true }, async c => (await c.query(
      `SELECT s.slug, s.name, b.category, b.city FROM store_follows f JOIN stores s ON s.tenant_id=f.tenant_id JOIN businesses b ON b.tenant_id=f.tenant_id JOIN tenants t ON t.id=f.tenant_id
       WHERE f.user_id=$1 AND s.status='published' AND t.status='active' ORDER BY f.created_at DESC`, [req.user!.id])).rows);
  });
  /** Is the signed-in customer following this store? (false for guests) */
  app.get('/api/public/stores/:slug/following', async (req) => {
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params); const me = await optionalUser(req); if (!me) return { following: false, signedIn: false };
    const n = await withTx({ platform: true }, async c => (await c.query('SELECT 1 FROM store_follows f JOIN stores s ON s.tenant_id=f.tenant_id WHERE f.user_id=$1 AND s.slug=$2', [me.id, slug])).rowCount);
    return { following: !!n, signedIn: true };
  });

  // ---- Seller: demand
  app.get('/api/seller/demand', async (req) => {
    const t = await tenantCtx(req); if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    return withTx(t, async c => {
      const products = (await c.query(
        `SELECT p.id, p.name, p.available_from AS "availableFrom", (SELECT count(*)::int FROM waitlist_entries w WHERE w.product_id=p.id AND w.notified_at IS NULL) AS waiting,
                (SELECT count(*)::int FROM waitlist_entries w WHERE w.product_id=p.id AND w.notified_at IS NOT NULL) AS notified,
                (SELECT coalesce(sum(l.on_hand-l.reserved),0)::int FROM product_variants v JOIN inventory_levels l ON l.variant_id=v.id WHERE v.product_id=p.id AND v.track_inventory) AS available,
                (SELECT min(v.price_cents) FROM product_variants v WHERE v.product_id=p.id) AS "priceCents"
         FROM products p WHERE p.status='active' AND EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.product_id=p.id) ORDER BY waiting DESC, p.name`)).rows;
      const followers = Number((await c.query('SELECT count(*) n FROM store_follows WHERE tenant_id=$1', [t.tenantId])).rows[0].n);
      return { followers, products, note: 'Waiting = people who asked to be told and have not been yet. They are emailed once, automatically, when the product can be bought.' };
    });
  });
  /** Schedule or cancel a drop. A drop is visible straight away but cannot be bought until its time; people can join the waitlist meanwhile. */
  app.put('/api/seller/products/:id/drop', async (req) => {
    const t = await tenantCtx(req); if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ availableFrom: z.string().datetime().nullable() }).strict().parse(req.body);
    if (b.availableFrom && new Date(b.availableFrom).getTime() < Date.now() - 60_000) throw new HttpError(422, 'drop_in_past');
    return withTx(t, async c => {
      const prev = (await c.query('SELECT available_from FROM products WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!prev) throw new HttpError(404, 'not_found');
      await c.query('UPDATE products SET available_from=$2, drop_announced_at=NULL, updated_at=now() WHERE id=$1', [id, b.availableFrom]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'product.drop', entityType: 'product', entityId: id, prev: { availableFrom: prev.available_from }, next: { availableFrom: b.availableFrom } });
      return { id, availableFrom: b.availableFrom };
    });
  });
}
