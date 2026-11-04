import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const can = (t: TenantCtx) => { if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden'); };

/** Seller-managed discount codes and shipping rules. */
export function registerPricing(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx> }) {
  const { tenantCtx } = deps;

  // ---------------- Shipping rules (the whole list is replaced atomically; order matters: the first match wins) ----------------
  const ruleIn = z.object({
    name: z.string().trim().min(1).max(80),
    regions: z.array(z.string().length(2).toUpperCase()).max(13).default([]),
    minWeightG: z.number().int().min(0).max(1_000_000).default(0), maxWeightG: z.number().int().min(0).max(1_000_000).nullable().default(null),
    minSubtotalCents: z.number().int().min(0).max(100_000_000).default(0), maxSubtotalCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
    priceCents: z.number().int().min(0).max(1_000_000),
  }).strict().refine(r => r.maxWeightG == null || r.maxWeightG >= r.minWeightG, { message: 'Maximum weight must be at least the minimum' })
    .refine(r => r.maxSubtotalCents == null || r.maxSubtotalCents >= r.minSubtotalCents, { message: 'Maximum order value must be at least the minimum' });

  app.get('/api/seller/shipping-rules', async (req) => {
    const t = await tenantCtx(req);
    return withTx(t, async c => (await c.query(
      `SELECT id, name, regions, min_weight_g AS "minWeightG", max_weight_g AS "maxWeightG", min_subtotal_cents AS "minSubtotalCents", max_subtotal_cents AS "maxSubtotalCents", price_cents AS "priceCents"
       FROM shipping_rules ORDER BY position, created_at`)).rows);
  });
  app.put('/api/seller/shipping-rules', async (req) => {
    const t = await tenantCtx(req); can(t);
    const rules = z.object({ rules: z.array(ruleIn).max(30) }).strict().parse(req.body).rules;
    return withTx(t, async c => {
      const valid = new Set((await c.query(`SELECT region FROM tax_rates WHERE country='CA'`)).rows.map(r => r.region as string));
      for (const r of rules) for (const g of r.regions) if (!valid.has(g)) throw new HttpError(422, `unknown_region:${g}`);
      const prev = (await c.query('SELECT count(*)::int n FROM shipping_rules')).rows[0].n;
      await c.query('DELETE FROM shipping_rules WHERE tenant_id=$1', [t.tenantId]);
      for (const [i, r] of rules.entries())
        await c.query(`INSERT INTO shipping_rules(tenant_id,name,regions,min_weight_g,max_weight_g,min_subtotal_cents,max_subtotal_cents,price_cents,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [t.tenantId, r.name, r.regions, r.minWeightG, r.maxWeightG, r.minSubtotalCents, r.maxSubtotalCents, r.priceCents, i]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'shipping_rules.replace', entityType: 'store', entityId: t.tenantId, prev: { rules: prev }, next: { rules: rules.length } });
      return { saved: rules.length };
    });
  });

  // ---------------- Discount codes ----------------
  const discountIn = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, 'Use 3 to 30 letters, numbers, hyphens or underscores'),
    kind: z.enum(['percent', 'fixed', 'free_shipping']), value: z.number().int().min(0).max(100_000_000).default(0),
    minSubtotalCents: z.number().int().min(0).max(100_000_000).default(0),
    startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(), maxUsesPerEmail: z.number().int().min(1).max(1000).nullable().optional(),
  }).strict().superRefine((d, ctx) => {
    if (d.kind === 'percent' && !(d.value >= 1 && d.value <= 100)) ctx.addIssue({ code: 'custom', message: 'A percentage must be between 1 and 100', path: ['value'] });
    if (d.kind === 'fixed' && d.value < 1) ctx.addIssue({ code: 'custom', message: 'A fixed discount must be more than zero', path: ['value'] });
    if (d.kind === 'free_shipping' && d.value !== 0) ctx.addIssue({ code: 'custom', message: 'Free shipping has no amount', path: ['value'] });
    if (d.startsAt && d.endsAt && new Date(d.endsAt) <= new Date(d.startsAt)) ctx.addIssue({ code: 'custom', message: 'The end date must be after the start date', path: ['endsAt'] });
  });

  app.get('/api/seller/discounts', async (req) => {
    const t = await tenantCtx(req);
    return withTx(t, async c => (await c.query(
      `SELECT d.id, d.code, d.kind, d.value, d.min_subtotal_cents AS "minSubtotalCents", d.starts_at AS "startsAt", d.ends_at AS "endsAt", d.max_uses AS "maxUses", d.max_uses_per_email AS "maxUsesPerEmail", d.active,
              count(o.id) FILTER (WHERE o.status<>'cancelled')::int AS redemptions,
              coalesce(sum(r.amount_cents) FILTER (WHERE o.status<>'cancelled'),0)::int AS "discountGivenCents"
       FROM discounts d LEFT JOIN discount_redemptions r ON r.discount_id=d.id LEFT JOIN orders o ON o.id=r.order_id
       GROUP BY d.id ORDER BY d.created_at DESC`)).rows);
  });
  app.post('/api/seller/discounts', async (req, reply) => {
    const t = await tenantCtx(req); can(t);
    const b = discountIn.parse(req.body);
    const row = await withTx(t, async c => {
      const r = await c.query(
        `INSERT INTO discounts(tenant_id,code,kind,value,min_subtotal_cents,starts_at,ends_at,max_uses,max_uses_per_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code`,
        [t.tenantId, b.code, b.kind, b.value, b.minSubtotalCents, b.startsAt ?? null, b.endsAt ?? null, b.maxUses ?? null, b.maxUsesPerEmail ?? null])
        .catch(e => { if (e.code === '23505') throw new HttpError(409, 'code_exists'); throw e; });
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'discount.create', entityType: 'discount', entityId: r.rows[0].id, next: { code: b.code, kind: b.kind, value: b.value } });
      return r.rows[0];
    });
    return reply.code(201).send(row);
  });
  // The deal itself cannot change once customers have used it (code, kind, amount); it can be paused, extended or capped.
  app.patch('/api/seller/discounts/:id', async (req) => {
    const t = await tenantCtx(req); can(t);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ active: z.boolean(), endsAt: z.string().datetime().nullable(), maxUses: z.number().int().min(1).nullable() }).partial().strict().parse(req.body);
    return withTx(t, async c => {
      const prev = (await c.query('SELECT * FROM discounts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!prev) throw new HttpError(404, 'not_found');
      const row = (await c.query(
        `UPDATE discounts SET active=coalesce($2,active), ends_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE ends_at END, max_uses = CASE WHEN $5::boolean THEN $6::int ELSE max_uses END WHERE id=$1 RETURNING *`,
        [id, b.active ?? null, 'endsAt' in b, b.endsAt ?? null, 'maxUses' in b, b.maxUses ?? null])).rows[0];
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'discount.update', entityType: 'discount', entityId: id, prev: { active: prev.active, ends_at: prev.ends_at, max_uses: prev.max_uses }, next: { active: row.active, ends_at: row.ends_at, max_uses: row.max_uses } });
      return { id, active: row.active };
    });
  });
}
