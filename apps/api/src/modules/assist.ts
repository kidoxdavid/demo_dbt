import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTx } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const COUNTED = `('paid','processing','ready','shipped','completed')`;
interface Answer { summary: string; columns: { key: string; label: string; kind?: 'money' | 'int' | 'text' | 'date' }[]; rows: Record<string, unknown>[]; figures?: Record<string, number>; caveats: string[] }
const money = (c: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(c / 100);
const COST_CAVEAT = 'Cost comes from the cost price saved on each product at the time of sale; items with no cost price count as zero cost, which overstates profit.';
const REFUND_CAVEAT = 'Orders that were fully refunded are excluded; partial refunds are not deducted.';

/**
 * EazyAssist: answers common questions about the business from its own records. It is NOT a language model: every answer is a fixed query,
 * so it can only say what the data says, and it states how each figure is defined. "Gross profit" is sales minus discounts minus the cost of goods;
 * "profit after platform fees" also subtracts the EazyStores transaction fees. Neither subtracts rent, wages, shipping you paid, or income tax.
 */
const QUESTIONS: { id: string; title: string; keywords: string[]; run: (c: pg.PoolClient) => Promise<Answer> }[] = [
  { id: 'top_products', title: 'What are my best sellers (last 30 days)?', keywords: ['best', 'top', 'selling', 'popular', 'bestseller'], run: async c => {
    const rows = (await c.query(`SELECT i.name, sum(i.quantity)::int AS units, sum(i.quantity*i.unit_price_cents)::int AS revenue
      FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status IN ${COUNTED} AND o.created_at > now()-interval '30 days' GROUP BY i.name ORDER BY revenue DESC, units DESC LIMIT 10`)).rows;
    return { summary: rows.length ? `${rows[0].name} leads with ${money(rows[0].revenue)} from ${rows[0].units} sold.` : 'No paid orders in the last 30 days.',
      columns: [{ key: 'name', label: 'Product' }, { key: 'units', label: 'Units', kind: 'int' }, { key: 'revenue', label: 'Sales', kind: 'money' }], rows, caveats: ['Sales are item prices before discounts, tax and delivery.', REFUND_CAVEAT] }; } },
  { id: 'slow_movers', title: 'Which products are not selling?', keywords: ['slow', 'not selling', 'stuck', 'dead', 'unsold', 'stale'], run: async c => {
    const rows = (await c.query(`SELECT p.name, sum(l.on_hand)::int AS in_stock, max(o.created_at) AS last_sale
      FROM products p JOIN product_variants v ON v.product_id=p.id JOIN inventory_levels l ON l.variant_id=v.id
      LEFT JOIN order_items i ON i.variant_id=v.id LEFT JOIN orders o ON o.id=i.order_id AND o.status IN ${COUNTED}
      WHERE p.status='active' AND p.created_at < now()-interval '60 days' GROUP BY p.id, p.name
      HAVING coalesce(max(o.created_at), 'epoch') < now()-interval '60 days' AND sum(l.on_hand) > 0 ORDER BY in_stock DESC LIMIT 20`)).rows;
    return { summary: rows.length ? `${rows.length} product(s) with stock have not sold in 60 days.` : 'Every active product older than 60 days has sold recently, or is out of stock.',
      columns: [{ key: 'name', label: 'Product' }, { key: 'in_stock', label: 'In stock', kind: 'int' }, { key: 'last_sale', label: 'Last sale', kind: 'date' }], rows, caveats: ['Only products listed for more than 60 days are considered, so new products are not judged too early.'] }; } },
  { id: 'most_profitable', title: 'Which products make me the most gross profit (last 90 days)?', keywords: ['profitable', 'profit', 'margin', 'earn', 'make the most'], run: async c => {
    const rows = (await c.query(`SELECT i.name, sum(i.quantity)::int AS units, sum(i.quantity*(i.unit_price_cents-coalesce(i.unit_cost_cents,0)))::int AS gross_profit,
        count(*) FILTER (WHERE i.unit_cost_cents IS NULL OR i.unit_cost_cents=0)::int AS no_cost_lines
      FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status IN ${COUNTED} AND o.created_at > now()-interval '90 days' GROUP BY i.name ORDER BY gross_profit DESC LIMIT 10`)).rows;
    const missing = rows.reduce((n, r) => n + r.no_cost_lines, 0);
    return { summary: rows.length ? `${rows[0].name} earns the most: ${money(rows[0].gross_profit)} before discounts and platform fees.` : 'No paid orders in the last 90 days.',
      columns: [{ key: 'name', label: 'Product' }, { key: 'units', label: 'Units', kind: 'int' }, { key: 'gross_profit', label: 'Gross profit', kind: 'money' }], rows: rows.map(({ no_cost_lines: _n, ...r }) => r),
      caveats: ['Gross profit here = item price minus cost price, before order discounts and platform fees.', COST_CAVEAT, ...(missing ? [`${missing} sold line(s) have no cost price, so their profit is overstated.`] : [])] }; } },
  { id: 'profit_summary', title: 'What did I make this month, after costs and platform fees?', keywords: ['month', 'this month', 'after fees', 'take home', 'net', 'summary', 'how am i doing', 'revenue'], run: async c => {
    const r = (await c.query(`SELECT count(*)::int AS orders, coalesce(sum(subtotal_cents),0)::int AS sales, coalesce(sum(discount_cents),0)::int AS discounts,
        coalesce(sum((SELECT sum(i.quantity*coalesce(i.unit_cost_cents,0)) FROM order_items i WHERE i.order_id=o.id)),0)::int AS cogs
      FROM orders o WHERE o.status IN ${COUNTED} AND o.created_at >= date_trunc('month', now())`)).rows[0];
    const fees = Number((await c.query(`SELECT coalesce(-sum(l.amount_cents) FILTER (WHERE l.account='platform_fee'),0) n FROM ledger_entries l JOIN orders o ON o.id=l.order_id WHERE o.status IN ${COUNTED} AND o.created_at >= date_trunc('month', now())`)).rows[0].n);
    const gross = r.sales - r.discounts - r.cogs; const after = gross - fees;
    return { summary: `${r.orders} paid order(s) this month: ${money(gross)} gross profit, ${money(after)} after platform fees.`,
      columns: [{ key: 'label', label: 'Line' }, { key: 'cents', label: 'Amount', kind: 'money' }],
      rows: [{ label: 'Item sales', cents: r.sales }, { label: 'Discounts given', cents: -r.discounts }, { label: 'Cost of goods', cents: -r.cogs }, { label: 'Gross profit', cents: gross }, { label: 'EazyStores platform fees', cents: -fees }, { label: 'Profit after platform fees', cents: after }],
      figures: { orders: r.orders, salesCents: r.sales, discountsCents: r.discounts, costOfGoodsCents: r.cogs, grossProfitCents: gross, platformFeesCents: fees, profitAfterFeesCents: after },
      caveats: ['This is not net income: rent, wages, shipping you paid, advertising, payment-terminal fees and income tax are not in EazyStores.', 'Sales tax collected is excluded from every figure.', COST_CAVEAT, REFUND_CAVEAT] }; } },
  { id: 'low_stock', title: 'What is running low?', keywords: ['low', 'running out', 'stock', 'inventory', 'out of'], run: async c => {
    const rows = (await c.query(`SELECT p.name, v.title AS variant, (l.on_hand-l.reserved)::int AS available FROM product_variants v JOIN products p ON p.id=v.product_id JOIN inventory_levels l ON l.variant_id=v.id
      WHERE p.status='active' AND v.track_inventory AND l.on_hand-l.reserved <= 5 ORDER BY available, p.name LIMIT 30`)).rows;
    return { summary: rows.length ? `${rows.length} item(s) have 5 or fewer available.` : 'Nothing is at 5 or fewer available.',
      columns: [{ key: 'name', label: 'Product' }, { key: 'variant', label: 'Option' }, { key: 'available', label: 'Available', kind: 'int' }], rows, caveats: ['Available = on hand minus units held by checkouts in progress.'] }; } },
  { id: 'restock', title: 'What should I restock first?', keywords: ['restock', 'reorder', 'order more', 'buy more', 'supplier'], run: async c => {
    const rows = (await c.query(`SELECT p.name, v.title AS variant, (l.on_hand-l.reserved)::int AS available, sold.units::int AS sold_30d,
        round((l.on_hand-l.reserved)::numeric / (sold.units/30.0), 1)::float AS days_left
      FROM product_variants v JOIN products p ON p.id=v.product_id JOIN inventory_levels l ON l.variant_id=v.id
      JOIN (SELECT i.variant_id, sum(i.quantity) units FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status IN ${COUNTED} AND o.created_at > now()-interval '30 days' GROUP BY i.variant_id) sold ON sold.variant_id=v.id
      WHERE p.status='active' AND v.track_inventory ORDER BY days_left ASC NULLS LAST LIMIT 10`)).rows;
    return { summary: rows.length ? `${rows[0].name} (${rows[0].variant}) has about ${rows[0].days_left} day(s) of stock at the last 30 days' pace.` : 'No tracked item sold in the last 30 days, so there is nothing to project.',
      columns: [{ key: 'name', label: 'Product' }, { key: 'variant', label: 'Option' }, { key: 'available', label: 'Available', kind: 'int' }, { key: 'sold_30d', label: 'Sold (30d)', kind: 'int' }, { key: 'days_left', label: 'Days of stock' }], rows,
      caveats: ['Days of stock assumes the next weeks sell like the last 30 days. Seasonality, promotions and supplier lead times are not considered.'] }; } },
  { id: 'lapsed_customers', title: 'Which customers have not come back?', keywords: ['lapsed', 'customers', 'come back', 'returning', 'repeat', 'win back', 'inactive'], run: async c => {
    const rows = (await c.query(`SELECT lower(customer_email) AS email, max(customer_name) AS name, count(*)::int AS orders, sum(total_cents)::int AS spent, max(created_at) AS last_order
      FROM orders WHERE status IN ${COUNTED} AND anonymised_at IS NULL AND customer_email NOT LIKE '%@invalid.example' GROUP BY lower(customer_email)
      HAVING max(created_at) < now()-interval '90 days' ORDER BY spent DESC LIMIT 20`)).rows;
    return { summary: rows.length ? `${rows.length} customer(s) bought before but not in the last 90 days.` : 'No customers have lapsed 90 days yet.',
      columns: [{ key: 'name', label: 'Customer' }, { key: 'email', label: 'Email' }, { key: 'orders', label: 'Orders', kind: 'int' }, { key: 'spent', label: 'Spent', kind: 'money' }, { key: 'last_order', label: 'Last order', kind: 'date' }], rows,
      caveats: ['Only contact customers about their own orders or if they agreed to hear from you; Canadian anti-spam law (CASL) requires consent for marketing emails.', 'Walk-in counter sales have no customer and are not listed.'] }; } },
  { id: 'month_vs_month', title: 'How does this month compare with last month?', keywords: ['compare', 'last month', 'versus', 'vs', 'growth', 'trend', 'previous'], run: async c => {
    const q = async (from: string, to: string) => (await c.query(`SELECT count(*)::int AS orders, coalesce(sum(subtotal_cents-discount_cents),0)::int AS sales FROM orders WHERE status IN ${COUNTED} AND created_at >= ${from} AND created_at < ${to}`)).rows[0];
    const thisM = await q(`date_trunc('month', now())`, `now() + interval '1 second'`); const lastM = await q(`date_trunc('month', now()) - interval '1 month'`, `date_trunc('month', now())`);
    const day = Number((await c.query(`SELECT extract(day from now())::int d`)).rows[0].d);
    const pct = lastM.sales ? Math.round(((thisM.sales - lastM.sales) / lastM.sales) * 100) : null;
    return { summary: `This month so far: ${money(thisM.sales)} from ${thisM.orders} order(s) (day ${day}); all of last month: ${money(lastM.sales)} from ${lastM.orders}.`,
      columns: [{ key: 'label', label: '' }, { key: 'orders', label: 'Orders', kind: 'int' }, { key: 'sales', label: 'Sales after discounts', kind: 'money' }],
      rows: [{ label: 'This month so far', ...thisM }, { label: 'Last month', ...lastM }], figures: { thisMonthSalesCents: thisM.sales, lastMonthSalesCents: lastM.sales, ...(pct == null ? {} : { percentChange: pct }) },
      caveats: ['This month is partial, so it is not directly comparable with a full month; compare again at month end.', REFUND_CAVEAT] }; } },
  { id: 'best_promotion', title: 'Which discount code worked best?', keywords: ['promotion', 'discount', 'code', 'coupon', 'sale', 'promo'], run: async c => {
    const rows = (await c.query(`SELECT d.code, count(o.id)::int AS orders, coalesce(sum(o.subtotal_cents-o.discount_cents),0)::int AS sales, coalesce(sum(o.discount_cents),0)::int AS discount_given
      FROM discounts d LEFT JOIN discount_redemptions r ON r.discount_id=d.id LEFT JOIN orders o ON o.id=r.order_id AND o.status IN ${COUNTED} GROUP BY d.id, d.code ORDER BY sales DESC LIMIT 10`)).rows;
    return { summary: rows.length && rows[0].orders ? `${rows[0].code} brought ${money(rows[0].sales)} in sales across ${rows[0].orders} order(s), at a cost of ${money(rows[0].discount_given)} in discounts.` : 'No discount code has been used on a paid order yet.',
      columns: [{ key: 'code', label: 'Code' }, { key: 'orders', label: 'Orders', kind: 'int' }, { key: 'sales', label: 'Sales', kind: 'money' }, { key: 'discount_given', label: 'Discount given', kind: 'money' }], rows,
      caveats: ['This shows what orders used each code, not whether those customers would have bought anyway.'] }; } },
];

export function registerAssist(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx> }) {
  const { tenantCtx } = deps;
  const ok = (t: TenantCtx) => { if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden'); };
  app.get('/api/seller/assist/questions', async (req) => { ok(await tenantCtx(req)); return QUESTIONS.map(q => ({ id: q.id, title: q.title })); });
  app.post('/api/seller/assist/ask', async (req) => {
    const t = await tenantCtx(req); ok(t);
    const b = z.object({ id: z.string().max(40).optional(), question: z.string().trim().max(300).optional() }).strict().refine(v => v.id || v.question, 'id or question').parse(req.body);
    let q = QUESTIONS.find(x => x.id === b.id);
    if (!q && b.question) {                                                                  // keyword match: the most specific phrase wins; no match means we say so
      const text = b.question.toLowerCase();
      const scored = QUESTIONS.map(x => ({ x, score: x.keywords.reduce((n, k) => n + (text.includes(k) ? k.length : 0), 0) })).filter(s => s.score > 0).sort((a, c) => c.score - a.score);
      q = scored[0]?.x;
    }
    if (!q) return { matched: false, message: 'I can only answer from your sales, stock and customer records. Try one of the suggested questions.', questions: QUESTIONS.map(x => ({ id: x.id, title: x.title })) };
    const ans = await withTx(t, c => q!.run(c));
    return { matched: true, id: q.id, title: q.title, ...ans, generatedAt: new Date().toISOString(), method: 'Fixed queries over your own records. Not AI-generated.' };
  });
}
