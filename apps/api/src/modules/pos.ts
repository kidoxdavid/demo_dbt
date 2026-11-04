import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { priceCart } from '../lib/pricing.js';
import { enqueue, url as mailUrl } from '../lib/mail.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const METHODS = ['cash', 'card_terminal', 'e_transfer', 'other'] as const;
const WALK_IN = 'pos-walk-in@invalid.example';

/**
 * EazyPOS: record in-person sales so online stock never drifts from the shelf.
 *  - Same stock as the online store: a unit that is reserved by an online checkout cannot be sold at the counter (and vice versa).
 *  - Same pricing, tax and discount code logic as online checkout.
 *  - No platform fee on counter sales (the seller already took the money).
 *  - "card_terminal" means the seller took the card on a SEPARATE terminal and is recording it. EazyStores does not integrate card terminals.
 * Available on plans whose features include pos.
 */
export function registerPos(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx> }) {
  const { tenantCtx } = deps;
  const staffOk = (t: TenantCtx) => { if (!['owner', 'manager', 'staff'].includes(t.role)) throw new HttpError(403, 'forbidden'); };
  async function needPos(c: pg.PoolClient, tenantId: string) {
    const ok = (await c.query(`SELECT coalesce((pl.features->>'pos')::boolean,false) ok FROM tenants t JOIN plans pl ON pl.id=t.plan_id WHERE t.id=$1`, [tenantId])).rows[0]?.ok;
    if (!ok) throw new HttpError(402, 'plan_feature_pos');
  }

  // Find what the cashier scanned or typed: exact barcode or SKU first, then names.
  app.get('/api/seller/pos/lookup', async (req) => {
    const t = await tenantCtx(req); staffOk(t);
    const { q } = z.object({ q: z.string().trim().min(1).max(80) }).parse(req.query);
    const like = `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`;
    return withTx(t, async c => {
      await needPos(c, t.tenantId);
      return (await c.query(
        `SELECT v.id AS "variantId", p.name, v.title AS variant, v.sku, v.barcode, v.price_cents AS "priceCents",
                CASE WHEN v.track_inventory THEN l.on_hand - l.reserved END AS available,
                (SELECT '/media/'||m.storage_key||'?w=480' FROM product_media m WHERE m.product_id=p.id ORDER BY m.position LIMIT 1) AS image
         FROM product_variants v JOIN products p ON p.id=v.product_id JOIN inventory_levels l ON l.variant_id=v.id
         WHERE p.status='active' AND (v.barcode=$1 OR lower(v.sku)=lower($1) OR p.name ILIKE $2 ESCAPE '\\' OR v.title ILIKE $2 ESCAPE '\\' OR v.sku ILIKE $2 ESCAPE '\\')
         ORDER BY (v.barcode=$1) DESC, (lower(v.sku)=lower($1)) DESC, p.name, v.title LIMIT 20`, [q, like])).rows;
    });
  });

  /** Load the items and price them exactly as a sale would. Shared by the quote (no locks) and the sale. */
  async function cartFor(c: pg.PoolClient, b: { discountCode?: string; customerEmail?: string }, qty: Map<string, number>, lockDiscount: boolean) {
    const info = (await c.query(`SELECT t.status tenant_status, b.currency, b.region AS biz_region, b.tax_federal, b.tax_provincial, s.id AS store_id, s.name AS store_name
                                   FROM tenants t JOIN businesses b ON b.tenant_id=t.id JOIN stores s ON s.tenant_id=t.id`)).rows[0];
      if (info.tenant_status !== 'active') throw new HttpError(403, 'store_unavailable');
      const rows = (await c.query(`SELECT v.id, v.title, v.price_cents, v.cost_cents, v.weight_grams, v.track_inventory, p.name FROM product_variants v JOIN products p ON p.id=v.product_id
                                   WHERE v.id = ANY($1::uuid[]) AND p.status='active'`, [[...qty.keys()]])).rows;
      if (rows.length !== qty.size) throw new HttpError(422, 'item_unavailable');
      const byId = new Map(rows.map(r => [r.id as string, r]));
      const priced = await priceCart(c, { fulfilment: 'pickup', sellerRegion: info.biz_region, federal: info.tax_federal, provincial: info.tax_provincial, flatDeliveryFeeCents: 0,
        code: b.discountCode, email: b.customerEmail, lockDiscount,
        lines: [...qty].map(([variantId, q]) => ({ variantId, qty: q, priceCents: byId.get(variantId)!.price_cents, weightGrams: byId.get(variantId)!.weight_grams })) });
    return { info, rows, byId, priced };
  }

  const saleIn = z.object({
    items: z.array(z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(1000) }).strict()).min(1).max(100),
    paymentMethod: z.enum(METHODS), tenderedCents: z.number().int().min(0).max(100_000_000).optional(),
    discountCode: z.string().trim().max(40).optional(), customerEmail: z.string().email().max(254).optional(), note: z.string().trim().max(200).optional(),
  }).strict();

  app.post('/api/seller/pos/quote', async (req) => {
    const t = await tenantCtx(req); staffOk(t);
    const b = saleIn.pick({ items: true, discountCode: true, customerEmail: true }).strict().parse(req.body);
    const qty = new Map<string, number>(); for (const i of b.items) qty.set(i.variantId, (qty.get(i.variantId) ?? 0) + i.quantity);
    return withTx(t, async c => { await needPos(c, t.tenantId); const { priced } = await cartFor(c, b, qty, false);
      return { subtotalCents: priced.subtotalCents, discountCents: priced.discountCents, discountCode: priced.discountCode, taxCents: priced.taxCents, taxLines: priced.taxLines, totalCents: priced.totalCents }; });
  });

  app.post('/api/seller/pos/sales', async (req, reply) => {
    const t = await tenantCtx(req); staffOk(t);
    const b = saleIn.parse(req.body);
    const qty = new Map<string, number>(); for (const i of b.items) qty.set(i.variantId, (qty.get(i.variantId) ?? 0) + i.quantity);
    const sale = await withTx(t, async c => {
      await needPos(c, t.tenantId);
      const { info, rows, byId, priced } = await cartFor(c, b, qty, true);
      if (b.paymentMethod === 'cash' && b.tenderedCents != null && b.tenderedCents < priced.totalCents) throw new HttpError(422, `tendered_too_low:${priced.totalCents}`);
      const token = randomBytes(24).toString('base64url');
      const o = (await c.query(
        `INSERT INTO orders(tenant_id,store_id,public_token,status,customer_email,customer_name,fulfilment,currency,subtotal_cents,shipping_cents,total_cents,platform_fee_bps,source,
                            tax_cents,tax_lines,tax_region,discount_cents,discount_code,channel,payment_method)
         VALUES ($1,$2,$3,'completed',$4,$5,'pickup',$6,$7,0,$8,0,'pos',$9,$10,$11,$12,$13,'pos',$14) RETURNING id, number, created_at`,
        [t.tenantId, info.store_id, token, b.customerEmail ?? WALK_IN, b.customerEmail ? 'Customer' : 'Walk-in customer', info.currency, priced.subtotalCents, priced.totalCents,
         priced.taxCents, JSON.stringify(priced.taxLines), priced.taxRegion, priced.discountCents, priced.discountCode, b.paymentMethod])).rows[0];
      for (const [variantId, q] of [...qty].sort((x, y) => x[0].localeCompare(y[0]))) {          // stable lock order
        const r = byId.get(variantId)!;
        await c.query(`INSERT INTO order_items(tenant_id,order_id,variant_id,name,variant_title,quantity,unit_price_cents,unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [t.tenantId, o.id, variantId, r.name, r.title, q, r.price_cents, r.cost_cents]);
        if (r.track_inventory) {
          // Units reserved by an online checkout in progress are NOT available to the counter.
          const u = await c.query('UPDATE inventory_levels SET on_hand = on_hand - $2 WHERE variant_id=$1 AND on_hand - reserved >= $2', [variantId, q]);
          if (!u.rowCount) throw new HttpError(409, 'out_of_stock');
          await c.query(`INSERT INTO inventory_movements(tenant_id,variant_id,delta,reason,order_id,actor_user_id,note) VALUES ($1,$2,$3,'sale',$4,$5,'In-person sale')`, [t.tenantId, variantId, -q, o.id, t.userId]);
        }
      }
      if (priced.discountId) await c.query('INSERT INTO discount_redemptions(tenant_id,discount_id,order_id,email,amount_cents) VALUES ($1,$2,$3,$4,$5)', [t.tenantId, priced.discountId, o.id, b.customerEmail ?? WALK_IN, priced.discountCents]);
      await c.query(`INSERT INTO payments(tenant_id,order_id,provider,provider_ref,amount_cents,currency,status) VALUES ($1,$2,'pos',$3,$4,$5,'succeeded')`, [t.tenantId, o.id, 'pos_' + randomBytes(10).toString('hex'), priced.totalCents, info.currency]);
      const g = (await c.query('SELECT gen_random_uuid() id')).rows[0].id;
      const led = (acct: string, amt: number) => c.query(`INSERT INTO ledger_entries(tenant_id,group_id,order_id,account,amount_cents,currency,memo) VALUES ($1,$2,$3,$4,$5,$6,'in-person sale')`, [t.tenantId, g, o.id, acct, amt, info.currency]);
      if (priced.totalCents > 0) {
        await led('cash_received', priced.totalCents);
        if (priced.taxCents > 0) await led('tax_payable', -priced.taxCents);
        await led('seller_payable', -(priced.totalCents - priced.taxCents));                     // no platform fee on counter sales
      }
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'pos.sale', entityType: 'order', entityId: o.id, next: { totalCents: priced.totalCents, method: b.paymentMethod } });
      if (b.customerEmail) await enqueue(c, { tenantId: t.tenantId, to: b.customerEmail, template: 'order_confirmation', data: {
        number: Number(o.number), currency: info.currency, items: rows.map(r => ({ name: r.name, qty: qty.get(r.id)!, unit: r.price_cents })), subtotal: priced.subtotalCents, shipping: 0, discount: priced.discountCents,
        taxLines: priced.taxLines, total: priced.totalCents, customerName: 'Customer', storeName: info.store_name, url: mailUrl(`/order/${token}`) } });
      return { id: o.id as string, number: Number(o.number), ...priced, paymentMethod: b.paymentMethod,
               changeCents: b.paymentMethod === 'cash' && b.tenderedCents != null ? b.tenderedCents - priced.totalCents : null };
    });
    return reply.code(201).send(sale);
  });

  app.get('/api/seller/pos/sales/:id/receipt', async (req) => {
    const t = await tenantCtx(req); staffOk(t);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withTx(t, async c => {
      await needPos(c, t.tenantId);
      const o = (await c.query(`SELECT o.number, o.created_at, o.currency, o.subtotal_cents, o.discount_cents, o.discount_code, o.tax_cents, o.tax_lines, o.total_cents, o.refunded_cents, o.payment_method, s.name AS store_name
                                FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.id=$1 AND o.channel='pos'`, [id])).rows[0];
      if (!o) throw new HttpError(404, 'not_found');
      const lines = (await c.query('SELECT name, variant_title AS variant, quantity, unit_price_cents AS "unitPriceCents" FROM order_items WHERE order_id=$1 ORDER BY name', [id])).rows;
      return { ...o, lines };
    });
  });

  // End-of-day totals by payment method, in the seller's own time zone.
  app.get('/api/seller/pos/summary', async (req) => {
    const t = await tenantCtx(req); staffOk(t);
    const q = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), tz: z.string().max(40).default('UTC') }).parse(req.query);
    try { new Intl.DateTimeFormat('en', { timeZone: q.tz }); } catch { throw new HttpError(400, 'invalid_timezone'); }
    return withTx(t, async c => {
      await needPos(c, t.tenantId);
      const date = q.date ?? (await c.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') d`, [q.tz])).rows[0].d;
      const rows = (await c.query(
        `SELECT payment_method AS method, count(*)::int AS count, coalesce(sum(total_cents - refunded_cents),0)::int AS "totalCents", coalesce(sum(tax_cents),0)::int AS "taxCents", coalesce(sum(discount_cents),0)::int AS "discountCents"
         FROM orders WHERE channel='pos' AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2 GROUP BY payment_method ORDER BY payment_method`, [q.tz, date])).rows;
      return { date, tz: q.tz, sales: rows.reduce((n, r) => n + r.count, 0), totalCents: rows.reduce((n, r) => n + r.totalCents, 0), taxCents: rows.reduce((n, r) => n + r.taxCents, 0), byMethod: rows,
               note: 'Totals are net of refunds. Card amounts are what you recorded from your own terminal; EazyStores does not see terminal payments.' };
    });
  });
}
