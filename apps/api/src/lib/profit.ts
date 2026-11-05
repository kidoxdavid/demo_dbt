import type pg from 'pg';

/**
 * "What you keep." One definition used by the dashboard, the profit page, order pages and the price check, so the numbers always agree.
 *
 *   keep = (item sales - discount) + delivery charged to the customer
 *          - cost of goods - EazyStores fee - card processing fee (ESTIMATE) - delivery the seller paid - refunds (excluding tax)
 *
 * Sales tax is never part of it (it is collected for the tax authority). Items with no cost price count as zero cost and are flagged.
 * The card-processing fee is an ESTIMATE (rate below) until a real payment provider reports actual fees; counter sales have none because the
 * seller's own terminal fees are unknown to us. Delivery cost is only known if the seller entered it.
 */
export const PROCESSING = { bps: Number(process.env.PROCESSING_FEE_BPS ?? 290), fixedCents: Number(process.env.PROCESSING_FEE_FIXED_CENTS ?? 30) };
export const processingFee = (totalCents: number) => (totalCents > 0 ? Math.round((totalCents * PROCESSING.bps) / 10000) + PROCESSING.fixedCents : 0);
export const COUNTED = `('paid','processing','ready','shipped','completed')`;

export interface OrderProfit {
  id: string; number: number; createdAt: string; channel: string; fulfilment: string; source: string;
  salesCents: number; discountCents: number; deliveryChargedCents: number; cogsCents: number; platformFeeCents: number; processingFeeCents: number;
  deliveryPaidCents: number; refundsCents: number; keepCents: number; missingCostLines: number; deliveryCostMissing: boolean;
}

export async function orderProfits(c: pg.PoolClient, from: string, to: string, onlyOrder?: string): Promise<OrderProfit[]> {
  const rows = (await c.query(
    `SELECT o.id, o.number, o.created_at, o.channel, o.fulfilment, coalesce(o.source,'direct') AS source, o.subtotal_cents, o.discount_cents, o.shipping_cents, o.total_cents, o.refunded_cents, o.shipping_cost_cents,
            (SELECT coalesce(sum(i.quantity*coalesce(i.unit_cost_cents,0)),0) FROM order_items i WHERE i.order_id=o.id)::int AS cogs,
            (SELECT count(*) FROM order_items i WHERE i.order_id=o.id AND i.unit_cost_cents IS NULL)::int AS missing,
            (SELECT coalesce(-sum(l.amount_cents) FILTER (WHERE l.account='platform_fee'),0) FROM ledger_entries l WHERE l.order_id=o.id)::int AS fee,
            (SELECT coalesce(sum(l.amount_cents),0) FROM ledger_entries l WHERE l.order_id=o.id AND l.account='tax_payable' AND l.memo='refund')::int AS tax_refunded
     FROM orders o WHERE o.status IN ${COUNTED} AND o.created_at BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR o.id=$3) ORDER BY o.created_at DESC`, [from, to, onlyOrder ?? null])).rows;
  return rows.map(r => {
    const salesCents = r.subtotal_cents - r.discount_cents; const proc = r.channel === 'pos' ? 0 : processingFee(r.total_cents);
    const refunds = Math.max(0, r.refunded_cents - r.tax_refunded); const deliveryPaid = r.shipping_cost_cents ?? 0;
    return { id: r.id, number: Number(r.number), createdAt: r.created_at, channel: r.channel, fulfilment: r.fulfilment, source: r.source, salesCents, discountCents: r.discount_cents,
      deliveryChargedCents: r.shipping_cents, cogsCents: r.cogs, platformFeeCents: r.fee, processingFeeCents: proc, deliveryPaidCents: deliveryPaid, refundsCents: refunds,
      keepCents: salesCents + r.shipping_cents - r.cogs - r.fee - proc - deliveryPaid - refunds, missingCostLines: r.missing, deliveryCostMissing: r.fulfilment === 'delivery' && r.shipping_cost_cents == null };
  });
}

/** One unit's economics at a given price: used for the live "you keep" hint and the loses-money warning. */
export function priceCheck(a: { priceCents: number; costCents: number; feeBps: number; discountPercent?: number; deliveryChargedCents?: number; deliveryPaidCents?: number; channel?: 'online' | 'pos'; targetMarginPct?: number }) {
  const disc = Math.round((a.priceCents * (a.discountPercent ?? 0)) / 100); const sale = a.priceCents - disc;
  const fee = Math.floor((sale * a.feeBps) / 10000); const proc = a.channel === 'pos' ? 0 : processingFee(sale + (a.deliveryChargedCents ?? 0));
  const keep = sale + (a.deliveryChargedCents ?? 0) - a.costCents - fee - proc - (a.deliveryPaidCents ?? 0);
  const marginPct = sale > 0 ? Math.round((keep / sale) * 1000) / 10 : null;
  const target = (a.targetMarginPct ?? 20) / 100; const feeRate = a.feeBps / 10000; const procRate = a.channel === 'pos' ? 0 : PROCESSING.bps / 10000;
  const fixed = a.channel === 'pos' ? 0 : PROCESSING.fixedCents; const net = a.costCents + fixed + (a.deliveryPaidCents ?? 0) - (a.deliveryChargedCents ?? 0);
  const denom = (1 - (a.discountPercent ?? 0) / 100) * (1 - feeRate - procRate) - target;
  const suggested = denom > 0 ? Math.ceil(net / denom) : null;
  const verdict = keep < 0 ? 'loses_money' : marginPct != null && marginPct < 10 ? 'thin' : 'healthy';
  return { priceCents: a.priceCents, discountCents: disc, platformFeeCents: fee, processingFeeCents: proc, costCents: a.costCents, keepCents: keep, marginPct, verdict, suggestedPriceCents: suggested, targetMarginPct: a.targetMarginPct ?? 20,
           processingIsEstimate: a.channel !== 'pos' };
}
