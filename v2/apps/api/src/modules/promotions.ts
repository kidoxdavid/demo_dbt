import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, q, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { requirePerm } from '../guards.js';
import { CARD_COLUMNS, CARD_FROM, VISIBLE, toCard } from '../lib/cards.js';
import { allFlags, allSettings, requireFlag } from '../settings.js';
import { sellerCtx } from './studio.js';
import { requireSellerFlag, sellerOnSql } from '../lib/sellerFlags.js';

const uuid = z.string().uuid(); const idp = z.object({ id: uuid });
const text = (max: number) => z.string().trim().max(max).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), 'invalid_characters');
const promoIn = z.object({ headline: text(60).pipe(z.string().min(1)), body: text(200).default(''), ctaLabel: text(24).pipe(z.string().min(1)).default('Shop now'), productId: uuid.nullable().default(null),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }).strict();

const mine = async (shopId: string) => (await q(`SELECT sp.*, p.title AS product_title,
    coalesce((SELECT sum(views) FROM store_promotion_stats s WHERE s.promotion_id=sp.id),0)::int AS views, coalesce((SELECT sum(clicks) FROM store_promotion_stats s WHERE s.promotion_id=sp.id),0)::int AS clicks
  FROM store_promotions sp LEFT JOIN products p ON p.id=sp.product_id WHERE sp.shop_id=$1 AND sp.status<>'ended' ORDER BY sp.created_at DESC LIMIT 1`, [shopId])).rows[0];
const view = (r: any) => r && ({ id: r.id, headline: r.headline, body: r.body, ctaLabel: r.cta_label, productId: r.product_id, productTitle: r.product_title ?? null, startsOn: r.starts_on?.toISOString?.().slice(0, 10) ?? r.starts_on, endsOn: r.ends_on ? (r.ends_on.toISOString?.().slice(0, 10) ?? r.ends_on) : null,
  status: r.status, rejectReason: r.reject_reason, views: r.views, clicks: r.clicks, approved: !!r.approved_at });
/** Is it showing right now? (live, started, not past its end date.) */
const SHOWING = `${sellerOnSql('sp.seller_id', 'store_promotions')} AND sp.status='live' AND sp.starts_on <= current_date AND (sp.ends_on IS NULL OR sp.ends_on >= current_date)`;

export function registerPromotions(app: FastifyInstance) {
  // ---- the maker's side
  app.get('/api/studio/promotion', async req => {
    await requireFlag('store_promotions'); const s = await sellerCtx(req, 'seller.shop.write');
    const products = (await q(`SELECT id, title FROM products WHERE seller_id=$1 AND status='published' AND moderation_status<>'removed' ORDER BY title LIMIT 100`, [s.sellerId])).rows;
    return { promotion: view(await mine(s.shopId)) ?? null, requiresApproval: !!(await allSettings()).store_promotions_require_approval, products };
  });
  app.put('/api/studio/promotion', async req => {
    await requireFlag('store_promotions'); const s = await sellerCtx(req, 'seller.shop.write'); await requireSellerFlag(s.sellerId, 'store_promotions'); const b = promoIn.parse(req.body); const needs = !!(await allSettings()).store_promotions_require_approval;
    if (b.productId && !(await q('SELECT 1 FROM products WHERE id=$1 AND seller_id=$2 AND status=$3', [b.productId, s.sellerId, 'published'])).rowCount) throw new HttpError(422, 'product_not_yours');
    const startsOn = b.startsOn ?? new Date().toISOString().slice(0, 10); if (b.endsOn && b.endsOn < startsOn) throw new HttpError(422, 'ends_before_start');
    await tx(async c => {
      const cur = (await c.query(`SELECT * FROM store_promotions WHERE shop_id=$1 AND status IN ('pending','live','paused','rejected') FOR UPDATE`, [s.shopId])).rows[0];
      const status = needs ? 'pending' : 'live';                                 // any edit to what visitors see goes back for approval when approval is required
      if (cur) {
        await c.query(`UPDATE store_promotions SET headline=$2, body=$3, cta_label=$4, product_id=$5, starts_on=$6, ends_on=$7, status=$8, reject_reason=NULL, approved_by=NULL, approved_at=CASE WHEN $8='live' THEN now() END, updated_at=now() WHERE id=$1`, [cur.id, b.headline, b.body, b.ctaLabel, b.productId, startsOn, b.endsOn, cur.status === 'paused' && !needs ? 'paused' : status]);
        await audit(c, { actor: s.user.id, area: 'studio', action: 'promotion.update', entityType: 'store_promotion', entityId: cur.id, prev: { headline: cur.headline, status: cur.status }, next: { headline: b.headline, status }, ip: req.ip });
      } else {
        const r = (await c.query(`INSERT INTO store_promotions(seller_id,shop_id,headline,body,cta_label,product_id,starts_on,ends_on,status,approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9='live' THEN now() END) RETURNING id`, [s.sellerId, s.shopId, b.headline, b.body, b.ctaLabel, b.productId, startsOn, b.endsOn, status])).rows[0];
        await audit(c, { actor: s.user.id, area: 'studio', action: 'promotion.create', entityType: 'store_promotion', entityId: r.id, next: { headline: b.headline, status }, ip: req.ip });
      }
    });
    return { promotion: view(await mine(s.shopId)) };
  });
  /** The maker's own switch: pause (hide) it, show it again if it was approved, or end it for good. */
  app.post('/api/studio/promotion/status', async req => {
    await requireFlag('store_promotions'); const s = await sellerCtx(req, 'seller.shop.write'); await requireSellerFlag(s.sellerId, 'store_promotions'); const b = z.object({ status: z.enum(['live', 'paused', 'ended']) }).strict().parse(req.body);
    await tx(async c => {
      const cur = (await c.query(`SELECT * FROM store_promotions WHERE shop_id=$1 AND status IN ('pending','live','paused','rejected') FOR UPDATE`, [s.shopId])).rows[0]; if (!cur) throw new HttpError(404, 'not_found');
      if (b.status === 'live' && (cur.status !== 'paused' || !cur.approved_at)) throw new HttpError(409, cur.status === 'rejected' ? 'rejected_by_staff' : 'not_approved');
      if (b.status === 'paused' && cur.status !== 'live') throw new HttpError(409, 'not_live');
      await c.query('UPDATE store_promotions SET status=$2, updated_at=now() WHERE id=$1', [cur.id, b.status]);
      await audit(c, { actor: s.user.id, area: 'studio', action: `promotion.${b.status === 'live' ? 'resume' : b.status}`, entityType: 'store_promotion', entityId: cur.id, prev: { status: cur.status }, next: { status: b.status }, ip: req.ip });
    });
    return { promotion: view(await mine(s.shopId)) ?? null };
  });

  // ---- what visitors see (the store page asks for this; clicks are counted)
  app.get('/api/shops/:slug/promotion', async (req, reply) => {
    reply.header('cache-control', 'no-store'); if (!(await allFlags()).store_promotions) return { promotion: null };
    const { slug } = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(req.params);
    const r = (await pool.query(`SELECT sp.*, s.slug FROM store_promotions sp JOIN shops s ON s.id=sp.shop_id JOIN sellers se ON se.id=sp.seller_id WHERE s.slug=$1 AND s.status='live' AND se.status='active' AND ${SHOWING}`, [slug])).rows[0]; if (!r) return { promotion: null };
    let product = null; if (r.product_id) { const p = (await pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${VISIBLE} AND p.id=$1`, [r.product_id])).rows[0]; product = p ? toCard(p) : null; }
    void pool.query('INSERT INTO store_promotion_stats(promotion_id,day,views) VALUES ($1,current_date,1) ON CONFLICT (promotion_id,day) DO UPDATE SET views=store_promotion_stats.views+1', [r.id]).catch(() => {});
    return { promotion: { headline: r.headline, body: r.body, ctaLabel: r.cta_label, product } };
  });
  app.post('/api/shops/:slug/promotion/click', async (req, reply) => {
    const { slug } = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(req.params);
    await q(`INSERT INTO store_promotion_stats(promotion_id,day,clicks) SELECT sp.id, current_date, 1 FROM store_promotions sp JOIN shops s ON s.id=sp.shop_id WHERE s.slug=$1 AND ${SHOWING} ON CONFLICT (promotion_id,day) DO UPDATE SET clicks=store_promotion_stats.clicks+1`, [slug]);
    return reply.code(204).send();
  });

  // ---- staff: approve, reject or take one down. The same list is reachable from the admin and marketing windows.
  for (const area of ['marketing', 'admin'] as const) {
    app.get(`/api/${area}/promotions`, async req => {
      requirePerm(req, 'marketing.write'); const f = z.object({ status: z.enum(['pending', 'live', 'paused', 'rejected', 'ended']).optional() }).parse(req.query);
      return (await q(`SELECT sp.*, s.name AS shop, s.slug, p.title AS product_title, coalesce((SELECT sum(views) FROM store_promotion_stats x WHERE x.promotion_id=sp.id),0)::int AS views, coalesce((SELECT sum(clicks) FROM store_promotion_stats x WHERE x.promotion_id=sp.id),0)::int AS clicks
        FROM store_promotions sp JOIN shops s ON s.id=sp.shop_id LEFT JOIN products p ON p.id=sp.product_id WHERE ($1::text IS NULL OR sp.status=$1) ORDER BY (sp.status='pending') DESC, sp.created_at DESC LIMIT 200`, [f.status ?? null])).rows.map(r => ({ ...view(r), shop: r.shop, slug: r.slug }));
    });
    app.post(`/api/${area}/promotions/:id/decide`, async req => {
      const u = requirePerm(req, 'marketing.write'); const { id } = idp.parse(req.params); const b = z.object({ decision: z.enum(['approve', 'reject', 'remove']), reason: z.string().trim().max(300).optional() }).strict().parse(req.body);
      if (b.decision !== 'approve' && !b.reason) throw new HttpError(422, 'reason_required');
      await tx(async c => {
        const cur = (await c.query('SELECT * FROM store_promotions WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!cur) throw new HttpError(404, 'not_found'); if (cur.status === 'ended') throw new HttpError(409, 'ended');
        if (b.decision === 'approve') { await c.query(`UPDATE store_promotions SET status='live', reject_reason=NULL, approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1`, [id, u.id]); }
        else await c.query(`UPDATE store_promotions SET status=$2, reject_reason=$3, approved_by=NULL, approved_at=NULL, updated_at=now() WHERE id=$1`, [id, 'rejected', b.reason]);
        await audit(c, { actor: u.id, area, action: `promotion.${b.decision}`, entityType: 'store_promotion', entityId: id, prev: { status: cur.status }, next: { status: b.decision === 'approve' ? 'live' : 'rejected' }, reason: b.reason, ip: req.ip });
      });
      return { ok: true };
    });
  }
}
