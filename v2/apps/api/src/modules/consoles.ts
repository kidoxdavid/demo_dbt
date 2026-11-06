import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { audit, pool, q, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { requirePerm } from '../guards.js';
import { CARD_COLUMNS, CARD_FROM, VISIBLE, toCard } from '../lib/cards.js';
import { enqueue } from '../lib/outbox.js';
import { refund } from '../lib/refunds.js';
import { SETTINGS, allSettings } from '../settings.js';

const uuid = z.string().uuid(); const idp = z.object({ id: uuid }); const why = z.string().trim().min(3).max(500);
const like = (t?: string) => (t ? `%${t.replace(/[\\%_]/g, c => '\\' + c)}%` : null);
const page = z.object({ q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) });
/** CSV cells that start with = + - @ would run as formulas in a spreadsheet: prefix them so they stay text. */
const csvCell = (v: unknown) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const dateRange = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const PAID = `so.status NOT IN ('awaiting_payment','cancelled')`;

/** Money owed to each seller, from the ledger: what they have earned, what has passed the hold after delivery (available), what was already paid out. */
async function balances(sellerId?: string, c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> } = pool) {
  const hold = Number((await allSettings(c)).payout_hold_days);
  const rows = (await c.query(`WITH owed AS (SELECT seller_id, -sum(amount_cents)::bigint AS owed FROM ledger_entries WHERE account='seller_payable' GROUP BY seller_id),
      elig AS (SELECT le.seller_id, -sum(le.amount_cents)::bigint AS eligible FROM ledger_entries le JOIN seller_orders so ON so.id=le.seller_order_id WHERE le.account='seller_payable' AND so.delivered_at IS NOT NULL AND so.delivered_at <= now() - ($1::int * interval '1 day') GROUP BY le.seller_id),
      paid AS (SELECT seller_id, sum(amount_cents)::bigint AS paid FROM payouts GROUP BY seller_id),
      sales AS (SELECT seller_id, sum(items_cents + shipping_cents)::bigint AS sales, sum(commission_cents)::bigint AS commission, sum(refunded_cents)::bigint AS refunded, count(*)::int AS orders FROM seller_orders so WHERE ${PAID} GROUP BY seller_id)
    SELECT se.id, se.legal_name AS "legalName", se.status, (SELECT sh.name FROM shops sh WHERE sh.seller_id=se.id LIMIT 1) AS shop, coalesce(sa.sales,0)::int AS "salesCents", coalesce(sa.commission,0)::int AS "commissionCents", coalesce(sa.refunded,0)::int AS "refundedCents", coalesce(sa.orders,0) AS orders,
      coalesce(o.owed,0)::int AS "owedCents", coalesce(e.eligible,0)::int AS "eligibleCents", coalesce(p.paid,0)::int AS "paidOutCents"
    FROM sellers se LEFT JOIN owed o ON o.seller_id=se.id LEFT JOIN elig e ON e.seller_id=se.id LEFT JOIN paid p ON p.seller_id=se.id LEFT JOIN sales sa ON sa.seller_id=se.id WHERE ($2::uuid IS NULL OR se.id=$2) ORDER BY coalesce(o.owed,0) DESC, se.legal_name`, [hold, sellerId ?? null])).rows;
  return { holdDays: hold, rows: rows.map(r => ({ ...r, availableCents: Math.max(0, Math.min(r.owedCents, r.eligibleCents - r.paidOutCents)), pendingCents: r.owedCents - Math.max(0, Math.min(r.owedCents, r.eligibleCents - r.paidOutCents)) })) };
}

/** One maker's balances, for their own Payouts page. */
export const balancesFor = (sellerId: string) => balances(sellerId);

export function registerConsoles(app: FastifyInstance) {
  // =========================================================== ADMIN
  app.get('/api/admin/overview', async req => {
    requirePerm(req, 'users.read');
    const [u, s, p, o, mod] = await Promise.all([q(`SELECT count(*)::int n, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new7 FROM users`), q(`SELECT count(*)::int n, count(*) FILTER (WHERE status='active')::int AS active, (SELECT count(*) FROM shops WHERE status='live')::int AS live FROM sellers`),
      q(`SELECT count(*) FILTER (WHERE status='published')::int AS published, count(*) FILTER (WHERE moderation_status='queued')::int AS queued FROM products`),
      q(`SELECT count(*)::int AS orders, coalesce(sum(total_cents),0)::int AS gmv, (SELECT count(*) FROM seller_orders WHERE status IN ('new','accepted'))::int AS open FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded') AND created_at > now() - interval '30 days'`),
      q(`SELECT 1`)]);
    void mod; return { users: u.rows[0], sellers: s.rows[0], products: p.rows[0], orders30d: o.rows[0] };
  });

  app.patch('/api/admin/users/:id', async req => {
    const a = requirePerm(req, 'users.write'); const { id } = idp.parse(req.params); const b = z.object({ status: z.enum(['active', 'disabled']), reason: why }).strict().parse(req.body);
    if (id === a.id) throw new HttpError(409, 'cannot_change_self');
    return tx(async c => {
      const u = (await c.query('SELECT id, status FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!u) throw new HttpError(404, 'not_found');
      if (b.status === 'disabled' && (await c.query(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role='admin'`, [id])).rowCount && Number((await c.query(`SELECT count(*) n FROM user_roles ur JOIN users x ON x.id=ur.user_id WHERE ur.role='admin' AND x.status='active'`)).rows[0].n) <= 1) throw new HttpError(409, 'last_admin');
      await c.query('UPDATE users SET status=$2, updated_at=now() WHERE id=$1', [id, b.status]); if (b.status === 'disabled') await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(c, { actor: a.id, area: 'admin', action: b.status === 'disabled' ? 'user.disable' : 'user.enable', entityType: 'user', entityId: id, prev: { status: u.status }, next: { status: b.status }, reason: b.reason, ip: req.ip }); return { id, status: b.status };
    });
  });

  const sellerRows = `SELECT se.id, se.legal_name AS "legalName", se.status, se.verification_tier AS "verificationTier", se.commission_bps AS "commissionBps", se.created_at AS "createdAt",
      coalesce((SELECT json_agg(json_build_object('name',sh.name,'slug',sh.slug,'status',sh.status)) FROM shops sh WHERE sh.seller_id=se.id),'[]'::json) AS shops,
      (SELECT count(*)::int FROM products p WHERE p.seller_id=se.id AND p.status='published') AS "liveProducts", (SELECT coalesce(sum(items_cents+shipping_cents),0)::int FROM seller_orders so WHERE so.seller_id=se.id AND ${PAID}) AS "salesCents",
      (SELECT u.email FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.seller_id=se.id AND r.role='seller_owner' ORDER BY r.created_at LIMIT 1) AS "ownerEmail"
    FROM sellers se`;
  app.get('/api/admin/sellers', async req => {
    requirePerm(req, 'sellers.read'); const f = page.extend({ status: z.enum(['active', 'suspended', 'closed']).optional() }).parse(req.query); const l = like(f.q);
    return (await q(`${sellerRows} WHERE ($1::text IS NULL OR se.legal_name ILIKE $1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM shops sh WHERE sh.seller_id=se.id AND sh.name ILIKE $1 ESCAPE '\\') OR EXISTS (SELECT 1 FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.seller_id=se.id AND u.email ILIKE $1 ESCAPE '\\')) AND ($2::text IS NULL OR se.status=$2) ORDER BY se.created_at DESC LIMIT $3 OFFSET $4`, [l, f.status ?? null, f.limit, f.offset])).rows;
  });
  app.get('/api/admin/sellers/:id', async req => {
    requirePerm(req, 'sellers.read'); const { id } = idp.parse(req.params); const s = (await q(`${sellerRows} WHERE se.id=$1`, [id])).rows[0]; if (!s) throw new HttpError(404, 'not_found');
    const team = (await q(`SELECT r.id, r.role, u.id AS "userId", u.email, u.full_name AS "fullName" FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.seller_id=$1 ORDER BY r.created_at`, [id])).rows;
    const history = (await q(`SELECT a.at, a.action, a.reason, a.next, u.email AS "actorEmail" FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE a.entity_type='seller' AND a.entity_id=$1 ORDER BY a.id DESC LIMIT 20`, [id])).rows;
    const notes = (await q(`SELECT n.id, n.body, n.created_at AS "createdAt", u.email AS "authorEmail" FROM support_notes n LEFT JOIN users u ON u.id=n.author_id WHERE n.entity_type='seller' AND n.entity_id=$1 ORDER BY n.id DESC`, [id])).rows;
    return { ...s, team, history, notes };
  });
  app.patch('/api/admin/sellers/:id', async req => {
    const a = requirePerm(req, 'sellers.write'); const { id } = idp.parse(req.params);
    const b = z.object({ status: z.enum(['active', 'suspended', 'closed']), verificationTier: z.enum(['basic', 'payout_verified', 'verified_maker']), commissionBps: z.number().int().min(0).max(5000).nullable(), reason: why }).partial({ status: true, verificationTier: true, commissionBps: true }).strict().parse(req.body);
    return tx(async c => {
      const s = (await c.query('SELECT * FROM sellers WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!s) throw new HttpError(404, 'not_found');
      const next = { status: b.status ?? s.status, verification_tier: b.verificationTier ?? s.verification_tier, commission_bps: 'commissionBps' in b ? b.commissionBps : s.commission_bps };
      await c.query('UPDATE sellers SET status=$2, verification_tier=$3, commission_bps=$4 WHERE id=$1', [id, next.status, next.verification_tier, next.commission_bps]);
      const changed: string[] = []; if (next.status !== s.status) changed.push(next.status === 'active' ? 'seller.reactivate' : `seller.${next.status === 'suspended' ? 'suspend' : 'close'}`); if (next.verification_tier !== s.verification_tier) changed.push('seller.tier'); if (next.commission_bps !== s.commission_bps) changed.push('seller.commission');
      for (const action of changed) await audit(c, { actor: a.id, area: 'admin', action, entityType: 'seller', entityId: id, prev: { status: s.status, tier: s.verification_tier, commissionBps: s.commission_bps }, next: { status: next.status, tier: next.verification_tier, commissionBps: next.commission_bps }, reason: b.reason, ip: req.ip });
      return (await c.query(`SELECT id, status, verification_tier AS "verificationTier", commission_bps AS "commissionBps" FROM sellers WHERE id=$1`, [id])).rows[0];
    });
  });

  app.get('/api/admin/moderation', async req => {
    requirePerm(req, 'catalogue.moderate');
    return (await q(`SELECT p.id, p.title, p.updated_at AS "updatedAt", c.name AS category, s.name AS shop, s.slug AS "shopSlug", se.legal_name AS seller, p.art_kind, p.art_tone, (SELECT pm.media_id FROM product_media pm WHERE pm.product_id=p.id ORDER BY pm.position LIMIT 1) AS cover,
        (SELECT min(price_cents) FROM variants v WHERE v.product_id=p.id AND v.status='active') AS "priceCents"
      FROM products p JOIN shops s ON s.id=p.shop_id JOIN sellers se ON se.id=p.seller_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.moderation_status='queued' ORDER BY p.updated_at`)).rows
      .map(r => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, category: r.category, shop: r.shop, shopSlug: r.shopSlug, seller: r.seller, priceCents: r.priceCents, art: r.art_kind ? { kind: r.art_kind, tone: r.art_tone } : null, image: r.cover ? `/api/media/${r.cover}/w320` : null }));
  });
  app.post('/api/admin/moderation/:id', async (req) => {
    const a = requirePerm(req, 'catalogue.moderate'); const { id } = idp.parse(req.params); const b = z.object({ decision: z.enum(['approve', 'remove']), reason: why.optional() }).strict().parse(req.body);
    if (b.decision === 'remove' && !b.reason) throw new HttpError(422, 'reason_required');
    return tx(async c => {
      const p = (await c.query('SELECT id, moderation_status, status FROM products WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!p) throw new HttpError(404, 'not_found'); if (p.moderation_status !== 'queued') throw new HttpError(409, 'not_in_queue');
      if (b.decision === 'approve') await c.query(`UPDATE products SET moderation_status='approved' WHERE id=$1`, [id]); else await c.query(`UPDATE products SET moderation_status='removed', status='hidden' WHERE id=$1`, [id]);
      await audit(c, { actor: a.id, area: 'admin', action: b.decision === 'approve' ? 'product.approve' : 'product.remove', entityType: 'product', entityId: id, prev: { moderation: p.moderation_status, status: p.status }, reason: b.reason, ip: req.ip }); return { id, decision: b.decision };
    });
  });

  // =========================================================== SUPPORT
  const orderList = `SELECT o.id, o.number, o.email, o.buyer_name AS "buyerName", o.total_cents AS "totalCents", o.status, o.payment_status AS "paymentStatus", o.created_at AS "createdAt" FROM orders o`;
  for (const win of ['support', 'finance']) app.get(`/api/${win}/orders`, async req => {
    requirePerm(req, 'orders.read'); const f = page.parse(req.query); const t = f.q?.replace(/^#/, ''); const num = t && /^\d{1,12}$/.test(t) ? Number(t) : null; const l = like(f.q);
    return (await q(`${orderList} WHERE o.status<>'awaiting_payment' AND ($1::text IS NULL OR ($2::bigint IS NOT NULL AND o.number=$2) OR o.email ILIKE $1 ESCAPE '\\' OR o.buyer_name ILIKE $1 ESCAPE '\\') ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`, [l, num, f.limit, f.offset])).rows.map(r => ({ ...r, number: Number(r.number) }));
  });
  for (const win of ['support', 'finance']) app.get(`/api/${win}/orders/:id`, async req => {
    requirePerm(req, 'orders.read'); const { id } = idp.parse(req.params); const o = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0]; if (!o) throw new HttpError(404, 'not_found');
    const sellers = (await q(`SELECT so.*, s.name AS shop_name, s.slug FROM seller_orders so JOIN shops s ON s.id=so.shop_id WHERE so.order_id=$1 ORDER BY so.created_at, so.id`, [id])).rows; const lines = (await q('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [id])).rows;
    const payments = (await q('SELECT id, provider, provider_ref AS "providerRef", amount_cents AS "amountCents", status, created_at AS "createdAt" FROM payments WHERE order_id=$1 ORDER BY created_at', [id])).rows;
    const refunds = (await q(`SELECT r.id, r.amount_cents AS "amountCents", r.status, r.reason, r.created_at AS "createdAt", r.seller_order_id AS "sellerOrderId", u.email AS "byEmail" FROM refunds r LEFT JOIN users u ON u.id=r.created_by WHERE r.order_id=$1 ORDER BY r.created_at`, [id])).rows;
    const emails = (await q(`SELECT template, status, attempts, created_at AS "createdAt", sent_at AS "sentAt" FROM outbox_emails WHERE to_email=$1 AND data->>'number'=$2 ORDER BY created_at DESC LIMIT 20`, [o.email, String(o.number)])).rows;
    const notes = (await q(`SELECT n.id, n.body, n.created_at AS "createdAt", u.email AS "authorEmail" FROM support_notes n LEFT JOIN users u ON u.id=n.author_id WHERE n.entity_type='order' AND n.entity_id=$1 ORDER BY n.id DESC`, [id])).rows;
    const threads = (await q(`SELECT t.id, s.name AS shop, (SELECT json_agg(json_build_object('sender',m.sender,'body',m.body,'createdAt',m.created_at) ORDER BY m.id) FROM messages m WHERE m.thread_id=t.id) AS messages FROM threads t JOIN seller_orders so ON so.id=t.seller_order_id JOIN shops s ON s.id=t.shop_id WHERE so.order_id=$1`, [id])).rows;
    return { threads, id: o.id, number: Number(o.number), email: o.email, buyerName: o.buyer_name, shipTo: o.ship_to, status: o.status, paymentStatus: o.payment_status, itemsCents: o.items_cents, shippingCents: o.shipping_cents, taxCents: o.tax_cents, totalCents: o.total_cents, createdAt: o.created_at, paidAt: o.paid_at, payments, refunds, emails, notes,
      sellers: sellers.map(so => ({ id: so.id, sellerId: so.seller_id, shop: { name: so.shop_name, slug: so.slug }, status: so.status, itemsCents: so.items_cents, shippingCents: so.shipping_cents, taxCents: so.tax_cents, totalCents: so.total_cents, commissionCents: so.commission_cents, refundedCents: so.refunded_cents, tracking: so.tracking_number ? { carrier: so.tracking_carrier, number: so.tracking_number } : null,
        lines: lines.filter(l => l.seller_order_id === so.id).map(l => ({ id: l.id, title: l.title, variant: l.variant_label, quantity: l.quantity, refundedQty: l.refunded_qty, unitCents: l.unit_price_cents })) })) };
  });
  const noteIn = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
  const addNote = (entity: 'order' | 'user' | 'seller', check: string) => async (req: any, reply: any) => {
    const u = requirePerm(req, 'support.write'); const { id } = idp.parse(req.params); const b = noteIn.parse(req.body);
    if (!(await pool.query(check, [id])).rowCount) throw new HttpError(404, 'not_found');
    const n = (await q('INSERT INTO support_notes(entity_type,entity_id,body,author_id) VALUES ($1,$2,$3,$4) RETURNING id, created_at AS "createdAt"', [entity, id, b.body, u.id])).rows[0]; await audit(pool, { actor: u.id, area: req.area, action: 'note.add', entityType: entity, entityId: id, ip: req.ip });
    return reply.code(201).send({ id: n.id, body: b.body, createdAt: n.createdAt, authorEmail: u.email });
  };
  app.post('/api/support/orders/:id/notes', addNote('order', 'SELECT 1 FROM orders WHERE id=$1')); app.post('/api/admin/sellers/:id/notes', addNote('seller', 'SELECT 1 FROM sellers WHERE id=$1'));
  for (const win of ['support', 'admin']) app.post(`/api/${win}/users/:id/notes`, addNote('user', 'SELECT 1 FROM users WHERE id=$1'));
  for (const win of ['support', 'admin']) app.get(`/api/${win}/users/:id`, async req => {
    requirePerm(req, 'users.read'); const { id } = idp.parse(req.params); const u = (await q('SELECT id, email, full_name AS "fullName", status, created_at AS "createdAt", email_verified_at AS "emailVerifiedAt" FROM users WHERE id=$1', [id])).rows[0]; if (!u) throw new HttpError(404, 'not_found');
    const roles = (await q('SELECT id, role, seller_id AS "sellerId" FROM user_roles WHERE user_id=$1', [id])).rows; const orders = (await q(`${orderList} WHERE o.user_id=$1 AND o.status<>'awaiting_payment' ORDER BY o.created_at DESC LIMIT 20`, [id])).rows.map(r => ({ ...r, number: Number(r.number) }));
    const notes = (await q(`SELECT n.id, n.body, n.created_at AS "createdAt", a.email AS "authorEmail" FROM support_notes n LEFT JOIN users a ON a.id=n.author_id WHERE n.entity_type='user' AND n.entity_id=$1 ORDER BY n.id DESC`, [id])).rows; return { ...u, roles, orders, notes };
  });
  app.post('/api/support/orders/:id/resend-confirmation', async (req, reply) => {
    const u = requirePerm(req, 'support.write'); const { id } = idp.parse(req.params); const o = (await q(`SELECT * FROM orders WHERE id=$1 AND payment_status IN ('paid','partially_refunded','refunded')`, [id])).rows[0]; if (!o) throw new HttpError(404, 'not_found');
    const sos = (await q(`SELECT so.id, so.est_delivery_min, so.est_delivery_max, s.name FROM seller_orders so JOIN shops s ON s.id=so.shop_id WHERE so.order_id=$1 ORDER BY so.id`, [id])).rows; const lines = (await q('SELECT title, quantity, seller_order_id FROM order_lines WHERE order_id=$1 ORDER BY id', [id])).rows;
    await enqueue(pool, o.email, 'order_confirmation', { number: Number(o.number), name: o.buyer_name, totalCents: o.total_cents, taxCents: o.tax_cents, url: `${process.env.PUBLIC_URL ?? 'http://localhost:5180'}/orders/${o.public_token}`,
      sellers: sos.map(s => ({ shop: s.name, eta: `${String(s.est_delivery_min).slice(0, 10)} to ${String(s.est_delivery_max).slice(0, 10)}`, lines: lines.filter(l => l.seller_order_id === s.id).map(l => ({ title: l.title, quantity: l.quantity })) })) });
    await audit(pool, { actor: u.id, area: 'support', action: 'order.resend_confirmation', entityType: 'order', entityId: id, ip: req.ip }); return reply.code(202).send({ queued: true });
  });

  // =========================================================== FINANCE
  app.get('/api/finance/overview', async req => {
    requirePerm(req, 'finance.read'); const acc = (await q(`SELECT account, sum(amount_cents)::bigint AS cents FROM ledger_entries GROUP BY account`)).rows; const by = Object.fromEntries(acc.map(r => [r.account, Number(r.cents)]));
    const d30 = (await q(`SELECT count(*)::int AS orders, coalesce(sum(items_cents+shipping_cents),0)::int AS sales, coalesce(sum(commission_cents),0)::int AS commission, coalesce(sum(tax_cents),0)::int AS gst, coalesce(sum(refunded_cents),0)::int AS refunded FROM seller_orders so WHERE ${PAID} AND created_at > now() - interval '30 days'`)).rows[0];
    const daily = (await q(`SELECT d::date AS day, coalesce(sum(so.items_cents + so.shipping_cents),0)::int AS cents FROM generate_series(current_date - 29, current_date, '1 day') d LEFT JOIN seller_orders so ON ${PAID} AND so.created_at::date = d::date GROUP BY d ORDER BY d`)).rows;
    const b = await balances(); return { ledger: { cash: by.cash ?? 0, sellerPayable: -(by.seller_payable ?? 0), commissionRevenue: -(by.commission_revenue ?? 0), adRevenue: -(by.ad_revenue ?? 0), taxPayable: -(by.tax_payable ?? 0) }, last30: d30, daily, payoutHoldDays: b.holdDays, availableToPay: b.rows.reduce((n, r) => n + r.availableCents, 0) };
  });
  app.get('/api/finance/sellers', async req => { requirePerm(req, 'finance.read'); const f = page.parse(req.query); const b = await balances(); const t = f.q?.toLowerCase(); return { holdDays: b.holdDays, items: b.rows.filter(r => !t || r.legalName.toLowerCase().includes(t) || (r.shop ?? '').toLowerCase().includes(t)).slice(f.offset, f.offset + f.limit) }; });
  app.get('/api/finance/payouts', async req => { requirePerm(req, 'finance.read'); const f = page.extend({ sellerId: uuid.optional() }).parse(req.query);
    return (await q(`SELECT p.id, p.amount_cents AS "amountCents", p.reference, p.note, p.created_at AS "createdAt", se.id AS "sellerId", se.legal_name AS seller, u.email AS "byEmail" FROM payouts p JOIN sellers se ON se.id=p.seller_id LEFT JOIN users u ON u.id=p.created_by WHERE ($1::uuid IS NULL OR p.seller_id=$1) ORDER BY p.created_at DESC LIMIT $2`, [f.sellerId ?? null, f.limit])).rows; });
  app.post('/api/finance/payouts', async (req, reply) => {
    const a = requirePerm(req, 'finance.write'); const b = z.object({ sellerId: uuid, amountCents: z.number().int().min(1).max(100_000_000), reference: z.string().trim().min(1).max(120), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
    const out = await tx(async c => {
      if (!(await c.query('SELECT 1 FROM sellers WHERE id=$1 FOR UPDATE', [b.sellerId])).rowCount) throw new HttpError(404, 'not_found');           // one payout at a time per seller
      const bal = (await balances(b.sellerId, c)).rows[0]; if (b.amountCents > bal.availableCents) throw new HttpError(422, 'exceeds_available', { availableCents: bal.availableCents });
      const p = (await c.query('INSERT INTO payouts(seller_id,amount_cents,reference,note,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at AS "createdAt"', [b.sellerId, b.amountCents, b.reference, b.note ?? null, a.id])).rows[0]; const txn = randomUUID();
      await c.query(`INSERT INTO ledger_entries(txn_id,seller_id,account,amount_cents,memo) VALUES ($1,$2,'cash',$3,'payout'),($1,$2,'seller_payable',$4,'payout')`, [txn, b.sellerId, -b.amountCents, b.amountCents]);
      await audit(c, { actor: a.id, area: 'finance', action: 'payout.create', entityType: 'seller', entityId: b.sellerId, next: { amountCents: b.amountCents, reference: b.reference, payoutId: p.id }, ip: req.ip }); return p;
    });
    return reply.code(201).send({ id: out.id, ...b, createdAt: out.createdAt });
  });
  app.post('/api/finance/orders/:id/refund', async req => {
    const a = requirePerm(req, 'refunds.write'); const { id } = idp.parse(req.params);        // id is the seller order
    const b = z.object({ lines: z.array(z.object({ lineId: uuid, quantity: z.number().int().min(1).max(20) }).strict()).max(50), includeShipping: z.boolean().default(false), reason: why, restock: z.boolean().default(false) }).strict().parse(req.body);
    const so = (await q('SELECT seller_id FROM seller_orders WHERE id=$1', [id])).rows[0]; if (!so) throw new HttpError(404, 'not_found'); const key = req.headers['idempotency-key'];
    return refund({ sellerOrderId: id, sellerId: so.seller_id, ...b, actor: a.id, idempotencyKey: typeof key === 'string' && key.length >= 8 && key.length <= 80 ? `finance:${key}` : undefined });
  });
  app.get('/api/finance/gst', async req => {
    requirePerm(req, 'finance.read'); const f = dateRange.parse(req.query);
    const r = (await q(`SELECT coalesce(-sum(amount_cents) FILTER (WHERE amount_cents < 0),0)::int AS collected, coalesce(sum(amount_cents) FILTER (WHERE amount_cents > 0),0)::int AS refunded FROM ledger_entries WHERE account='tax_payable' AND ($1::date IS NULL OR created_at >= $1::date) AND ($2::date IS NULL OR created_at < $2::date + 1)`, [f.from ?? null, f.to ?? null])).rows[0];
    return { from: f.from ?? null, to: f.to ?? null, collectedCents: r.collected, refundedCents: r.refunded, netOwedCents: r.collected - r.refunded };
  });
  app.get('/api/finance/export/sales.csv', async (req, reply) => {
    const a = requirePerm(req, 'finance.read'); const f = dateRange.parse(req.query);
    const rows = (await q(`SELECT o.number, o.created_at, se.legal_name, sh.name AS shop, so.status, so.items_cents, so.shipping_cents, so.tax_cents, so.total_cents, so.commission_cents, so.refunded_cents FROM seller_orders so JOIN orders o ON o.id=so.order_id JOIN sellers se ON se.id=so.seller_id JOIN shops sh ON sh.id=so.shop_id
      WHERE ${PAID} AND ($1::date IS NULL OR o.created_at >= $1::date) AND ($2::date IS NULL OR o.created_at < $2::date + 1) ORDER BY o.created_at, so.id LIMIT 50000`, [f.from ?? null, f.to ?? null])).rows; const m = (c: number) => (c / 100).toFixed(2);
    const csv = ['order,date,seller,shop,status,items,shipping,gst,total,commission,refunded', ...rows.map(r => [r.number, new Date(r.created_at).toISOString().slice(0, 10), r.legal_name, r.shop, r.status, m(r.items_cents), m(r.shipping_cents), m(r.tax_cents), m(r.total_cents), m(r.commission_cents), m(r.refunded_cents)].map(csvCell).join(','))].join('\n') + '\n';
    await audit(pool, { actor: a.id, area: 'finance', action: 'export.sales', entityType: 'report', entityId: 'sales', next: { rows: rows.length, from: f.from, to: f.to }, ip: req.ip });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="eazystores-sales.csv"').send(csv);
  });

  // =========================================================== MARKETING
  const pickSchema = z.object({ promoBar: SETTINGS.promo_bar.schema, phone: SETTINGS.home_picks_phone.schema, desktop: SETTINGS.home_picks_desktop.schema, categories: SETTINGS.home_categories.schema, spotlight: SETTINGS.home_spotlight.schema }).strict();
  const homeView = async () => { const s = await allSettings(); const ids = [...new Set([...(s.home_picks_phone as string[]), ...(s.home_picks_desktop as string[])])];
    const rows = ids.length ? (await pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE p.id = ANY($1::uuid[])`, [ids])).rows.map(toCard) : [];
    return { promoBar: s.promo_bar, phone: s.home_picks_phone, desktop: s.home_picks_desktop, categories: s.home_categories, spotlight: s.home_spotlight, products: Object.fromEntries(rows.map(c => [c.id, { title: c.title, seller: c.seller.name, available: true }])) }; };
  app.get('/api/marketing/home', async req => { requirePerm(req, 'marketing.write'); return homeView(); });
  app.put('/api/marketing/home', async req => {
    const a = requirePerm(req, 'marketing.write'); const b = pickSchema.parse(req.body); const all = [...new Set([...b.phone, ...b.desktop])];
    if (all.length && Number((await pool.query(`SELECT count(*) n ${CARD_FROM} WHERE ${VISIBLE} AND p.id = ANY($1::uuid[])`, [all])).rows[0].n) !== all.length) throw new HttpError(422, 'product_not_available');
    if (b.spotlight && !(await q(`SELECT 1 FROM shops WHERE slug=$1 AND status='live'`, [b.spotlight.shop])).rowCount) throw new HttpError(422, 'shop_not_available');
    const slugs = b.categories.map(c => c.slug); if (slugs.length && Number((await q(`SELECT count(*) n FROM categories WHERE slug = ANY($1) AND status='active'`, [slugs])).rows[0].n) !== new Set(slugs).size) throw new HttpError(422, 'category_not_found');
    const prev = await homeView(); const map: Record<string, unknown> = { promo_bar: b.promoBar, home_picks_phone: b.phone, home_picks_desktop: b.desktop, home_categories: b.categories, home_spotlight: b.spotlight };
    await tx(async c => { for (const [k, v] of Object.entries(map)) await c.query(`INSERT INTO app_settings(key,value,updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [k, JSON.stringify(v), a.id]);
      await audit(c, { actor: a.id, area: 'marketing', action: 'home.update', entityType: 'settings', entityId: 'home', prev: { phone: prev.phone, desktop: prev.desktop, promoBar: prev.promoBar }, next: { phone: b.phone, desktop: b.desktop, promoBar: b.promoBar }, ip: req.ip }); });
    return homeView();
  });
  app.get('/api/marketing/products', async req => {
    requirePerm(req, 'marketing.write'); const f = page.parse(req.query); const l = like(f.q);
    return (await pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${VISIBLE} AND ($1::text IS NULL OR p.title ILIKE $1 ESCAPE '\\' OR s.name ILIKE $1 ESCAPE '\\') ORDER BY p.created_at DESC LIMIT $2`, [l, Math.min(f.limit, 30)])).rows.map(toCard);
  });
  const term = z.string().trim().toLowerCase().min(2).max(60);
  app.get('/api/marketing/synonyms', async req => { requirePerm(req, 'marketing.write'); return (await q('SELECT term::text AS term, related FROM synonyms ORDER BY term')).rows; });
  app.put('/api/marketing/synonyms', async req => {
    const a = requirePerm(req, 'marketing.write'); const b = z.object({ term, related: z.array(term).min(1).max(10) }).strict().parse(req.body); if (b.related.includes(b.term)) throw new HttpError(422, 'term_in_related');
    await tx(async c => { await c.query('INSERT INTO synonyms(term,related) VALUES ($1,$2) ON CONFLICT (term) DO UPDATE SET related=EXCLUDED.related', [b.term, b.related]); await audit(c, { actor: a.id, area: 'marketing', action: 'synonym.set', entityType: 'synonym', entityId: b.term, next: b.related, ip: req.ip }); }); return b;
  });
  app.delete('/api/marketing/synonyms/:term', async req => {
    const a = requirePerm(req, 'marketing.write'); const t = term.parse((req.params as any).term); const r = await q('DELETE FROM synonyms WHERE term=$1', [t]); if (!r.rowCount) throw new HttpError(404, 'not_found');
    await audit(pool, { actor: a.id, area: 'marketing', action: 'synonym.delete', entityType: 'synonym', entityId: t, ip: req.ip }); return { deleted: true };
  });
}
