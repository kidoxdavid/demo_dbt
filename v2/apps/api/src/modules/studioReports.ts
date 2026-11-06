import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../db.js';
import { balancesFor } from './consoles.js';
import { sellerCtx } from './studio.js';

const PAID = `so.status NOT IN ('awaiting_payment','cancelled')`;
/** A maker's Insights and Payouts pages: real numbers from their own orders, page views and ledger, nothing estimated. */
export function registerStudioReports(app: FastifyInstance) {
  app.get('/api/studio/insights', async req => {
    const s = await sellerCtx(req, 'seller.orders.read'); const { days } = z.object({ days: z.coerce.number().refine(d => [7, 30, 90].includes(d)).default(30) }).parse(req.query);
    const cur = (await q(`SELECT coalesce(sum(items_cents + shipping_cents),0)::int AS sales, count(*)::int AS orders FROM seller_orders so WHERE seller_id=$1 AND ${PAID} AND created_at >= now() - ($2::int * interval '1 day')`, [s.sellerId, days])).rows[0];
    const prev = (await q(`SELECT coalesce(sum(items_cents + shipping_cents),0)::int AS sales, count(*)::int AS orders FROM seller_orders so WHERE seller_id=$1 AND ${PAID} AND created_at >= now() - ($2::int * 2 * interval '1 day') AND created_at < now() - ($2::int * interval '1 day')`, [s.sellerId, days])).rows[0];
    const visits = (await q(`SELECT coalesce(sum(CASE WHEN day >= current_date - ($2::int - 1) THEN views END),0)::int AS cur, coalesce(sum(CASE WHEN day < current_date - ($2::int - 1) THEN views END),0)::int AS prev FROM shop_views WHERE shop_id=$1 AND day >= current_date - ($2::int * 2 - 1)`, [s.shopId, days])).rows[0];
    const daily = (await q(`SELECT d::date AS day, coalesce((SELECT sum(items_cents + shipping_cents) FROM seller_orders so WHERE so.seller_id=$1 AND ${PAID} AND so.created_at::date = d::date),0)::int AS cents, coalesce((SELECT views FROM shop_views v WHERE v.shop_id=$3 AND v.day = d::date),0)::int AS views FROM generate_series(current_date - ($2::int - 1), current_date, '1 day') d ORDER BY d`, [s.sellerId, days, s.shopId])).rows;
    const top = (await q(`SELECT l.title, sum(l.quantity)::int AS units, sum(l.unit_price_cents * l.quantity)::int AS cents FROM order_lines l JOIN seller_orders so ON so.id=l.seller_order_id WHERE so.seller_id=$1 AND ${PAID} AND so.created_at >= now() - ($2::int * interval '1 day') GROUP BY l.title ORDER BY sum(l.unit_price_cents * l.quantity) DESC LIMIT 5`, [s.sellerId, days])).rows;
    const change = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
    return { days, salesCents: cur.sales, orders: cur.orders, visits: visits.cur, avgOrderCents: cur.orders ? Math.round(cur.sales / cur.orders) : 0, conversionPct: visits.cur > 0 ? Math.round((cur.orders / visits.cur) * 1000) / 10 : null,
      change: { sales: change(cur.sales, prev.sales), orders: change(cur.orders, prev.orders), visits: change(visits.cur, visits.prev) }, daily, top };
  });
  app.get('/api/studio/payouts', async req => {
    const s = await sellerCtx(req, 'seller.payouts.read'); const b = await balancesFor(s.sellerId); const r = b.rows[0] ?? { owedCents: 0, availableCents: 0, pendingCents: 0, paidOutCents: 0, salesCents: 0, commissionCents: 0, refundedCents: 0 };
    const history = (await q(`SELECT id, amount_cents AS "amountCents", reference, note, created_at AS "createdAt" FROM payouts WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 50`, [s.sellerId])).rows;
    return { holdDays: b.holdDays, owedCents: r.owedCents, availableCents: r.availableCents, pendingCents: r.pendingCents, paidOutCents: r.paidOutCents, salesCents: r.salesCents, commissionCents: r.commissionCents, refundedCents: r.refundedCents, history };
  });
}
