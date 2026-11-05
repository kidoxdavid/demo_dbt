import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { orderProfits, priceCheck, PROCESSING, type OrderProfit } from '../lib/profit.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const CATEGORIES = ['ads', 'packaging', 'supplies', 'software', 'other'] as const;

/** Profit-first: what the seller keeps per order, product, day and channel, after every cost we know about. See lib/profit.ts for the exact definition. */
export function registerProfit(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx> }) {
  const { tenantCtx } = deps;
  const ok = (t: TenantCtx) => { if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden'); };
  const range = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), tz: z.string().max(40).default('UTC') });
  const sum = (rows: OrderProfit[], k: keyof OrderProfit) => rows.reduce((n, r) => n + (r[k] as number), 0);

  app.get('/api/seller/profit', async (req) => {
    const t = await tenantCtx(req); ok(t);
    const q = range.parse(req.query);
    try { new Intl.DateTimeFormat('en', { timeZone: q.tz }); } catch { throw new HttpError(400, 'invalid_timezone'); }
    const from = q.from ?? '1970-01-01T00:00:00Z'; const to = q.to ?? '2999-01-01T00:00:00Z';
    return withTx(t, async c => {
      const orders = await orderProfits(c, from, to);
      const expenses = (await c.query(
        `SELECT category, coalesce(sum(amount_cents),0)::int AS cents FROM expenses WHERE spent_on BETWEEN ($1::timestamptz AT TIME ZONE $3)::date AND ($2::timestamptz AT TIME ZONE $3)::date GROUP BY category ORDER BY cents DESC`, [from, to, q.tz])).rows;
      const expensesTotal = expenses.reduce((n, r) => n + r.cents, 0);
      const totals = { orders: orders.length, salesCents: sum(orders, 'salesCents'), discountsCents: sum(orders, 'discountCents'), deliveryChargedCents: sum(orders, 'deliveryChargedCents'), cogsCents: sum(orders, 'cogsCents'),
        platformFeesCents: sum(orders, 'platformFeeCents'), processingFeesCents: sum(orders, 'processingFeeCents'), deliveryPaidCents: sum(orders, 'deliveryPaidCents'), refundsCents: sum(orders, 'refundsCents'),
        keepCents: sum(orders, 'keepCents'), expensesCents: expensesTotal, keepAfterExpensesCents: sum(orders, 'keepCents') - expensesTotal };
      const day = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: q.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
      const byDayMap = new Map<string, { date: string; orders: number; salesCents: number; keepCents: number }>();
      for (const o of orders) { const d = day(o.createdAt); const r = byDayMap.get(d) ?? { date: d, orders: 0, salesCents: 0, keepCents: 0 }; r.orders++; r.salesCents += o.salesCents; r.keepCents += o.keepCents; byDayMap.set(d, r); }
      const channels = new Map<string, { channel: string; orders: number; salesCents: number; keepCents: number }>();
      for (const o of orders) { const k = o.channel === 'pos' ? 'Counter' : o.source === 'direct' ? 'Direct' : o.source; const r = channels.get(k) ?? { channel: k, orders: 0, salesCents: 0, keepCents: 0 }; r.orders++; r.salesCents += o.salesCents; r.keepCents += o.keepCents; channels.set(k, r); }
      // Per product: each order's discount, fee and card fee are shared across its items by their share of the sale. Delivery and refunds are order-level and not allocated.
      const byOrder = new Map(orders.map(o => [o.id, o]));
      const items = orders.length ? (await c.query(`SELECT i.order_id, i.name, i.quantity, i.unit_price_cents, i.unit_cost_cents FROM order_items i WHERE i.order_id = ANY($1::uuid[])`, [orders.map(o => o.id)])).rows : [];
      const subtotals = new Map<string, number>(); for (const i of items) subtotals.set(i.order_id, (subtotals.get(i.order_id) ?? 0) + i.quantity * i.unit_price_cents);
      const prod = new Map<string, { name: string; units: number; salesCents: number; keepCents: number; missingCost: boolean }>();
      for (const i of items) {
        const o = byOrder.get(i.order_id)!; const S = subtotals.get(i.order_id)!; const rev = i.quantity * i.unit_price_cents; const share = S ? rev / S : 0;
        const keep = rev - o.discountCents * share - i.quantity * (i.unit_cost_cents ?? 0) - o.platformFeeCents * share - o.processingFeeCents * share;
        const r = prod.get(i.name) ?? { name: i.name, units: 0, salesCents: 0, keepCents: 0, missingCost: false }; r.units += i.quantity; r.salesCents += Math.round(rev - o.discountCents * share); r.keepCents += Math.round(keep); r.missingCost ||= i.unit_cost_cents == null; prod.set(i.name, r);
      }
      const byProduct = [...prod.values()].map(p => ({ ...p, keepPerUnitCents: p.units ? Math.round(p.keepCents / p.units) : 0 })).sort((a, b) => b.keepCents - a.keepCents);
      return { currency: 'CAD', totals, expenses, byDay: [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date)), byChannel: [...channels.values()].sort((a, b) => b.keepCents - a.keepCents), byProduct,
        flags: { itemsMissingCost: sum(orders, 'missingCostLines'), deliveryOrdersMissingCost: orders.filter(o => o.deliveryCostMissing).length, processingFeeIsEstimate: orders.some(o => o.channel !== 'pos'), processingFeeRate: PROCESSING },
        notes: ['Sales tax is never counted: it is collected for the tax authority.', 'Card-processing fees are an estimate until a payment provider is connected; counter sales show none because we cannot see your own terminal fees.',
          'Items without a cost price count as zero cost, which overstates what you keep. Delivery you paid for is only included once you enter it on the order.', 'Per-product figures share discount and fees by sale value; delivery and refunds are not split by product.'] };
    });
  });

  app.get('/api/seller/orders/:id/profit', async (req) => {
    const t = await tenantCtx(req); ok(t);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await withTx(t, async c => (await orderProfits(c, '1970-01-01T00:00:00Z', '2999-01-01T00:00:00Z', id))[0]);
    if (!r) throw new HttpError(404, 'not_found');           // also the answer for orders that do not count yet (unpaid, cancelled)
    return { ...r, processingFeeIsEstimate: r.channel !== 'pos' };
  });

  app.patch('/api/seller/orders/:id/delivery-cost', async (req) => {
    const t = await tenantCtx(req); ok(t);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ cents: z.number().int().min(0).max(1_000_000).nullable() }).strict().parse(req.body);
    return withTx(t, async c => {
      const prev = (await c.query('SELECT shipping_cost_cents FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!prev) throw new HttpError(404, 'not_found');
      await c.query('UPDATE orders SET shipping_cost_cents=$2, updated_at=now() WHERE id=$1', [id, b.cents]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'order.delivery_cost', entityType: 'order', entityId: id, prev: { cents: prev.shipping_cost_cents }, next: { cents: b.cents } });
      return { id, deliveryCostCents: b.cents };
    });
  });

  // ---------------- Expenses (ads, packaging...) ----------------
  app.get('/api/seller/expenses', async (req) => {
    const t = await tenantCtx(req); ok(t);
    return withTx(t, async c => (await c.query(`SELECT id, spent_on AS "spentOn", category, amount_cents AS "amountCents", note FROM expenses ORDER BY spent_on DESC, created_at DESC LIMIT 200`)).rows);
  });
  app.post('/api/seller/expenses', async (req, reply) => {
    const t = await tenantCtx(req); ok(t);
    const b = z.object({ spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), category: z.enum(CATEGORIES), amountCents: z.number().int().min(1).max(100_000_000), note: z.string().trim().max(200).optional() }).strict().parse(req.body);
    const row = await withTx(t, async c => {
      const r = (await c.query(`INSERT INTO expenses(tenant_id,spent_on,category,amount_cents,note,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [t.tenantId, b.spentOn, b.category, b.amountCents, b.note || null, t.userId])).rows[0];
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'expense.create', entityType: 'expense', entityId: r.id, next: { category: b.category, amountCents: b.amountCents } }); return r;
    });
    return reply.code(201).send(row);
  });
  app.delete('/api/seller/expenses/:id', async (req) => {
    const t = await tenantCtx(req); ok(t); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withTx(t, async c => { const n = (await c.query('DELETE FROM expenses WHERE id=$1', [id])).rowCount; if (!n) throw new HttpError(404, 'not_found');
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'expense.delete', entityType: 'expense', entityId: id }); return { deleted: true }; });
  });

  // ---------------- Price check ----------------
  app.post('/api/seller/profit/price-check', async (req) => {
    const t = await tenantCtx(req);
    const b = z.object({ priceCents: z.number().int().min(0).max(100_000_000), costCents: z.number().int().min(0).max(100_000_000).default(0), discountPercent: z.number().min(0).max(100).optional(),
      deliveryChargedCents: z.number().int().min(0).optional(), deliveryPaidCents: z.number().int().min(0).optional(), channel: z.enum(['online', 'pos']).default('online'), targetMarginPct: z.number().min(0).max(80).optional() }).strict().parse(req.body);
    const feeBps = await withTx(t, async c => Number((await c.query(`SELECT pl.transaction_fee_bps b FROM tenants t JOIN plans pl ON pl.id=t.plan_id WHERE t.id=$1`, [t.tenantId])).rows[0].b));
    return { ...priceCheck({ ...b, feeBps }), platformFeeBps: feeBps };
  });
}
