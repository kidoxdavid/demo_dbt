import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, q, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { canForSeller } from '../permissions.js';
import { enqueue } from '../lib/outbox.js';
import { refund } from '../lib/refunds.js';
import { CARRIERS } from '../lib/shipping.js';
import { sellerCtx } from './studio.js';

const idp = z.object({ id: z.string().uuid() });
const tracking = (so: any) => so.tracking_number ? { carrier: so.tracking_carrier, number: so.tracking_number, url: (CARRIERS[so.tracking_carrier] ?? CARRIERS.other)(so.tracking_number) || null, shippedAt: so.shipped_at } : null;

/** What a SELLER sees of their part of an order: what to pack and where it goes. Never the buyer's email, other sellers' parts, or anyone else's money. */
async function view(sellerOrderId: string, sellerId: string) {
  const so = (await pool.query(`SELECT so.*, o.number, o.buyer_name, o.ship_to, o.payment_status, o.created_at AS ordered_at FROM seller_orders so JOIN orders o ON o.id=so.order_id WHERE so.id=$1 AND so.seller_id=$2 AND so.status<>'awaiting_payment'`, [sellerOrderId, sellerId])).rows[0]; if (!so) throw new HttpError(404, 'not_found');
  const lines = (await pool.query('SELECT * FROM order_lines WHERE seller_order_id=$1 ORDER BY id', [so.id])).rows;
  return { id: so.id, number: Number(so.number), status: so.status, orderedAt: so.ordered_at, shipBy: so.ship_by, eta: { min: so.est_delivery_min, max: so.est_delivery_max }, buyer: { name: so.buyer_name }, shipTo: so.ship_to, gift: so.gift, tracking: tracking(so), deliveredAt: so.delivered_at,
    itemsCents: so.items_cents, shippingCents: so.shipping_cents, taxCents: so.tax_cents, totalCents: so.total_cents, commissionCents: so.commission_cents, commissionBps: so.commission_bps, refundedCents: so.refunded_cents, youEarnCents: so.items_cents + so.shipping_cents - so.commission_cents - 0, paymentStatus: so.payment_status,
    lines: lines.map(l => ({ id: l.id, title: l.title, variant: l.variant_label, sku: l.sku, quantity: l.quantity, refundedQty: l.refunded_qty, unitCents: l.unit_price_cents, personalisation: l.personalisation, art: l.art_kind ? { kind: l.art_kind, tone: l.art_tone } : null, image: l.image_media_id ? `/api/studio/media/${l.image_media_id}/w320` : null })) };
}

export function registerStudioOrders(app: FastifyInstance) {
  app.get('/api/studio/orders', async (req) => {
    const s = await sellerCtx(req, 'seller.orders.read'); const f = z.object({ status: z.enum(['new', 'accepted', 'shipped', 'delivered', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const rows = (await q(`SELECT so.id, so.status, so.total_cents, so.ship_by, so.created_at, o.number, o.buyer_name, o.ship_to->>'city' AS city, count(*) OVER()::int AS total,
        (SELECT coalesce(sum(quantity),0)::int FROM order_lines l WHERE l.seller_order_id=so.id) AS items, (SELECT l.title FROM order_lines l WHERE l.seller_order_id=so.id ORDER BY l.id LIMIT 1) AS first_title
      FROM seller_orders so JOIN orders o ON o.id=so.order_id WHERE so.seller_id=$1 AND so.status<>'awaiting_payment' AND ($2::text IS NULL OR so.status=$2) ORDER BY so.created_at DESC LIMIT $3 OFFSET $4`, [s.sellerId, f.status ?? null, f.limit, f.offset])).rows;
    const toShip = Number((await q(`SELECT count(*) n FROM seller_orders WHERE seller_id=$1 AND status IN ('new','accepted')`, [s.sellerId])).rows[0].n);
    return { total: rows[0]?.total ?? 0, toShip, items: rows.map(r => ({ id: r.id, number: Number(r.number), status: r.status, totalCents: r.total_cents, shipBy: r.ship_by, createdAt: r.created_at, buyerName: r.buyer_name, city: r.city, itemCount: r.items, title: r.first_title })) };
  });
  app.get('/api/studio/orders/:id', async (req) => { const s = await sellerCtx(req, 'seller.orders.read'); return view(idp.parse(req.params).id, s.sellerId); });

  const step = (name: string, from: string[], to: string, extra: (c: any, so: any, b: any) => Promise<void> = async () => {}, schema: z.ZodTypeAny = z.object({}).strict()) =>
    app.post(`/api/studio/orders/:id/${name}`, async (req) => {
      const s = await sellerCtx(req, 'seller.orders.write'); const { id } = idp.parse(req.params); const b = schema.parse(req.body ?? {});
      await tx(async c => { const so = (await c.query('SELECT * FROM seller_orders WHERE id=$1 AND seller_id=$2 FOR UPDATE', [id, s.sellerId])).rows[0]; if (!so) throw new HttpError(404, 'not_found');
        if (!from.includes(so.status)) throw new HttpError(409, `invalid_transition:${so.status}->${to}`);
        await c.query('UPDATE seller_orders SET status=$2 WHERE id=$1', [id, to]); await extra(c, so, b); await audit(c, { actor: s.user.id, area: 'studio', action: `order.${name}`, entityType: 'seller_order', entityId: id, prev: { status: so.status }, next: { status: to }, ip: req.ip }); });
      return view(id, s.sellerId);
    });
  step('accept', ['new'], 'accepted');
  step('ship', ['new', 'accepted'], 'shipped', async (c, so, b) => {
    await c.query('UPDATE seller_orders SET tracking_carrier=$2, tracking_number=$3, shipped_at=now() WHERE id=$1', [so.id, b.carrier, b.trackingNumber]);
    const o = (await c.query('SELECT o.email, o.number, o.public_token, s.name AS shop FROM orders o JOIN seller_orders x ON x.order_id=o.id JOIN shops s ON s.id=x.shop_id WHERE x.id=$1', [so.id])).rows[0];
    await enqueue(c, o.email, 'order_shipped', { number: Number(o.number), shop: o.shop, carrier: b.carrier.replace('_', ' '), trackingNumber: b.trackingNumber, trackingUrl: (CARRIERS[b.carrier] ?? CARRIERS.other)(b.trackingNumber) || null, url: `${process.env.PUBLIC_URL ?? 'http://localhost:5180'}/orders/${o.public_token}` });
  }, z.object({ carrier: z.enum(Object.keys(CARRIERS) as [string, ...string[]]), trackingNumber: z.string().trim().regex(/^[A-Za-z0-9-]{3,40}$/) }).strict());
  step('deliver', ['shipped'], 'delivered', async (c, so) => {
    await c.query('UPDATE seller_orders SET delivered_at=now() WHERE id=$1', [so.id]);
    const o = (await c.query('SELECT o.email, o.number, o.public_token, s.name AS shop FROM orders o JOIN seller_orders x ON x.order_id=o.id JOIN shops s ON s.id=x.shop_id WHERE x.id=$1', [so.id])).rows[0];
    await enqueue(c, o.email, 'review_request', { number: Number(o.number), shop: o.shop, url: `${process.env.PUBLIC_URL ?? 'http://localhost:5180'}/orders/${o.public_token}` });          // asks once, when the piece has arrived
  });

  /** Refund some or all lines (and optionally the shipping). Owners and managers only: money leaves the seller's balance. */
  app.post('/api/studio/orders/:id/refund', async (req) => {
    const s = await sellerCtx(req, 'seller.shop.write'); const { id } = idp.parse(req.params);
    const b = z.object({ lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().int().min(1).max(20) }).strict()).max(50), includeShipping: z.boolean().default(false), reason: z.string().trim().min(3).max(300), restock: z.boolean().default(false) }).strict().parse(req.body);
    const key = req.headers['idempotency-key']; const r = await refund({ sellerOrderId: id, sellerId: s.sellerId, ...b, actor: s.user.id, idempotencyKey: typeof key === 'string' && key.length >= 8 && key.length <= 80 ? `${s.sellerId}:${key}` : undefined });
    return { ...r, order: await view(id, s.sellerId) };
  });
  /** Cancel before it ships: refunds everything on this seller order and puts the stock back. */
  app.post('/api/studio/orders/:id/cancel', async (req) => {
    const s = await sellerCtx(req, 'seller.shop.write'); const { id } = idp.parse(req.params); const b = z.object({ reason: z.string().trim().min(3).max(300) }).strict().parse(req.body);
    const so = (await q('SELECT status, refunded_cents FROM seller_orders WHERE id=$1 AND seller_id=$2', [id, s.sellerId])).rows[0]; if (!so) throw new HttpError(404, 'not_found'); if (!['new', 'accepted'].includes(so.status)) throw new HttpError(409, `invalid_transition:${so.status}->cancelled`);
    const lines = (await q('SELECT id, quantity - refunded_qty AS q FROM order_lines WHERE seller_order_id=$1', [id])).rows.filter(l => l.q > 0).map(l => ({ lineId: l.id, quantity: l.q }));
    const r = await refund({ sellerOrderId: id, sellerId: s.sellerId, lines, includeShipping: true, reason: b.reason, restock: true, actor: s.user.id });
    await tx(async c => { await c.query(`UPDATE seller_orders SET status='cancelled' WHERE id=$1`, [id]); await audit(c, { actor: s.user.id, area: 'studio', action: 'order.cancel', entityType: 'seller_order', entityId: id, reason: b.reason, ip: req.ip }); });
    return { ...r, order: await view(id, s.sellerId) };
  });

  // ---- Shipping profiles
  const profileIn = z.object({ name: z.string().trim().min(1).max(60), rateType: z.enum(['flat', 'per_item', 'weight']), baseCents: z.number().int().min(0).max(100_000), extraItemCents: z.number().int().min(0).max(100_000).default(0), perKgCents: z.number().int().min(0).max(100_000).default(0),
    freeOverCents: z.number().int().min(1).max(10_000_000).nullable().default(null), transitDaysMin: z.number().int().min(0).max(60), transitDaysMax: z.number().int().min(0).max(60), isDefault: z.boolean().default(false) }).strict().refine(p => p.transitDaysMax >= p.transitDaysMin, { message: 'Latest delivery cannot be before the earliest', path: ['transitDaysMax'] });
  const pv = (r: any) => ({ id: r.id, name: r.name, rateType: r.rate_type, baseCents: r.base_cents, extraItemCents: r.extra_item_cents, perKgCents: r.per_kg_cents, freeOverCents: r.free_over_cents, transitDaysMin: r.transit_days_min, transitDaysMax: r.transit_days_max, isDefault: r.is_default });
  app.get('/api/studio/shipping-profiles', async (req) => { const s = await sellerCtx(req, 'seller.products.read'); return (await q('SELECT * FROM shipping_profiles WHERE seller_id=$1 ORDER BY is_default DESC, created_at', [s.sellerId])).rows.map(pv); });
  app.post('/api/studio/shipping-profiles', async (req, reply) => {
    const s = await sellerCtx(req, 'seller.shop.write'); const b = profileIn.parse(req.body);
    const row = await tx(async c => { const first = !(await c.query('SELECT 1 FROM shipping_profiles WHERE seller_id=$1', [s.sellerId])).rowCount; if (b.isDefault || first) await c.query('UPDATE shipping_profiles SET is_default=false WHERE seller_id=$1', [s.sellerId]);
      const r = await c.query(`INSERT INTO shipping_profiles(seller_id,name,rate_type,base_cents,extra_item_cents,per_kg_cents,free_over_cents,transit_days_min,transit_days_max,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [s.sellerId, b.name, b.rateType, b.baseCents, b.extraItemCents, b.perKgCents, b.freeOverCents, b.transitDaysMin, b.transitDaysMax, b.isDefault || first]); await audit(c, { actor: s.user.id, area: 'studio', action: 'shipping_profile.create', entityType: 'shipping_profile', entityId: r.rows[0].id, ip: req.ip }); return r.rows[0]; });
    return reply.code(201).send(pv(row));
  });
  app.put('/api/studio/shipping-profiles/:id', async (req) => {
    const s = await sellerCtx(req, 'seller.shop.write'); const { id } = idp.parse(req.params); const b = profileIn.parse(req.body);
    return tx(async c => { if (!(await c.query('SELECT 1 FROM shipping_profiles WHERE id=$1 AND seller_id=$2 FOR UPDATE', [id, s.sellerId])).rowCount) throw new HttpError(404, 'not_found'); if (b.isDefault) await c.query('UPDATE shipping_profiles SET is_default=false WHERE seller_id=$1', [s.sellerId]);
      const r = await c.query(`UPDATE shipping_profiles SET name=$2,rate_type=$3,base_cents=$4,extra_item_cents=$5,per_kg_cents=$6,free_over_cents=$7,transit_days_min=$8,transit_days_max=$9,is_default=CASE WHEN $10 THEN true ELSE is_default END WHERE id=$1 RETURNING *`,
        [id, b.name, b.rateType, b.baseCents, b.extraItemCents, b.perKgCents, b.freeOverCents, b.transitDaysMin, b.transitDaysMax, b.isDefault]); return pv(r.rows[0]); });
  });
  app.delete('/api/studio/shipping-profiles/:id', async (req) => {
    const s = await sellerCtx(req, 'seller.shop.write'); const { id } = idp.parse(req.params);
    return tx(async c => { const p = (await c.query('SELECT is_default FROM shipping_profiles WHERE id=$1 AND seller_id=$2 FOR UPDATE', [id, s.sellerId])).rows[0]; if (!p) throw new HttpError(404, 'not_found'); if (p.is_default) throw new HttpError(409, 'cannot_delete_default');
      await c.query('DELETE FROM shipping_profiles WHERE id=$1', [id]); return { deleted: true }; });
  });
}
void canForSeller;
