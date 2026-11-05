import { audit, pool, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { allocate } from './money.js';
import { postTxn, type Entry } from './ledger.js';
import { enqueue } from './outbox.js';
import { getProvider } from './payments.js';

export interface RefundInput { sellerOrderId: string; sellerId: string; lines: { lineId: string; quantity: number }[]; includeShipping: boolean; reason: string; restock: boolean; actor: string; idempotencyKey?: string }
/** The units of a line split exactly (largest remainder), so refunding unit by unit returns exactly the line's tax and commission in total, never a cent more or less. */
const unitShares = (total: number, qty: number) => allocate(total, Array(qty).fill(1));

/**
 * Refund part or all of ONE seller's part of an order. Step 1 (one transaction): compute the amounts from the stored snapshot, mark the units as refunded so nothing can be refunded twice, record a pending refund.
 * Step 2 (after commit): ask the provider. Step 3 (one transaction): on success write the reversing ledger entries; on failure undo step 1 and report.
 */
export async function refund(i: RefundInput) {
  const provider = getProvider(); if (!provider) throw new HttpError(503, 'payments_not_configured');
  if (i.idempotencyKey) { const hit = (await pool.query('SELECT id, status, amount_cents FROM refunds WHERE idempotency_key=$1', [i.idempotencyKey])).rows[0]; if (hit) return { refundId: hit.id as string, amountCents: hit.amount_cents as number, status: hit.status as string, replay: true }; }
  const step1 = await tx(async c => {
    const so = (await c.query('SELECT so.*, o.payment_status, o.email, o.number FROM seller_orders so JOIN orders o ON o.id=so.order_id WHERE so.id=$1 AND so.seller_id=$2 FOR UPDATE OF so', [i.sellerOrderId, i.sellerId])).rows[0]; if (!so) throw new HttpError(404, 'not_found');
    if (!['paid', 'partially_refunded'].includes(so.payment_status) || so.status === 'awaiting_payment') throw new HttpError(409, 'not_refundable');
    const pay = (await c.query(`SELECT * FROM payments WHERE order_id=$1 AND status='succeeded' ORDER BY created_at LIMIT 1`, [so.order_id])).rows[0]; if (!pay) throw new HttpError(409, 'no_captured_payment');
    const lines = (await c.query('SELECT * FROM order_lines WHERE seller_order_id=$1 ORDER BY id FOR UPDATE', [so.id])).rows; const lineTaxSum = lines.reduce((n, l) => n + l.tax_cents, 0);
    let items = 0, tax = 0, comm = 0; const detail: { lineId: string; quantity: number }[] = [];
    for (const r of i.lines) {
      const l = lines.find(x => x.id === r.lineId); if (!l) throw new HttpError(422, 'line_not_in_order'); if (r.quantity < 1 || r.quantity > l.quantity - l.refunded_qty) throw new HttpError(422, 'quantity_exceeds_remaining', { lineId: l.id, remaining: l.quantity - l.refunded_qty });
      const taxU = unitShares(l.tax_cents, l.quantity), comU = unitShares(l.commission_cents, l.quantity); const from = l.refunded_qty, to = from + r.quantity;
      items += l.unit_price_cents * r.quantity; tax += taxU.slice(from, to).reduce((a, b) => a + b, 0); comm += comU.slice(from, to).reduce((a, b) => a + b, 0); detail.push(r);
      await c.query('UPDATE order_lines SET refunded_qty = refunded_qty + $2 WHERE id=$1', [l.id, r.quantity]);
    }
    let shipping = 0; if (i.includeShipping) { if (so.shipping_refunded) throw new HttpError(422, 'shipping_already_refunded'); shipping = so.shipping_cents; tax += so.tax_cents - lineTaxSum; await c.query('UPDATE seller_orders SET shipping_refunded=true WHERE id=$1', [so.id]); }
    const amount = items + tax + shipping; if (amount <= 0) throw new HttpError(422, 'nothing_to_refund'); if (amount > so.total_cents - so.refunded_cents) throw new HttpError(422, 'exceeds_refundable', { remaining: so.total_cents - so.refunded_cents });
    await c.query('UPDATE seller_orders SET refunded_cents = refunded_cents + $2 WHERE id=$1', [so.id, amount]);
    const r = (await c.query(`INSERT INTO refunds(order_id,seller_order_id,payment_id,amount_cents,commission_returned_cents,tax_returned_cents,reason,lines,restock,idempotency_key,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [so.order_id, so.id, pay.id, amount, comm, tax, i.reason, JSON.stringify({ lines: detail, shipping: i.includeShipping }), i.restock, i.idempotencyKey ?? null, i.actor]).catch(e => { if (e.code === '23505') throw new HttpError(409, 'idempotency_key_reused'); throw e; })).rows[0];
    return { refundId: r.id as string, amount, items, tax, shipping, comm, so, pay, detail };
  });
  let providerRef: string;
  try { providerRef = (await provider.refund({ paymentRef: step1.pay.provider_ref, amountCents: step1.amount, idempotencyKey: step1.refundId })).providerRef; }
  catch {
    await tx(async c => { for (const d of step1.detail) await c.query('UPDATE order_lines SET refunded_qty = refunded_qty - $2 WHERE id=$1', [d.lineId, d.quantity]);
      await c.query('UPDATE seller_orders SET refunded_cents = refunded_cents - $2, shipping_refunded = CASE WHEN $3 THEN false ELSE shipping_refunded END WHERE id=$1', [step1.so.id, step1.amount, i.includeShipping]);
      await c.query(`UPDATE refunds SET status='failed' WHERE id=$1`, [step1.refundId]); await audit(c, { actor: i.actor, area: 'studio', action: 'refund.failed', entityType: 'refund', entityId: step1.refundId }); });
    throw new HttpError(502, 'refund_provider_error');
  }
  await tx(async c => {
    await c.query(`UPDATE refunds SET status='succeeded', provider_ref=$2 WHERE id=$1`, [step1.refundId, providerRef]);
    // Reverse the sale in proportion: cash goes back, the seller owes less, commission and GST come back by the same shares.
    const entries: Entry[] = [{ account: 'cash', amountCents: -step1.amount }, { account: 'seller_payable', amountCents: step1.items + step1.shipping - step1.comm }, { account: 'commission_revenue', amountCents: step1.comm }, { account: 'tax_payable', amountCents: step1.tax }];
    await postTxn(c, { orderId: step1.so.order_id, sellerOrderId: step1.so.id, sellerId: i.sellerId, memo: 'refund', entries });
    const t = (await c.query('SELECT sum(total_cents)::int AS total, sum(refunded_cents)::int AS refunded FROM seller_orders WHERE order_id=$1', [step1.so.order_id])).rows[0];
    await c.query('UPDATE orders SET payment_status=$2 WHERE id=$1', [step1.so.order_id, t.refunded >= t.total ? 'refunded' : 'partially_refunded']);
    if (i.restock) for (const d of step1.detail) await c.query('UPDATE variants SET stock_on_hand = stock_on_hand + $2 WHERE id = (SELECT variant_id FROM order_lines WHERE id=$1) AND tracks_stock', [d.lineId, d.quantity]);
    const shop = (await c.query('SELECT s.name FROM shops s WHERE s.id=$1', [step1.so.shop_id])).rows[0];
    await enqueue(c, step1.so.email, 'refund_issued', { number: Number(step1.so.number), shop: shop.name, amountCents: step1.amount, reason: i.reason });
    await audit(c, { actor: i.actor, area: 'studio', action: 'refund.succeeded', entityType: 'refund', entityId: step1.refundId, next: { amountCents: step1.amount, commissionReturnedCents: step1.comm, taxReturnedCents: step1.tax }, reason: i.reason });
  });
  return { refundId: step1.refundId, amountCents: step1.amount, status: 'succeeded', replay: false };
}
