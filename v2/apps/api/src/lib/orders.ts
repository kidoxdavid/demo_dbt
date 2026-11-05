import { randomBytes } from 'node:crypto';
import { audit, pool, tx, type Client } from '../db.js';
import { HttpError } from '../errors.js';
import { allSettings } from '../settings.js';
import { allocateToLines, priceCart, type PricedCart } from './cart.js';
import { postTxn, saleEntries } from './ledger.js';
import { enqueue } from './outbox.js';
import { getProvider } from './payments.js';
import { POSTAL, PROVINCES, normalisePostal } from './shipping.js';
import { config } from '../config.js';

export interface Address { name: string; line1: string; line2?: string; city: string; region: string; postal: string; country: 'CA'; phone?: string }
export function cleanAddress(a: any): Address {
  const region = String(a?.region ?? '').toUpperCase(); if (!PROVINCES.includes(region)) throw new HttpError(422, 'invalid_province'); if (!POSTAL.test(String(a?.postal ?? ''))) throw new HttpError(422, 'invalid_postal_code');
  return { name: String(a.name).trim(), line1: String(a.line1).trim(), ...(a.line2 ? { line2: String(a.line2).trim() } : {}), city: String(a.city).trim(), region, postal: normalisePostal(a.postal), country: 'CA', ...(a.phone ? { phone: String(a.phone).trim() } : {}) };
}
const sellerEmails = async (c: Client, sellerId: string) => (await c.query(`SELECT u.email FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.seller_id=$1 AND r.role IN ('seller_owner','seller_manager') AND u.status='active'`, [sellerId])).rows.map(r => r.email as string);

/** Release held stock for an order (payment failed, order cancelled, or the hold ran out). Caller holds a transaction. */
export async function releaseHolds(c: Client, orderId: string) {
  const held = (await c.query(`SELECT id, variant_id, quantity FROM stock_reservations WHERE order_id=$1 AND status='held' ORDER BY variant_id FOR UPDATE`, [orderId])).rows;
  for (const h of held) { await c.query('UPDATE variants SET stock_reserved = stock_reserved - $2 WHERE id=$1', [h.variant_id, h.quantity]); await c.query(`UPDATE stock_reservations SET status='released' WHERE id=$1`, [h.id]); }
  return held.length;
}
async function cancelUnpaid(c: Client, orderId: string, why: string) {
  await releaseHolds(c, orderId);
  await c.query(`UPDATE orders SET status='cancelled', payment_status=CASE WHEN payment_status='pending' THEN 'failed' ELSE payment_status END WHERE id=$1`, [orderId]);
  await c.query(`UPDATE seller_orders SET status='cancelled' WHERE order_id=$1 AND status='awaiting_payment'`, [orderId]);
  // The payment row stays 'pending' on purpose: the provider may still report success after we gave up (late payment), and settlePayment must see it then.
  await audit(c, { action: 'order.cancel_unpaid', entityType: 'order', entityId: orderId, reason: why });
}

export interface CheckoutInput { cartId: string; userId: string | null; email: string; address: Address; idempotencyKey?: string; ip?: string; now?: Date }
/** Turn a cart into an order: reserve stock (stable lock order), snapshot every line, split per seller, compute GST and commission in integer cents. The provider is called AFTER the commit. */
export async function checkout(i: CheckoutInput) {
  const provider = getProvider(); if (!provider) throw new HttpError(503, 'payments_not_configured');
  const now = i.now ?? new Date(); const settings = await allSettings(); const holdMinutes = settings.reservation_minutes as number;
  if (i.idempotencyKey) { const hit = (await pool.query('SELECT id FROM orders WHERE idempotency_key=$1', [i.idempotencyKey])).rows[0]; if (hit) return { ...(await orderSummary(hit.id)), replay: true }; }
  const created = await tx(async c => {
    await c.query('SELECT 1 FROM carts WHERE id=$1 FOR UPDATE', [i.cartId]);                          // one checkout per cart at a time
    for (const old of (await c.query(`SELECT id FROM orders WHERE cart_id=$1 AND status='awaiting_payment' FOR UPDATE`, [i.cartId])).rows) await cancelUnpaid(c, old.id, 'replaced by a new checkout');
    const cart: PricedCart = await priceCart(c, i.cartId, now); if (!cart.count) throw new HttpError(422, 'cart_empty');
    const bad = cart.groups.flatMap(g => g.lines.filter(l => l.issue).map(l => ({ variantId: l.variantId, title: l.title, issue: l.issue }))); if (bad.length) throw new HttpError(409, bad.some(b => b.issue === 'out_of_stock') ? 'out_of_stock' : 'items_unavailable', bad);
    // Reserve stock. Variants are locked in id order, so two checkouts can never deadlock; the UPDATE only succeeds if enough is free.
    const need = new Map<string, number>(); for (const g of cart.groups) for (const l of g.lines) if (l.tracksStock) need.set(l.variantId, (need.get(l.variantId) ?? 0) + l.quantity);
    for (const [variantId, qty] of [...need].sort((a, b) => a[0].localeCompare(b[0]))) {
      const r = await c.query('UPDATE variants SET stock_reserved = stock_reserved + $2 WHERE id=$1 AND stock_on_hand - stock_reserved >= $2', [variantId, qty]);
      if (!r.rowCount) throw new HttpError(409, 'out_of_stock', [{ variantId }]);
    }
    const expires = new Date(now.getTime() + holdMinutes * 60_000); const token = randomBytes(24).toString('base64url');
    const order = (await c.query(`INSERT INTO orders(user_id,email,buyer_name,ship_to,public_token,items_cents,shipping_cents,tax_cents,total_cents,cart_id,reservation_expires_at,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, number`,
      [i.userId, i.email, i.address.name, JSON.stringify(i.address), token, cart.itemsCents, cart.shippingCents, cart.taxCents, cart.totalCents, i.cartId, expires, i.idempotencyKey ?? null])).rows[0];
    for (const [variantId, qty] of need) await c.query('INSERT INTO stock_reservations(order_id,variant_id,quantity,expires_at) VALUES ($1,$2,$3,$4)', [order.id, variantId, qty, expires]);
    for (const g of cart.groups) {
      const commission = allocateToLines(g).reduce((n, x) => n + x.commissionCents, 0);
      const so = (await c.query(`INSERT INTO seller_orders(order_id,seller_id,shop_id,items_cents,shipping_cents,tax_cents,total_cents,commission_bps,commission_cents,gift,est_delivery_min,est_delivery_max) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [order.id, g.sellerId, g.shopId, g.itemsCents, g.shippingCents, g.taxCents, g.totalCents, g.commissionBps, commission, g.gift?.isGift ? JSON.stringify(g.gift) : null, g.eta.min, g.eta.max])).rows[0];
      for (const x of allocateToLines(g)) { const l = x.line;
        await c.query(`INSERT INTO order_lines(order_id,seller_order_id,product_id,variant_id,title,variant_label,options,sku,image_media_id,art_kind,art_tone,unit_price_cents,quantity,tax_cents,commission_cents,personalisation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [order.id, so.id, l.productId, l.variantId, l.title, l.variantLabel, JSON.stringify(l.options), l.sku, l.imageMediaId, l.art?.kind ?? null, l.art?.tone ?? null, l.unitCents, l.quantity, x.taxCents, x.commissionCents, JSON.stringify(l.personalisation)]); }
    }
    await audit(c, { actor: i.userId, area: 'shop', action: 'order.create', entityType: 'order', entityId: order.id, next: { number: Number(order.number), totalCents: cart.totalCents, sellers: cart.groups.length }, ip: i.ip });
    return { orderId: order.id as string, totalCents: cart.totalCents, expires };
  });
  // Provider call happens after the order and the stock holds are safely committed.
  try {
    const intent = await provider.createIntent({ orderId: created.orderId, amountCents: created.totalCents, currency: 'CAD', idempotencyKey: created.orderId });
    await pool.query('INSERT INTO payments(order_id,provider,provider_ref,amount_cents) VALUES ($1,$2,$3,$4)', [created.orderId, provider.name, intent.providerRef, created.totalCents]);
    return { ...(await orderSummary(created.orderId)), payment: { provider: provider.name, simulated: provider.simulated, ref: intent.providerRef, clientSecret: intent.clientSecret ?? null }, replay: false };
  } catch (e) {
    await tx(c => cancelUnpaid(c, created.orderId, 'payment provider error')); throw new HttpError(502, 'payment_provider_error');
  }
}

export async function orderSummary(orderId: string) {
  const o = (await pool.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0]; const sos = (await pool.query(`SELECT so.*, s.name AS shop_name, s.slug AS shop_slug FROM seller_orders so JOIN shops s ON s.id=so.shop_id WHERE so.order_id=$1 ORDER BY so.created_at, so.id`, [orderId])).rows;
  const lines = (await pool.query('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [orderId])).rows;
  return { orderId: o.id as string, number: Number(o.number), token: o.public_token as string, status: o.status, paymentStatus: o.payment_status, itemsCents: o.items_cents, shippingCents: o.shipping_cents, taxCents: o.tax_cents, totalCents: o.total_cents, expiresAt: o.reservation_expires_at,
    sellers: sos.map(so => ({ id: so.id, shop: { name: so.shop_name, slug: so.shop_slug }, status: so.status, itemsCents: so.items_cents, shippingCents: so.shipping_cents, taxCents: so.tax_cents, totalCents: so.total_cents, eta: { min: so.est_delivery_min, max: so.est_delivery_max },
      lines: lines.filter(l => l.seller_order_id === so.id).map(l => ({ id: l.id, title: l.title, variant: l.variant_label, quantity: l.quantity, unitCents: l.unit_price_cents })) })) };
}

/**
 * Apply a payment result. Idempotent: the same event or the same outcome twice changes nothing the second time.
 * Success: order confirmed, stock committed, one balanced ledger transaction per seller order, emails queued. Failure: stock released, order cancelled.
 */
export async function settlePayment(providerRef: string, outcome: 'succeeded' | 'failed', eventId?: string) {
  return tx(async c => {
    if (eventId && !(await c.query(`INSERT INTO webhook_events(id,provider) VALUES ($1,'mock') ON CONFLICT DO NOTHING RETURNING id`, [eventId])).rowCount) return { status: 'duplicate_event' as const };
    const p = (await c.query('SELECT * FROM payments WHERE provider_ref=$1 FOR UPDATE', [providerRef])).rows[0]; if (!p) throw new HttpError(404, 'payment_not_found');
    if (p.status !== 'pending') return { status: p.status === outcome ? ('replay' as const) : ('ignored' as const) };
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [p.order_id])).rows[0];
    if (outcome === 'failed') { await c.query(`UPDATE payments SET status='failed' WHERE id=$1`, [p.id]); if (o.status === 'awaiting_payment') await cancelUnpaid(c, o.id, 'payment failed'); return { status: 'failed' as const }; }
    if (p.amount_cents !== o.total_cents) throw new HttpError(409, 'amount_mismatch');                     // never mark an order paid for the wrong amount
    if (o.status === 'cancelled') {                                                                       // paid after the hold ran out: take the stock again if it is still there, else refund in full
      const lines = (await c.query(`SELECT variant_id, sum(quantity)::int AS qty FROM order_lines l JOIN variants v ON v.id=l.variant_id WHERE l.order_id=$1 AND v.tracks_stock GROUP BY variant_id ORDER BY variant_id`, [o.id])).rows;
      for (const l of lines) { const r = await c.query('UPDATE variants SET stock_reserved = stock_reserved + $2 WHERE id=$1 AND stock_on_hand - stock_reserved >= $2', [l.variant_id, l.qty]); if (!r.rowCount) { await c.query(`UPDATE payments SET status='succeeded' WHERE id=$1`, [p.id]); await c.query(`UPDATE orders SET payment_status='refunded' WHERE id=$1`, [o.id]);
        await audit(c, { action: 'order.late_payment_refund', entityType: 'order', entityId: o.id, reason: 'paid after the stock hold expired and the stock was gone' }); await enqueue(c, o.email, 'order_cancelled', { number: Number(o.number) }); return { status: 'late_refund' as const, refundNeeded: { providerRef, amountCents: p.amount_cents } }; } }
      for (const l of lines) await c.query(`INSERT INTO stock_reservations(order_id,variant_id,quantity,expires_at) VALUES ($1,$2,$3,now())`, [o.id, l.variant_id, l.qty]);
      await c.query(`UPDATE seller_orders SET status='awaiting_payment' WHERE order_id=$1 AND status='cancelled'`, [o.id]);
    }
    await c.query(`UPDATE payments SET status='succeeded' WHERE id=$1`, [p.id]);
    for (const h of (await c.query(`SELECT id, variant_id, quantity FROM stock_reservations WHERE order_id=$1 AND status='held' ORDER BY variant_id FOR UPDATE`, [o.id])).rows) {
      await c.query('UPDATE variants SET stock_on_hand = stock_on_hand - $2, stock_reserved = stock_reserved - $2 WHERE id=$1', [h.variant_id, h.quantity]); await c.query(`UPDATE stock_reservations SET status='committed' WHERE id=$1`, [h.id]); }
    await c.query(`UPDATE orders SET status='confirmed', payment_status='paid', paid_at=now() WHERE id=$1`, [o.id]);
    const sos = (await c.query(`SELECT so.*, s.name AS shop_name, s.processing_days_max FROM seller_orders so JOIN shops s ON s.id=so.shop_id WHERE so.order_id=$1 ORDER BY so.id`, [o.id])).rows; const base = (process.env.PUBLIC_URL ?? 'http://localhost:5180');
    for (const so of sos) {
      const shipBy = (await c.query(`UPDATE seller_orders SET status='new', ship_by=(now() + ($2 || ' days')::interval)::date WHERE id=$1 RETURNING to_char(ship_by,'YYYY-MM-DD') AS d`, [so.id, String(so.processing_days_max)])).rows[0].d as string;
      await postTxn(c, { orderId: o.id, sellerOrderId: so.id, sellerId: so.seller_id, memo: 'sale', entries: saleEntries(so) });
      const lines = (await c.query('SELECT title, variant_label, quantity FROM order_lines WHERE seller_order_id=$1 ORDER BY id', [so.id])).rows;
      for (const to of await sellerEmails(c, so.seller_id)) await enqueue(c, to, 'seller_new_order', { number: Number(o.number), buyer: o.buyer_name, totalCents: so.total_cents, shipBy, gift: so.gift?.message ?? null, url: `${base}/studio/orders/${so.id}`, lines: lines.map(l => ({ title: l.title, variant: l.variant_label, quantity: l.quantity })) });
    }
    const all = (await c.query('SELECT l.title, l.quantity, l.seller_order_id FROM order_lines l WHERE l.order_id=$1 ORDER BY l.id', [o.id])).rows;
    await enqueue(c, o.email, 'order_confirmation', { number: Number(o.number), name: o.buyer_name, totalCents: o.total_cents, taxCents: o.tax_cents, url: `${base}/orders/${o.public_token}`,
      sellers: sos.map(so => ({ shop: so.shop_name, eta: `${so.est_delivery_min} to ${so.est_delivery_max}`, lines: all.filter(l => l.seller_order_id === so.id).map(l => ({ title: l.title, quantity: l.quantity })) })) });
    if (o.cart_id) { await c.query('DELETE FROM cart_items WHERE cart_id=$1 AND variant_id IN (SELECT variant_id FROM order_lines WHERE order_id=$2)', [o.cart_id, o.id]); await c.query('DELETE FROM cart_gifts WHERE cart_id=$1', [o.cart_id]); }
    await audit(c, { action: 'order.paid', entityType: 'order', entityId: o.id, next: { totalCents: o.total_cents } });
    return { status: 'paid' as const };
  });
}

/** Cancel orders whose payment never arrived and give their stock back. Run every minute. */
export async function releaseExpiredReservations(now = new Date()) {
  return tx(async c => { const due = (await c.query(`SELECT id FROM orders WHERE status='awaiting_payment' AND reservation_expires_at < $1 FOR UPDATE SKIP LOCKED`, [now])).rows;
    for (const o of due) await cancelUnpaid(c, o.id, 'reservation expired'); return due.length; });
}
void config;
