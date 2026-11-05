import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, q } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../guards.js';
import { cartFor } from '../lib/cartStore.js';
import { CARRIERS } from '../lib/shipping.js';
import { checkout, cleanAddress, orderSummary, settlePayment } from '../lib/orders.js';
import { getProvider, mock, sign } from '../lib/payments.js';

const address = z.object({ name: z.string().trim().min(1).max(120), line1: z.string().trim().min(1).max(160), line2: z.string().trim().max(160).optional(), city: z.string().trim().min(1).max(80), region: z.string().length(2), postal: z.string().max(10), phone: z.string().trim().max(30).optional() }).strict();

const trackingOf = (so: any) => so.tracking_number ? { carrier: so.tracking_carrier, number: so.tracking_number, url: (CARRIERS[so.tracking_carrier] ?? CARRIERS.other)(so.tracking_number) || null, shippedAt: so.shipped_at } : null;
/** What a BUYER may see of an order: their own, never costs, commission or other buyers. */
export async function buyerOrder(orderId: string) {
  const o = (await pool.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  const sos = (await pool.query(`SELECT so.*, s.name AS shop_name, s.slug AS shop_slug FROM seller_orders so JOIN shops s ON s.id=so.shop_id WHERE so.order_id=$1 ORDER BY so.created_at, so.id`, [orderId])).rows;
  const lines = (await pool.query('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [orderId])).rows;
  return { id: o.id, token: o.public_token as string, number: Number(o.number), status: o.status, paymentStatus: o.payment_status, createdAt: o.created_at, paidAt: o.paid_at, shipTo: o.ship_to, email: o.email, itemsCents: o.items_cents, shippingCents: o.shipping_cents, taxCents: o.tax_cents, totalCents: o.total_cents,
    sellers: sos.map(so => ({ id: so.id, shop: { name: so.shop_name, slug: so.shop_slug }, status: so.status, itemsCents: so.items_cents, shippingCents: so.shipping_cents, taxCents: so.tax_cents, totalCents: so.total_cents, refundedCents: so.refunded_cents, gift: so.gift, eta: { min: so.est_delivery_min, max: so.est_delivery_max }, tracking: trackingOf(so), deliveredAt: so.delivered_at,
      lines: lines.filter(l => l.seller_order_id === so.id).map(l => ({ title: l.title, variant: l.variant_label, quantity: l.quantity, unitCents: l.unit_price_cents, personalisation: l.personalisation, art: l.art_kind ? { kind: l.art_kind, tone: l.art_tone } : null })) })) };
}

export function registerOrders(app: FastifyInstance) {
  const limit = { config: (app as any).authLimit };
  /** Place the order: reserves stock for the hold time, splits per seller, and returns what the payment step needs. Send an Idempotency-Key header to make a retry safe. */
  app.post('/api/checkout', limit, async (req, reply) => {
    const b = z.object({ email: z.string().trim().toLowerCase().email().max(254).optional(), address }).strict().parse(req.body);
    const email = req.user?.email ?? b.email; if (!email) throw new HttpError(422, 'email_required');
    const cartId = await cartFor(req, reply, false); if (!cartId) throw new HttpError(422, 'cart_empty');
    const key = req.headers['idempotency-key']; const out = await checkout({ cartId, userId: req.user?.id ?? null, email, address: cleanAddress(b.address), idempotencyKey: typeof key === 'string' && key.length >= 8 && key.length <= 80 ? `${req.user?.id ?? cartId}:${key}` : undefined, ip: req.ip });
    return reply.code(out.replay ? 200 : 201).send(out);
  });

  // ---- Payment events. Orders become paid ONLY from here (a verified, idempotent event), never from the browser.
  app.post('/api/webhooks/payments', async (req, reply) => {
    const provider = getProvider(); if (!provider) throw new HttpError(503, 'payments_not_configured');
    const raw = String((req as any).rawBody ?? ''); if (!provider.verifyWebhook(raw, req.headers['x-signature'] as string | undefined)) throw new HttpError(401, 'invalid_signature');
    const e = z.object({ id: z.string().min(8).max(100), type: z.enum(['payment.succeeded', 'payment.failed']), providerRef: z.string().min(8).max(100) }).strict().parse(req.body);
    return reply.send(await settlePayment(e.providerRef, e.type === 'payment.succeeded' ? 'succeeded' : 'failed', e.id));
  });
  /** Development and tests only: stands in for the provider by sending a correctly signed event through the same path. Does not exist in production. */
  if (!config.production) app.post('/api/dev/payments/:ref/simulate', async (req, reply) => {
    const { ref } = z.object({ ref: z.string().max(100) }).parse(req.params); const { outcome } = z.object({ outcome: z.enum(['succeeded', 'failed']).default('succeeded') }).parse(req.body ?? {});
    const body = { id: `evt_${ref}_${outcome}`, type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed', providerRef: ref };
    const r = await app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: { 'content-type': 'application/json', 'x-signature': sign(JSON.stringify(body)) }, payload: body }); return reply.code(r.statusCode).send(r.json());
  });

  // ---- Buyer orders
  app.get('/api/orders', async (req) => {
    const u = requireUser(req); const rows = (await q(`SELECT o.id FROM orders o WHERE o.user_id=$1 AND o.status<>'awaiting_payment' ORDER BY o.created_at DESC LIMIT 50`, [u.id])).rows; return Promise.all(rows.map(r => buyerOrder(r.id)));
  });
  app.get('/api/orders/:id', async (req) => { const u = requireUser(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await q('SELECT 1 FROM orders WHERE id=$1 AND user_id=$2', [id, u.id])).rowCount) throw new HttpError(404, 'not_found'); return buyerOrder(id); });
  /** Guests follow an order with its private link. */
  app.get('/api/orders/by-token/:token', async (req) => { const { token } = z.object({ token: z.string().min(20).max(64) }).parse(req.params);
    const o = (await q('SELECT id FROM orders WHERE public_token=$1', [token])).rows[0]; if (!o) throw new HttpError(404, 'not_found'); return buyerOrder(o.id); });
}
void mock; void orderSummary;
