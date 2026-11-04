import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { getProvider } from '../lib/payments.js';
import { enqueue, url as mailUrl } from '../lib/mail.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const REFUNDABLE = ['paid', 'processing', 'ready', 'shipped', 'completed', 'refunded'];

/**
 * Refunds. Rules enforced here and in the database:
 *  - never more than the order total in aggregate (CHECK on orders.refunded_cents, row lock held while computing)
 *  - ledger stays balanced: cash out, platform fee returned pro rata, seller payable reduced
 *  - idempotent on an optional client key (a double click or retry cannot refund twice)
 *  - restocking is only offered for full refunds (partial refunds don't say which units came back)
 * NOTE: the provider call happens inside the transaction holding the order lock. Fine for the simulated adapter; a real
 * provider integration must record intent first and reconcile, so that a crash after the call cannot lose the refund.
 */
export function registerRefunds(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx> }) {
  app.post('/api/seller/orders/:id/refunds', async (req, reply) => {
    const t = await deps.tenantCtx(req); if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ amountCents: z.number().int().min(1).max(100_000_000), reason: z.string().trim().min(3).max(300),
      restock: z.boolean().default(false), key: z.string().min(8).max(100).optional() }).strict().parse(req.body);
    const provider = getProvider(); if (!provider) throw new HttpError(503, 'payments_not_configured');

    const out = await withTx(t, async c => {
      if (b.key) { const prior = (await c.query('SELECT id, amount_cents, order_id FROM refunds WHERE idempotency_key=$1', [b.key])).rows[0];
        if (prior) { if (prior.order_id !== id) throw new HttpError(409, 'idempotency_key_reused'); return { id: prior.id as string, replay: true }; } }
      const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!o) throw new HttpError(404, 'not_found');
      if (!REFUNDABLE.includes(o.status)) throw new HttpError(409, `not_refundable:${o.status}`);
      const remaining = o.total_cents - o.refunded_cents;
      if (b.amountCents > remaining) throw new HttpError(422, `exceeds_refundable:${remaining}`);
      const full = b.amountCents === remaining && o.refunded_cents === 0;
      if (b.restock && !(b.amountCents === remaining)) throw new HttpError(422, 'restock_requires_full_refund');
      if (b.restock && o.refunded_cents > 0) throw new HttpError(422, 'restock_requires_full_refund');
      const pay = (await c.query(`SELECT * FROM payments WHERE order_id=$1 AND status='succeeded' ORDER BY created_at LIMIT 1`, [id])).rows[0];
      if (!pay) throw new HttpError(409, 'no_captured_payment');

      const pr = await provider.refund({ paymentRef: pay.provider_ref, amountCents: b.amountCents, idempotencyKey: b.key ?? `${id}:${o.refunded_cents}:${b.amountCents}` });
      const r = (await c.query(
        `INSERT INTO refunds(tenant_id,order_id,payment_id,amount_cents,reason,restocked,provider,provider_ref,idempotency_key,actor_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [t.tenantId, id, pay.id, b.amountCents, b.reason, b.restock, provider.name, pr.providerRef, b.key ?? null, t.userId])).rows[0];

      // Platform fee is returned pro rata so the seller is not charged a fee on money that went back to the customer.
      const origFee = Math.floor((o.subtotal_cents * o.platform_fee_bps) / 10000);
      const doneNow = b.amountCents === remaining;
      const returned = (await c.query(`SELECT coalesce(sum(amount_cents) FILTER (WHERE account='platform_fee'),0)::int AS fee, coalesce(sum(amount_cents) FILTER (WHERE account='tax_payable'),0)::int AS tax
                                       FROM ledger_entries WHERE order_id=$1 AND memo='refund'`, [id])).rows[0];
      // Pro rata, rounded down; the final refund returns whatever is left so fee and tax come back exactly, with no rounding residue.
      const feeBack = doneNow ? origFee - returned.fee : Math.floor((origFee * b.amountCents) / o.total_cents);
      const taxBack = doneNow ? o.tax_cents - returned.tax : Math.floor((o.tax_cents * b.amountCents) / o.total_cents);
      const g = (await c.query('SELECT gen_random_uuid() id')).rows[0].id;
      const led = (acct: string, amt: number) => c.query(
        `INSERT INTO ledger_entries(tenant_id,group_id,order_id,account,amount_cents,currency,memo) VALUES ($1,$2,$3,$4,$5,$6,'refund')`, [t.tenantId, g, id, acct, amt, o.currency]);
      await led('cash_received', -b.amountCents); await led('platform_fee', feeBack);
      if (taxBack > 0) await led('tax_payable', taxBack);
      await led('seller_payable', b.amountCents - feeBack - taxBack);

      if (b.restock) {
        const items = (await c.query(`SELECT i.variant_id, i.quantity FROM order_items i JOIN product_variants v ON v.id=i.variant_id WHERE i.order_id=$1 AND v.track_inventory`, [id])).rows;
        for (const i of items) {
          await c.query('UPDATE inventory_levels SET on_hand = on_hand + $2 WHERE variant_id=$1', [i.variant_id, i.quantity]);
          await c.query(`INSERT INTO inventory_movements(tenant_id,variant_id,delta,reason,order_id,actor_user_id,note) VALUES ($1,$2,$3,'return',$4,$5,'Refund restock')`, [t.tenantId, i.variant_id, i.quantity, id, t.userId]);
        }
      }
      const done = b.amountCents === remaining;
      await c.query(`UPDATE orders SET refunded_cents = refunded_cents + $2, status = CASE WHEN $3 THEN 'refunded' ELSE status END, updated_at=now() WHERE id=$1`, [id, b.amountCents, done]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'order.refund', entityType: 'order', entityId: id, next: { amountCents: b.amountCents, restocked: b.restock, full: done }, reason: b.reason });
      const st = (await c.query('SELECT name FROM stores WHERE id=$1', [o.store_id])).rows[0]?.name ?? 'the store';
      await enqueue(c, { tenantId: t.tenantId, to: o.customer_email, template: 'refund_issued', data: { number: Number(o.number), amount: b.amountCents, currency: o.currency, storeName: st, url: mailUrl(`/order/${o.public_token}`) } });
      return { id: r.id as string, replay: false, refundedCents: o.refunded_cents + b.amountCents, status: done ? 'refunded' : o.status };
    });
    return reply.code(out.replay ? 200 : 201).send(out);
  });

  app.get('/api/seller/orders/:id/refunds', async (req) => {
    const t = await deps.tenantCtx(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withTx(t, async c => (await c.query('SELECT id, amount_cents, reason, restocked, kind, created_at FROM refunds WHERE order_id=$1 ORDER BY created_at', [id])).rows);
  });

  // Payments that succeeded after the reservation expired and stock was gone: money held, order not fulfilled.
  app.get('/api/seller/attention', async (req) => {
    const t = await deps.tenantCtx(req);
    return withTx(t, async c => ({ unfulfilledPayments: (await c.query(
      `SELECT p.id, p.amount_cents, p.currency, o.number AS "orderNumber", o.customer_name AS "customerName", p.created_at
       FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.needs_refund AND p.refund_resolved_at IS NULL ORDER BY p.created_at`)).rows }));
  });

  app.post('/api/seller/payments/:id/refund-unfulfilled', async (req) => {
    const t = await deps.tenantCtx(req); if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const provider = getProvider(); if (!provider) throw new HttpError(503, 'payments_not_configured');
    return withTx(t, async c => {
      const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new HttpError(404, 'not_found');
      if (!p.needs_refund || p.refund_resolved_at) throw new HttpError(409, 'nothing_to_refund');
      const pr = await provider.refund({ paymentRef: p.provider_ref, amountCents: p.amount_cents, idempotencyKey: `unfulfilled:${id}` });
      // No ledger entries exist for this payment (it was never recorded as a sale), so only the refund record is written.
      await c.query(`INSERT INTO refunds(tenant_id,order_id,payment_id,amount_cents,reason,kind,provider,provider_ref,idempotency_key,actor_user_id)
                     VALUES ($1,$2,$3,$4,'Order could not be fulfilled (stock unavailable)','unfulfilled',$5,$6,$7,$8)`,
        [t.tenantId, p.order_id, id, p.amount_cents, provider.name, pr.providerRef, `unfulfilled:${id}`, t.userId]);
      await c.query('UPDATE payments SET refund_resolved_at=now() WHERE id=$1', [id]);
      const uo = (await c.query('SELECT o.number, o.customer_email, o.public_token, o.currency, s.name AS store_name FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.id=$1', [p.order_id])).rows[0];
      await enqueue(c, { tenantId: t.tenantId, to: uo.customer_email, template: 'refund_issued', data: { number: Number(uo.number), amount: p.amount_cents, currency: uo.currency, storeName: uo.store_name, url: mailUrl(`/order/${uo.public_token}`) } });
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'payment.refund_unfulfilled', entityType: 'payment', entityId: id, next: { amountCents: p.amount_cents } });
      return { ok: true };
    });
  });
}
