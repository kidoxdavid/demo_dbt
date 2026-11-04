import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withTx, audit, type Ctx } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { getProvider } from '../lib/payments.js';
import { reservationMinutes, uploadDir, maxImageBytes, uploadRateLimitMax } from '../config.js';
import { customFieldsIn, withKeys, validateCustom, isUuid, type Field } from '../lib/custom.js';
import { localStorageAdapter, sniffImage, isValidKey } from '../lib/storage.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) });
const can = (t: TenantCtx, roles: string[]) => { if (!roles.includes(t.role)) throw new HttpError(403, 'forbidden'); };

const variantIn = z.object({
  title: z.string().trim().min(1).max(100).default('Default'), sku: z.string().trim().max(64).optional(),
  options: z.record(z.string(), z.string().max(100)).default({}),
  priceCents: z.number().int().min(0).max(100_000_000), costCents: z.number().int().min(0).optional(),
  stock: z.number().int().min(0).max(1_000_000).default(0), trackInventory: z.boolean().default(true),
  lowStockThreshold: z.number().int().min(0).default(0),
}).strict();
const productIn = z.object({
  name: z.string().trim().min(1).max(200), description: z.string().max(10000).optional(), brand: z.string().max(100).optional(),
  attributes: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
  madeToOrder: z.boolean().default(false), status: z.enum(['draft', 'active']).default('draft'), customFields: customFieldsIn.default([]),
  variants: z.array(variantIn).min(1).max(100),
}).strict();

/** Release stock reserved by an unpaid order. Caller holds a tx and has locked the order row. */
async function releaseReservation(c: pg.PoolClient, orderId: string) {
  await c.query(
    `UPDATE inventory_levels l SET reserved = l.reserved - i.quantity
     FROM order_items i JOIN product_variants v ON v.id=i.variant_id
     WHERE i.order_id=$1 AND l.variant_id=i.variant_id AND v.track_inventory`, [orderId]);
}

/** Try to reserve stock for items; returns false if any line cannot be satisfied (caller rolls back/handles). */
async function reserve(c: pg.PoolClient, lines: { variantId: string; qty: number }[]) {
  for (const l of [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) { // stable lock order, no deadlocks
    const v = (await c.query('SELECT track_inventory FROM product_variants WHERE id=$1', [l.variantId])).rows[0];
    if (!v?.track_inventory) continue;
    const r = await c.query(
      `UPDATE inventory_levels SET reserved = reserved + $2 WHERE variant_id=$1 AND on_hand - reserved >= $2`, [l.variantId, l.qty]);
    if (!r.rowCount) return false;
  }
  return true;
}

/** Idempotent payment settlement. Safe to call repeatedly (webhook retries). */
export async function settlePayment(providerRef: string, outcome: 'succeeded' | 'failed') {
  return withTx({ platform: true }, async c => {
    const p = (await c.query(`SELECT * FROM payments WHERE provider_ref=$1 FOR UPDATE`, [providerRef])).rows[0];
    if (!p) throw new HttpError(404, 'payment_not_found');
    if (p.status !== 'pending') return { status: p.status as string, replay: true };
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [p.order_id])).rows[0];
    const items = (await c.query(
      `SELECT i.*, v.track_inventory FROM order_items i LEFT JOIN product_variants v ON v.id=i.variant_id WHERE i.order_id=$1`, [o.id])).rows;
    if (outcome === 'failed') {
      await c.query(`UPDATE payments SET status='failed' WHERE id=$1`, [p.id]);
      if (o.status === 'awaiting_payment') { await releaseReservation(c, o.id); await c.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE id=$1`, [o.id]); }
      return { status: 'failed', replay: false };
    }
    await c.query(`UPDATE payments SET status='succeeded' WHERE id=$1`, [p.id]);
    if (o.status === 'cancelled') {
      // Paid after reservation expired: re-reserve if stock still exists, otherwise flag for refund.
      const ok = await reserve(c, items.filter(i => i.variant_id).map(i => ({ variantId: i.variant_id, qty: i.quantity })));
      if (!ok) { await c.query('UPDATE payments SET needs_refund=true WHERE id=$1', [p.id]); return { status: 'succeeded', replay: false, needsRefund: true }; }
    }
    for (const i of items) {
      if (!i.variant_id || !i.track_inventory) continue;
      await c.query('UPDATE inventory_levels SET on_hand = on_hand - $2, reserved = reserved - $2 WHERE variant_id=$1', [i.variant_id, i.quantity]);
      await c.query(`INSERT INTO inventory_movements(tenant_id,variant_id,delta,reason,order_id) VALUES ($1,$2,$3,'sale',$4)`, [o.tenant_id, i.variant_id, -i.quantity, o.id]);
    }
    await c.query(`UPDATE orders SET status='paid', reservation_expires_at=NULL, updated_at=now() WHERE id=$1`, [o.id]);
    const fee = Math.floor((o.subtotal_cents * o.platform_fee_bps) / 10000);
    const g = (await c.query('SELECT gen_random_uuid() id')).rows[0].id;
    const ins = (acct: string, amt: number) => c.query(
      `INSERT INTO ledger_entries(tenant_id,group_id,order_id,account,amount_cents,currency,memo) VALUES ($1,$2,$3,$4,$5,$6,'order paid')`,
      [o.tenant_id, g, o.id, acct, amt, o.currency]);
    await ins('cash_received', o.total_cents); await ins('platform_fee', -fee); await ins('seller_payable', -(o.total_cents - fee));
    await audit(c, { tenantId: o.tenant_id, action: 'order.paid', entityType: 'order', entityId: o.id });
    return { status: 'succeeded', replay: false };
  });
}

/** Cancel unpaid orders whose reservation lapsed and return their stock. Run on an interval. */
export async function releaseExpiredReservations() {
  return withTx({ platform: true }, async c => {
    const rows = (await c.query(
      `SELECT id FROM orders WHERE status='awaiting_payment' AND reservation_expires_at < now() FOR UPDATE SKIP LOCKED`)).rows;
    for (const r of rows) {
      await releaseReservation(c, r.id);
      await c.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE id=$1`, [r.id]);
    }
    return rows.length;
  });
}

/** Delete customer images that were uploaded but never attached to an order (abandoned carts). */
export async function cleanupOrphanUploads(olderThanHours = 24) {
  const rows = await withTx({ platform: true }, async c => (await c.query(
    `DELETE FROM custom_uploads WHERE order_id IS NULL AND created_at < now() - ($1 || ' hours')::interval RETURNING storage_key`, [String(olderThanHours)])).rows);
  const st = localStorageAdapter(uploadDir); for (const r of rows) await st.remove(r.storage_key);
  return rows.length;
}

const TRANSITIONS: Record<string, string[]> = {
  paid: ['processing'], processing: ['ready', 'shipped'], ready: ['completed'], shipped: ['completed'],
};

export function registerCommerce(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx> }) {
  const { tenantCtx } = deps;
  const storage = localStorageAdapter(uploadDir);

  // ---------------- Images ----------------
  // Raw binary upload (no multipart dependency). Type is decided by magic bytes, size is capped by bodyLimit + check.
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: maxImageBytes }, (_r, body, done) => done(null, body));

  app.post('/api/seller/products/:id/images', async (req, reply) => {
    const t = await tenantCtx(req); can(t, ['owner', 'manager']);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'empty_upload');
    if (body.length > maxImageBytes) throw new HttpError(413, 'image_too_large');
    const kind = sniffImage(body);
    if (!kind) throw new HttpError(415, 'unsupported_image_type');
    const key = await storage.put(kind.ext, body);
    try {
      const row = await withTx(t, async c => {
        const p = (await c.query('SELECT 1 FROM products WHERE id=$1', [id])).rowCount;
        if (!p) throw new HttpError(404, 'not_found');
        const n = (await c.query('SELECT count(*)::int n, coalesce(max(position),-1)+1 pos FROM product_media WHERE product_id=$1', [id])).rows[0];
        if (n.n >= 8) throw new HttpError(409, 'too_many_images');
        return (await c.query(
          `INSERT INTO product_media(tenant_id,product_id,storage_key,content_type,bytes,position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,position`,
          [t.tenantId, id, key, kind.type, body.length, n.pos])).rows[0];
      });
      return reply.code(201).send({ id: row.id, url: `/media/${key}`, position: row.position });
    } catch (e) { await storage.remove(key); throw e; } // never orphan a file when the DB write is rejected
  });

  app.delete('/api/seller/images/:id', async (req) => {
    const t = await tenantCtx(req); can(t, ['owner', 'manager']);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const key = await withTx(t, async c => (await c.query('DELETE FROM product_media WHERE id=$1 RETURNING storage_key', [id])).rows[0]?.storage_key);
    if (!key) throw new HttpError(404, 'not_found');
    await storage.remove(key);
    return { ok: true };
  });

  // Public image delivery: unguessable key; only images of ACTIVE products are served.
  app.get('/media/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!isValidKey(key)) throw new HttpError(404, 'not_found');
    const type = await withTx({}, async c => (await c.query('SELECT media_content_type($1) t', [key])).rows[0].t as string | null);
    if (!type) throw new HttpError(404, 'not_found');
    const data = await storage.get(key);
    if (!data) throw new HttpError(404, 'not_found');
    return reply.header('content-type', type).header('x-content-type-options', 'nosniff').header('cross-origin-resource-policy', 'cross-origin')
      .header('cache-control', 'public, max-age=3600').send(data);
  });

  // ---------------- Seller: catalogue ----------------
  app.post('/api/seller/products', async (req, reply) => {
    const t = await tenantCtx(req); can(t, ['owner', 'manager']);
    const b = productIn.parse(req.body);
    const out = await withTx(t, async c => {
      if (b.status === 'active') await assertProductLimit(c, t.tenantId, 1);
      const p = (await c.query(
        `INSERT INTO products(tenant_id,name,description,brand,attributes,made_to_order,status,custom_fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [t.tenantId, b.name, b.description ?? null, b.brand ?? null, JSON.stringify(b.attributes), b.madeToOrder, b.status, JSON.stringify(withKeys(b.customFields))])).rows[0];
      for (const v of b.variants) {
        const row = await c.query(
          `INSERT INTO product_variants(tenant_id,product_id,title,sku,options,price_cents,cost_cents,track_inventory,low_stock_threshold)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [t.tenantId, p.id, v.title, v.sku ?? null, JSON.stringify(v.options), v.priceCents, v.costCents ?? null,
           b.madeToOrder ? false : v.trackInventory, v.lowStockThreshold]).catch(e => {
            if (e.code === '23505') throw new HttpError(409, 'duplicate_sku'); throw e; });
        await c.query('INSERT INTO inventory_levels(variant_id,tenant_id,on_hand) VALUES ($1,$2,$3)', [row.rows[0].id, t.tenantId, v.stock]);
        if (v.stock) await c.query(`INSERT INTO inventory_movements(tenant_id,variant_id,delta,reason,actor_user_id) VALUES ($1,$2,$3,'initial',$4)`, [t.tenantId, row.rows[0].id, v.stock, t.userId]);
      }
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'product.create', entityType: 'product', entityId: p.id });
      return p.id as string;
    });
    return reply.code(201).send({ id: out });
  });

  async function assertProductLimit(c: pg.PoolClient, tenantId: string, adding: number) {
    const lim = (await c.query(`SELECT (p.limits->>'active_products')::int AS lim FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE t.id=$1`, [tenantId])).rows[0]?.lim;
    if (lim == null) return;
    const n = (await c.query(`SELECT count(*)::int n FROM products WHERE status='active'`)).rows[0].n;
    if (n + adding > lim) throw new HttpError(402, 'plan_limit_active_products');
  }

  app.get('/api/seller/products', async (req) => {
    const t = await tenantCtx(req);
    const { limit, offset } = page.parse(req.query);
    return withTx(t, async c => (await c.query(
      `SELECT p.id,p.name,p.status,p.brand,p.attributes,p.custom_fields AS "customFields",
        (SELECT json_agg(json_build_object('id',v.id,'title',v.title,'sku',v.sku,'priceCents',v.price_cents,'costCents',v.cost_cents,
           'onHand',l.on_hand,'reserved',l.reserved,'trackInventory',v.track_inventory,'lowStock',(v.track_inventory AND l.on_hand-l.reserved <= v.low_stock_threshold)))
         FROM product_variants v JOIN inventory_levels l ON l.variant_id=v.id WHERE v.product_id=p.id) AS variants,
        (SELECT coalesce(json_agg(json_build_object('id',m.id,'url','/media/'||m.storage_key) ORDER BY m.position),'[]'::json) FROM product_media m WHERE m.product_id=p.id) AS images
       FROM products p ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset])).rows);
  });

  app.patch('/api/seller/products/:id', async (req) => {
    const t = await tenantCtx(req); can(t, ['owner', 'manager']);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(10000), status: z.enum(['draft', 'active', 'archived']), customFields: customFieldsIn }).partial().strict().parse(req.body);
    return withTx(t, async c => {
      const prev = (await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!prev) throw new HttpError(404, 'not_found');
      if (b.status === 'active' && prev.status !== 'active') await assertProductLimit(c, t.tenantId, 1);
      const row = (await c.query(
        `UPDATE products SET name=coalesce($2,name), description=coalesce($3,description), status=coalesce($4,status), custom_fields=coalesce($5::jsonb,custom_fields), updated_at=now() WHERE id=$1 RETURNING *`,
        [id, b.name ?? null, b.description ?? null, b.status ?? null, b.customFields ? JSON.stringify(withKeys(b.customFields)) : null])).rows[0];
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'product.update', entityType: 'product', entityId: id, prev, next: row });
      return row;
    });
  });

  app.post('/api/seller/variants/:id/stock', async (req) => {
    const t = await tenantCtx(req); can(t, ['owner', 'manager', 'staff']);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ delta: z.number().int().min(-1_000_000).max(1_000_000).refine(n => n !== 0), note: z.string().max(300).optional() }).strict().parse(req.body);
    return withTx(t, async c => {
      const r = await c.query('UPDATE inventory_levels SET on_hand = on_hand + $2 WHERE variant_id=$1 RETURNING on_hand, reserved', [id, b.delta])
        .catch(e => { if (e.code === '23514') throw new HttpError(409, 'stock_below_reserved_or_negative'); throw e; });
      if (!r.rowCount) throw new HttpError(404, 'not_found');
      await c.query(`INSERT INTO inventory_movements(tenant_id,variant_id,delta,reason,actor_user_id,note) VALUES ($1,$2,$3,'adjustment',$4,$5)`, [t.tenantId, id, b.delta, t.userId, b.note ?? null]);
      return r.rows[0];
    });
  });

  // ---------------- Seller: orders & dashboard ----------------
  app.get('/api/seller/orders', async (req) => {
    const t = await tenantCtx(req);
    const q = page.extend({ status: z.string().optional() }).parse(req.query);
    return withTx(t, async c => (await c.query(
      `SELECT id,number,status,customer_name,customer_email,fulfilment,total_cents,currency,created_at FROM orders
       WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [q.status ?? null, q.limit, q.offset])).rows);
  });

  app.get('/api/seller/orders/:id', async (req) => {
    const t = await tenantCtx(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withTx(t, async c => {
      const o = (await c.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
      if (!o) throw new HttpError(404, 'not_found'); // RLS makes other tenants' orders indistinguishable from missing ones
      o.items = (await c.query('SELECT name,variant_title,quantity,unit_price_cents,custom_values FROM order_items WHERE order_id=$1', [id])).rows;
      o.refunds = (await c.query('SELECT id,amount_cents,reason,restocked,created_at FROM refunds WHERE order_id=$1 ORDER BY created_at', [id])).rows;
      return o;
    });
  });

  app.post('/api/seller/orders/:id/status', async (req) => {
    const t = await tenantCtx(req); can(t, ['owner', 'manager', 'staff']);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.string() }).strict().parse(req.body);
    return withTx(t, async c => {
      const o = (await c.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!o) throw new HttpError(404, 'not_found');
      if (!(TRANSITIONS[o.status] ?? []).includes(status)) throw new HttpError(409, `invalid_transition:${o.status}->${status}`);
      await c.query('UPDATE orders SET status=$2, updated_at=now() WHERE id=$1', [id, status]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'order.status', entityType: 'order', entityId: id, prev: { status: o.status }, next: { status } });
      return { status };
    });
  });

  /** Revenue is not profit: every figure is labelled; unknowns are reported, not guessed. */
  app.get('/api/seller/dashboard', async (req) => {
    const t = await tenantCtx(req);
    const q = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).parse(req.query);
    return withTx(t, async c => {
      const args = [q.from ?? '1970-01-01T00:00:00Z', q.to ?? '2999-01-01T00:00:00Z'];
      const o = (await c.query(
        `SELECT count(*)::int orders, coalesce(sum(subtotal_cents),0)::bigint gross_sales, coalesce(sum(shipping_cents),0)::bigint shipping_collected
         FROM orders WHERE status IN ('paid','processing','ready','shipped','completed') AND created_at BETWEEN $1 AND $2`, args)).rows[0];
      const k = (await c.query(
        `SELECT coalesce(sum(i.quantity*i.unit_cost_cents) FILTER (WHERE i.unit_cost_cents IS NOT NULL),0)::bigint cogs_known,
                coalesce(sum(i.quantity*i.unit_price_cents) FILTER (WHERE i.unit_cost_cents IS NOT NULL),0)::bigint sales_with_cost,
                count(*) FILTER (WHERE i.unit_cost_cents IS NULL)::int lines_missing_cost,
                count(*) FILTER (WHERE i.unit_cost_cents IS NOT NULL)::int lines_with_cost
         FROM order_items i JOIN orders o ON o.id=i.order_id
         WHERE o.status IN ('paid','processing','ready','shipped','completed') AND o.created_at BETWEEN $1 AND $2`, args)).rows[0];
      const f = (await c.query(
        `SELECT coalesce(-sum(amount_cents) FILTER (WHERE account='platform_fee'),0)::bigint platform_fees,
                coalesce(-sum(amount_cents) FILTER (WHERE account='seller_payable'),0)::bigint seller_earnings_before_processor_fees
         FROM ledger_entries WHERE at BETWEEN $1 AND $2`, args)).rows[0];
      // If nothing sold has a known cost, COGS and profit are UNKNOWN (null), never reported as zero.
      const costKnown = k.lines_with_cost > 0 || k.lines_missing_cost === 0;
      // Partial refunds on counted orders reduce profit (the sale shrinks, the cost does not). Fully refunded orders drop out of
      // sales entirely (status 'refunded'). Refunds include any delivery fee refunded, so this is a close estimate, not an accounting figure.
      const bySource = (await c.query(
        `SELECT coalesce(source,'direct') AS source, count(*)::int AS orders, coalesce(sum(subtotal_cents),0)::bigint AS sales
         FROM orders WHERE status IN ('paid','processing','ready','shipped','completed') AND created_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY sales DESC, 1`, args)).rows
        .map(r => ({ source: r.source as string, orders: r.orders as number, grossSalesCents: Number(r.sales) }));
      const refundsOnCounted = Number((await c.query(
        `SELECT coalesce(sum(r.amount_cents),0)::bigint n FROM refunds r JOIN orders o ON o.id=r.order_id
         WHERE o.status IN ('paid','processing','ready','shipped','completed') AND o.created_at BETWEEN $1 AND $2`, args)).rows[0].n);
      const grossProfit = costKnown ? Number(k.sales_with_cost) - Number(k.cogs_known) - refundsOnCounted : null;
      return {
        currency: 'CAD', orders: o.orders, bySource,
        grossSalesCents: Number(o.gross_sales), shippingCollectedCents: Number(o.shipping_collected),
        discountsCents: 0, refundsCents: refundsOnCounted,
        cogsCents: costKnown ? Number(k.cogs_known) : null, grossProfitCents: grossProfit,
        grossProfitIsPartial: k.lines_missing_cost > 0, lineItemsMissingCost: k.lines_missing_cost,
        platformFeesCents: Number(f.platform_fees), sellerEarningsBeforeProcessorFeesCents: Number(f.seller_earnings_before_processor_fees),
        notes: ['Gross sales exclude shipping and are not profit.', 'Fully refunded orders are excluded from sales; partial refunds reduce profit.', 'Payment-processor fees and taxes are not included: not yet integrated.',
                'Estimated net profit is unavailable until processor fees and operating expenses are recorded.'],
      };
    });
  });

  // ---------------- Public storefront + checkout ----------------
  /** Resolve a published store; tenant context for the follow-up queries is derived from the store row, never from the client. */
  async function publicStore(slug: string) {
    const s = await withTx({}, async c => (await c.query(
      `SELECT s.id, s.tenant_id, s.name, s.delivery_fee_cents FROM stores s WHERE s.slug=$1`, [slug])).rows[0]);
    if (!s) throw new HttpError(404, 'not_found'); // RLS exposes published stores only
    return s as { id: string; tenant_id: string; name: string; delivery_fee_cents: number };
  }

  app.get('/api/public/stores/:slug/products', async (req) => {
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    const { limit, offset } = page.parse(req.query);
    const s = await publicStore(slug);
    return withTx({ tenantId: s.tenant_id }, async c => (await c.query(
      `SELECT p.id,p.name,p.description,p.brand,p.attributes,p.made_to_order AS "madeToOrder",p.custom_fields AS "customFields",
        (SELECT json_agg(json_build_object('id',v.id,'title',v.title,'options',v.options,'priceCents',v.price_cents,
           'available',(NOT v.track_inventory) OR (l.on_hand-l.reserved>0)))
         FROM product_variants v JOIN inventory_levels l ON l.variant_id=v.id WHERE v.product_id=p.id) AS variants,
        (SELECT coalesce(json_agg('/media/'||m.storage_key ORDER BY m.position),'[]'::json) FROM product_media m WHERE m.product_id=p.id) AS images
       FROM products p WHERE p.status='active' ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset])).rows);
  });

  const checkoutIn = z.object({
    items: z.array(z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(100), customizations: z.record(z.string().max(40), z.string().max(1000)).optional() }).strict()).min(1).max(50),
    source: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
    email: z.string().email().max(254), name: z.string().trim().min(1).max(120),
    fulfilment: z.enum(['pickup', 'delivery']),
    address: z.object({ line1: z.string().min(1).max(200), city: z.string().min(1).max(100), region: z.string().max(100), postalCode: z.string().min(3).max(12), country: z.string().length(2) }).optional(),
  }).strict();

  app.post('/api/public/stores/:slug/checkout', async (req, reply) => {
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    const b = checkoutIn.parse(req.body);
    const provider = getProvider();
    if (!provider) throw new HttpError(503, 'payments_not_configured');
    if (b.fulfilment === 'delivery' && !b.address) throw new HttpError(422, 'address_required');
    const s = await publicStore(slug);
    // Lines stay separate when their customisation differs; stock is reserved per variant in total.
    const lineMap = new Map<string, { variantId: string; qty: number; custom: Record<string, string> }>();
    for (const i of b.items) { const custom = i.customizations ?? {}; const k = i.variantId + JSON.stringify(Object.entries(custom).sort());
      const cur = lineMap.get(k); if (cur) cur.qty += i.quantity; else lineMap.set(k, { variantId: i.variantId, qty: i.quantity, custom }); }
    const lines = [...lineMap.values()];
    const qtyByVariant = new Map<string, number>(); for (const l of lines) qtyByVariant.set(l.variantId, (qtyByVariant.get(l.variantId) ?? 0) + l.qty);
    const reserveLines = [...qtyByVariant].map(([variantId, qty]) => ({ variantId, qty }));

    const result = await withTx({ tenantId: s.tenant_id }, async c => {
      const info = (await c.query(
        `SELECT t.status tenant_status, b.fulfilment, b.currency, pl.transaction_fee_bps
         FROM tenants t JOIN businesses b ON b.tenant_id=t.id JOIN plans pl ON pl.id=t.plan_id`)).rows[0];
      if (info.tenant_status !== 'active') throw new HttpError(403, 'store_unavailable');
      if (!info.fulfilment?.[b.fulfilment === 'pickup' ? 'pickup' : 'delivery']) throw new HttpError(422, 'fulfilment_not_offered');
      // Price comes from the database, never the client.
      const rows = (await c.query(
        `SELECT v.id, v.title, v.price_cents, v.cost_cents, p.name, p.custom_fields FROM product_variants v JOIN products p ON p.id=v.product_id
         WHERE v.id = ANY($1::uuid[]) AND p.status='active'`, [reserveLines.map(l => l.variantId)])).rows;
      if (rows.length !== reserveLines.length) throw new HttpError(422, 'item_unavailable');
      // Customer answers are validated against the product's CURRENT fields; uploaded images must be unattached and belong to this store.
      const candidateUploads = [...new Set(lines.flatMap(l => Object.values(l.custom)).filter(isUuid))];
      const availableUploads = new Set<string>(candidateUploads.length ? (await c.query('SELECT id FROM custom_uploads WHERE id = ANY($1::uuid[]) AND order_id IS NULL', [candidateUploads])).rows.map(r => r.id as string) : []);
      const byVariant = new Map(rows.map(r => [r.id, r]));
      const checked = lines.map(l => ({ l, ...validateCustom((byVariant.get(l.variantId).custom_fields ?? []) as Field[], l.custom, availableUploads) }));
      const allUploadIds = checked.flatMap(x => x.uploadIds);
      if (new Set(allUploadIds).size !== allUploadIds.length) throw new HttpError(422, 'custom_invalid_upload');
      if (!(await reserve(c, reserveLines))) throw new HttpError(409, 'out_of_stock');
      const byId = byVariant;
      const subtotal = lines.reduce((n, l) => n + byId.get(l.variantId).price_cents * l.qty, 0);
      const shipping = b.fulfilment === 'delivery' ? s.delivery_fee_cents : 0;
      const token = randomBytes(24).toString('base64url');
      const o = (await c.query(
        `INSERT INTO orders(tenant_id,store_id,public_token,customer_email,customer_name,fulfilment,delivery_address,currency,subtotal_cents,shipping_cents,total_cents,platform_fee_bps,reservation_expires_at,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + ($13 || ' minutes')::interval, $14) RETURNING id, number`,
        [s.tenant_id, s.id, token, b.email, b.name, b.fulfilment, b.address ? JSON.stringify(b.address) : null, info.currency,
         subtotal, shipping, subtotal + shipping, info.transaction_fee_bps, String(reservationMinutes), b.source ?? null])).rows[0];
      for (const { l, snapshot } of checked) {
        const r = byId.get(l.variantId);
        await c.query(
          `INSERT INTO order_items(tenant_id,order_id,variant_id,name,variant_title,quantity,unit_price_cents,unit_cost_cents,custom_values) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [s.tenant_id, o.id, l.variantId, r.name, r.title, l.qty, r.price_cents, r.cost_cents, JSON.stringify(snapshot)]);
      }
      if (allUploadIds.length) { // atomically claim the uploads: a concurrent checkout using the same image loses
        const claimed = await c.query('UPDATE custom_uploads SET order_id=$1 WHERE id = ANY($2::uuid[]) AND order_id IS NULL', [o.id, allUploadIds]);
        if (claimed.rowCount !== allUploadIds.length) throw new HttpError(422, 'custom_invalid_upload');
      }
      const intent = await provider.createIntent({ orderId: o.id, amountCents: subtotal + shipping, currency: info.currency, idempotencyKey: o.id });
      const pay = (await c.query(
        `INSERT INTO payments(tenant_id,order_id,provider,provider_ref,amount_cents,currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [s.tenant_id, o.id, provider.name, intent.providerRef, subtotal + shipping, info.currency])).rows[0];
      return { orderToken: token, orderNumber: Number(o.number), paymentId: pay.id as string, totalCents: subtotal + shipping, currency: info.currency as string,
               shippingCents: shipping, paymentProvider: { name: provider.name, status: provider.status } };
    });
    return reply.code(201).send(result);
  });

  // Customer reference images for customisable products: private storage, size/type-checked, rate-limited, expire if never ordered.
  app.post('/api/public/stores/:slug/custom-upload', { config: { rateLimit: { max: uploadRateLimitMax, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'empty_upload');
    if (body.length > maxImageBytes) throw new HttpError(413, 'image_too_large');
    const kind = sniffImage(body); if (!kind) throw new HttpError(415, 'unsupported_image_type');
    const s = await publicStore(slug);
    const key = await storage.put(kind.ext, body);
    try {
      const row = await withTx({ tenantId: s.tenant_id }, async c => (await c.query(
        'INSERT INTO custom_uploads(tenant_id,storage_key,content_type,bytes) VALUES ($1,$2,$3,$4) RETURNING id', [s.tenant_id, key, kind.type, body.length])).rows[0]);
      return reply.code(201).send({ id: row.id });
    } catch (e) { await storage.remove(key); throw e; }
  });

  // Only the seller who owns the order's tenant can view a customer's uploaded image (RLS + auth); never public.
  app.get('/api/seller/custom-uploads/:id', async (req, reply) => {
    const t = await tenantCtx(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = await withTx(t, async c => (await c.query('SELECT storage_key, content_type FROM custom_uploads WHERE id=$1', [id])).rows[0]);
    if (!u) throw new HttpError(404, 'not_found');
    const data = await storage.get(u.storage_key); if (!data) throw new HttpError(404, 'not_found');
    return reply.header('content-type', u.content_type).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=300').send(data);
  });

  app.get('/api/public/orders/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(64) }).parse(req.params);
    const o = await withTx({ platform: true }, async c => { // lookup by unguessable capability token
      const r = (await c.query('SELECT id,number,status,fulfilment,subtotal_cents,shipping_cents,total_cents,refunded_cents,currency,created_at FROM orders WHERE public_token=$1', [token])).rows[0];
      if (r) r.items = (await c.query('SELECT name,variant_title,quantity,unit_price_cents FROM order_items WHERE order_id=$1', [r.id])).rows;
      return r;
    });
    if (!o) throw new HttpError(404, 'not_found');
    return o;
  });

  // Dev/test only: stands in for a provider webhook. Absent when no simulated provider is active.
  app.post('/api/public/payments/:id/simulate', async (req) => {
    if (getProvider()?.status !== 'simulated') throw new HttpError(404, 'not_found');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { outcome } = z.object({ outcome: z.enum(['succeeded', 'failed']) }).parse(req.body);
    const ref = await withTx({ platform: true }, async c => (await c.query('SELECT provider_ref FROM payments WHERE id=$1', [id])).rows[0]?.provider_ref);
    if (!ref) throw new HttpError(404, 'not_found');
    return settlePayment(ref, outcome);
  });
}
