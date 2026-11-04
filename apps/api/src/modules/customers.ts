import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/security.js';
import { issueToken } from '../lib/tokens.js';
import { enqueue, url as mailUrl } from '../lib/mail.js';
import { config, TERMS_VERSION } from '../config.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** Orders that count as a real purchase: paid for and not cancelled or fully refunded. */
const PURCHASED = ['paid', 'processing', 'ready', 'shipped', 'completed'];
const firstName = (full: string) => (full.trim().split(/\s+/)[0] || 'Customer').slice(0, 40);

/**
 * Customer accounts, wishlists and reviews.
 *  - A customer is an ordinary user without a business. Guests can still check out; an account just gives them history and a wishlist.
 *  - Reviews need a verified purchase of that product (an order linked to the account, or placed with the account's VERIFIED email),
 *    one review per customer per product, editable by its author. Only the first name is shown. Sellers can reply once; they cannot edit or delete reviews.
 *    Platform staff can remove a review with a recorded reason.
 */
export function registerCustomers(app: FastifyInstance, deps: {
  tenantCtx: (r: FastifyRequest) => Promise<TenantCtx>; authenticate: (r: FastifyRequest) => Promise<void>; platformPerm: (r: FastifyRequest, perm: string) => Promise<void>;
  setSession: (reply: FastifyReply, userId: string, mfa?: boolean) => Promise<void>;
}) {
  const { tenantCtx, authenticate, platformPerm, setSession } = deps;
  const rate = { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: '1 minute' } } };

  const storeTenant = async (slug: string) => {
    const s = await withTx({}, async c => (await c.query('SELECT tenant_id, name FROM stores WHERE slug=$1', [slug])).rows[0]);     // RLS: published stores only
    if (!s) throw new HttpError(404, 'not_found'); return s as { tenant_id: string; name: string };
  };
  const optional = async (req: FastifyRequest) => { if (!req.cookies['eazy_sid']) return null; try { await authenticate(req); return req.user!; } catch { return null; } };
  const purchased = (userParam = 2, emailParam = 3, verifiedParam = 4) =>
    `(o.customer_user_id=$${userParam} OR ($${verifiedParam}::boolean AND lower(o.customer_email)=lower($${emailParam})))`;

  // ---------------- Account ----------------
  app.post('/api/auth/signup-customer', rate, async (req, reply) => {
    const b = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(200), fullName: z.string().trim().min(1).max(120), acceptTerms: z.boolean().optional() }).strict().parse(req.body);
    const pw = await hashPassword(b.password);
    const userId = await withTx({ signup: true, platform: true }, async c => {
      if ((await c.query('SELECT 1 FROM users WHERE email=$1', [b.email])).rowCount) throw new HttpError(409, 'email_in_use');
      const u = (await c.query('INSERT INTO users(email,password_hash,full_name,terms_accepted_at,terms_version) VALUES ($1,$2,$3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN $5 END) RETURNING id',
        [b.email, pw, b.fullName, !!b.acceptTerms, TERMS_VERSION])).rows[0];
      const tok = await issueToken(c, u.id, 'verify', 60 * 24);
      await enqueue(c, { to: b.email, template: 'verify_email', data: { url: mailUrl(`/verify?token=${tok}`) } });
      await audit(c, { actor: u.id, action: 'customer.signup', entityType: 'user', entityId: u.id, ip: req.ip });
      return u.id as string;
    });
    await setSession(reply, userId);
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/account/orders', async (req) => {
    await authenticate(req); const u = req.user!;
    return withTx({ platform: true }, async c => (await c.query(
      `SELECT o.number::int AS number, o.status, o.total_cents AS "totalCents", o.currency, o.created_at AS "createdAt", o.public_token AS token, o.channel, s.slug AS "storeSlug", s.name AS "storeName",
              (SELECT coalesce(json_agg(json_build_object('name',i.name,'quantity',i.quantity,'productId',v.product_id) ORDER BY i.name),'[]'::json)
               FROM order_items i LEFT JOIN product_variants v ON v.id=i.variant_id WHERE i.order_id=o.id) AS items
       FROM orders o JOIN stores s ON s.tenant_id=o.tenant_id
       WHERE o.customer_user_id=$1 OR ($3::boolean AND lower(o.customer_email)=lower($2) AND o.anonymised_at IS NULL)
       ORDER BY o.created_at DESC LIMIT 100`, [u.id, u.email, u.emailVerified])).rows);
  });

  app.post('/api/account/close', async (req, reply) => {
    await authenticate(req); const u = req.user!;
    const b = z.object({ password: z.string().min(1), confirm: z.literal('CLOSE') }).strict().parse(req.body);
    if (u.mfaEnabledAt && !u.mfaAt) throw new HttpError(403, 'mfa_required');
    await withTx({ platform: true }, async c => {
      if ((await c.query('SELECT 1 FROM memberships WHERE user_id=$1', [u.id])).rowCount) throw new HttpError(409, 'seller_account');       // sellers close their business instead
      const row = (await c.query('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0];
      if (!(await verifyPassword(b.password, row.password_hash))) throw new HttpError(401, 'invalid_credentials');
      const open = Number((await c.query(`SELECT count(*) n FROM orders WHERE customer_user_id=$1 AND status IN ('awaiting_payment','paid','processing','ready','shipped')`, [u.id])).rows[0].n);
      if (open) throw new HttpError(409, `open_orders:${open}`);
      await c.query('DELETE FROM wishlist_items WHERE user_id=$1', [u.id]);
      await c.query(`UPDATE product_reviews SET reviewer_name='Former customer', user_id=NULL WHERE user_id=$1`, [u.id]);
      await c.query(`UPDATE orders SET customer_user_id=NULL WHERE customer_user_id=$1`, [u.id]);
      await c.query(`UPDATE users SET email='closed-'||id||'@invalid.example', full_name='Closed account', password_hash='!', disabled_at=now(), mfa_secret_enc=NULL, mfa_enabled_at=NULL, mfa_recovery='[]' WHERE id=$1`, [u.id]);
      await c.query('DELETE FROM sessions WHERE user_id=$1', [u.id]); await c.query('DELETE FROM mfa_challenges WHERE user_id=$1', [u.id]); await c.query('DELETE FROM email_tokens WHERE user_id=$1', [u.id]);
      await audit(c, { actor: u.id, action: 'customer.closed', entityType: 'user', entityId: u.id, ip: req.ip });
    });
    reply.clearCookie('eazy_sid', { path: '/' });
    return { ok: true };
  });

  // ---------------- Wishlist (visible products only, across stores) ----------------
  const VISIBLE = `p.status='active' AND s.status='published' AND t.status='active'`;
  app.get('/api/account/wishlist', async (req) => {
    await authenticate(req);
    return withTx({ platform: true }, async c => (await c.query(
      `SELECT p.id, p.name, s.slug AS "storeSlug", s.name AS "storeName", b.currency, w.created_at AS "addedAt",
              (SELECT min(v.price_cents) FROM product_variants v WHERE v.product_id=p.id) AS "priceFrom",
              (SELECT '/media/'||m.storage_key||'?w=480' FROM product_media m WHERE m.product_id=p.id ORDER BY m.position LIMIT 1) AS image,
              EXISTS (SELECT 1 FROM product_variants v JOIN inventory_levels l ON l.variant_id=v.id WHERE v.product_id=p.id AND (NOT v.track_inventory OR l.on_hand-l.reserved>0)) AS available
       FROM wishlist_items w JOIN products p ON p.id=w.product_id JOIN stores s ON s.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id JOIN businesses b ON b.tenant_id=p.tenant_id
       WHERE w.user_id=$1 AND ${VISIBLE} ORDER BY w.created_at DESC LIMIT 200`, [req.user!.id])).rows);
  });
  app.get('/api/account/wishlist/ids', async (req) => {
    await authenticate(req);
    return withTx({ userId: req.user!.id }, async c => (await c.query('SELECT product_id FROM wishlist_items WHERE user_id=$1', [req.user!.id])).rows.map(r => r.product_id as string));
  });
  app.put('/api/account/wishlist/:productId', async (req) => {
    await authenticate(req); const { productId } = z.object({ productId: z.string().uuid() }).parse(req.params);
    return withTx({ platform: true }, async c => {
      const ok = (await c.query(`SELECT 1 FROM products p JOIN stores s ON s.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id WHERE p.id=$1 AND ${VISIBLE}`, [productId])).rowCount;
      if (!ok) throw new HttpError(404, 'not_found');
      const n = Number((await c.query('SELECT count(*) n FROM wishlist_items WHERE user_id=$1', [req.user!.id])).rows[0].n);
      if (n >= 200) throw new HttpError(422, 'wishlist_full');
      await c.query('INSERT INTO wishlist_items(user_id,product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user!.id, productId]);
      return { saved: true };
    });
  });
  app.delete('/api/account/wishlist/:productId', async (req) => {
    await authenticate(req); const { productId } = z.object({ productId: z.string().uuid() }).parse(req.params);
    await withTx({ userId: req.user!.id }, c => c.query('DELETE FROM wishlist_items WHERE user_id=$1 AND product_id=$2', [req.user!.id, productId]));
    return { saved: false };
  });

  // ---------------- Reviews: public ----------------
  const reviewIn = z.object({ rating: z.number().int().min(1).max(5), title: z.string().trim().max(120).optional(), body: z.string().trim().max(2000).optional() }).strict();
  const ids = z.object({ slug: z.string().regex(SLUG), id: z.string().uuid() });

  app.get('/api/public/stores/:slug/products/:id/reviews', async (req) => {
    const { slug, id } = ids.parse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const s = await storeTenant(slug); const me = await optional(req);
    return withTx({ tenantId: s.tenant_id }, async c => {
      if (!(await c.query(`SELECT 1 FROM products WHERE id=$1 AND status='active'`, [id])).rowCount) throw new HttpError(404, 'not_found');
      const agg = (await c.query(`SELECT count(*)::int AS count, round(avg(rating)::numeric,1)::float AS avg,
                                         count(*) FILTER (WHERE rating=5)::int s5, count(*) FILTER (WHERE rating=4)::int s4, count(*) FILTER (WHERE rating=3)::int s3, count(*) FILTER (WHERE rating=2)::int s2, count(*) FILTER (WHERE rating=1)::int s1
                                  FROM product_reviews WHERE product_id=$1 AND status='published'`, [id])).rows[0];
      const reviews = (await c.query(`SELECT id, reviewer_name AS "name", rating, title, body, seller_reply AS "sellerReply", seller_replied_at AS "sellerRepliedAt", created_at AS "createdAt"
                                      FROM product_reviews WHERE product_id=$1 AND status='published' ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [id, q.limit, q.offset])).rows;
      let mine: unknown = null; let canReview = false;
      if (me) {
        mine = (await c.query(`SELECT id, rating, title, body, status FROM product_reviews WHERE product_id=$1 AND user_id=$2`, [id, me.id])).rows[0] ?? null;
        canReview = !!(await c.query(
          `SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id JOIN product_variants v ON v.id=i.variant_id
           WHERE v.product_id=$1 AND o.status = ANY($5) AND ${purchased(2, 3, 4)} LIMIT 1`, [id, me.id, me.email, me.emailVerified, PURCHASED])).rowCount;
      }
      return { rating: { avg: agg.avg, count: agg.count, distribution: { 5: agg.s5, 4: agg.s4, 3: agg.s3, 2: agg.s2, 1: agg.s1 } }, reviews, mine, canReview };
    });
  });

  app.put('/api/public/stores/:slug/products/:id/reviews', rate, async (req, reply) => {
    await authenticate(req); const me = req.user!;
    const { slug, id } = ids.parse(req.params); const b = reviewIn.parse(req.body);
    const s = await storeTenant(slug);
    const out = await withTx({ tenantId: s.tenant_id }, async c => {
      if (!(await c.query(`SELECT 1 FROM products WHERE id=$1 AND status='active'`, [id])).rowCount) throw new HttpError(404, 'not_found');
      const ok = (await c.query(
        `SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id JOIN product_variants v ON v.id=i.variant_id
         WHERE v.product_id=$1 AND o.status = ANY($5) AND ${purchased(2, 3, 4)} LIMIT 1`, [id, me.id, me.email, me.emailVerified, PURCHASED])).rowCount;
      if (!ok) throw new HttpError(403, 'purchase_required');
      const prev = (await c.query('SELECT id, status FROM product_reviews WHERE product_id=$1 AND user_id=$2', [id, me.id])).rows[0];
      if (prev?.status === 'removed') throw new HttpError(403, 'review_removed');
      const r = (await c.query(
        `INSERT INTO product_reviews(tenant_id,product_id,user_id,reviewer_name,rating,title,body) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (product_id,user_id) DO UPDATE SET rating=$5, title=$6, body=$7, updated_at=now() RETURNING id`,
        [s.tenant_id, id, me.id, firstName(me.fullName), b.rating, b.title || null, b.body || null])).rows[0];
      return { id: r.id as string, updated: !!prev };
    });
    return reply.code(out.updated ? 200 : 201).send(out);
  });

  app.delete('/api/public/stores/:slug/products/:id/reviews', async (req) => {
    await authenticate(req); const { slug, id } = ids.parse(req.params); const s = await storeTenant(slug);
    const n = await withTx({ tenantId: s.tenant_id }, async c => (await c.query('DELETE FROM product_reviews WHERE product_id=$1 AND user_id=$2 AND status=$3', [id, req.user!.id, 'published'])).rowCount);
    if (!n) throw new HttpError(404, 'not_found'); return { deleted: true };
  });

  // ---------------- Reviews: seller ----------------
  app.get('/api/seller/reviews', async (req) => {
    const t = await tenantCtx(req);
    const q = z.object({ unanswered: z.enum(['1']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    return withTx(t, async c => (await c.query(
      `SELECT r.id, r.rating, r.title, r.body, r.reviewer_name AS "name", r.status, r.seller_reply AS "sellerReply", r.created_at AS "createdAt", p.id AS "productId", p.name AS "productName"
       FROM product_reviews r JOIN products p ON p.id=r.product_id WHERE r.status='published' AND ($1::boolean IS NOT TRUE OR r.seller_reply IS NULL) ORDER BY r.created_at DESC LIMIT $2`, [q.unanswered === '1', q.limit])).rows);
  });
  app.post('/api/seller/reviews/:id/reply', async (req) => {
    const t = await tenantCtx(req); if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ reply: z.string().trim().min(2).max(1000) }).strict().parse(req.body);
    return withTx(t, async c => {
      const r = (await c.query('SELECT id, seller_reply, status FROM product_reviews WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r || r.status !== 'published') throw new HttpError(404, 'not_found');
      if (r.seller_reply) throw new HttpError(409, 'already_replied');
      await c.query('UPDATE product_reviews SET seller_reply=$2, seller_replied_at=now() WHERE id=$1', [id, b.reply]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'review.reply', entityType: 'review', entityId: id });
      return { id, replied: true };
    });
  });

  // ---------------- Reviews: platform moderation ----------------
  app.post('/api/admin/reviews/:id/remove', async (req) => {
    await platformPerm(req, 'reviews.write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      const r = (await c.query('SELECT id, tenant_id, status FROM product_reviews WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new HttpError(404, 'not_found'); if (r.status === 'removed') throw new HttpError(409, 'already_removed');
      await c.query(`UPDATE product_reviews SET status='removed', removal_reason=$2, updated_at=now() WHERE id=$1`, [id, b.reason]);
      await audit(c, { actor: req.user!.id, tenantId: r.tenant_id, action: 'review.remove', entityType: 'review', entityId: id, prev: { status: r.status }, next: { status: 'removed' }, reason: b.reason, ip: req.ip });
      return { id, status: 'removed' };
    });
  });
}
