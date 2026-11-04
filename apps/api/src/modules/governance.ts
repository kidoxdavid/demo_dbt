import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { verifyPassword } from '../lib/security.js';
import { enqueue, ownerEmail, url } from '../lib/mail.js';
import { localStorageAdapter } from '../lib/storage.js';
import { uploadDir, TERMS_VERSION } from '../config.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const OPEN_ORDER = ['paid', 'processing', 'ready', 'shipped'];
const reason = z.string().trim().min(5).max(500);

/** Store review, verification, product moderation, account closure, and customer data erasure. Every admin action needs a reason and is audited. */
export function registerGovernance(app: FastifyInstance, deps: {
  tenantCtx: (r: FastifyRequest) => Promise<TenantCtx>; platformPerm: (r: FastifyRequest, perm: string) => Promise<void>; authenticate: (r: FastifyRequest) => Promise<void>;
}) {
  const { tenantCtx, platformPerm, authenticate } = deps;
  const files = localStorageAdapter(uploadDir);

  // ---------------- Terms ----------------
  app.post('/api/auth/accept-terms', async (req) => {
    await authenticate(req);
    await withTx({ platform: true }, c => c.query('UPDATE users SET terms_accepted_at=coalesce(terms_accepted_at, now()), terms_version=$2 WHERE id=$1', [req.user!.id, TERMS_VERSION]));
    return { ok: true, version: TERMS_VERSION };
  });

  // ---------------- Store review ----------------
  app.get('/api/admin/settings', async (req) => {
    await platformPerm(req, 'sellers.read');
    return withTx({ platform: true }, async c => ({ storeReviewRequired: (await c.query(`SELECT value FROM platform_settings WHERE key='store_review_required'`)).rows[0]?.value === true }));
  });
  app.put('/api/admin/settings/store-review', async (req) => {
    await platformPerm(req, 'settings.write');
    const b = z.object({ required: z.boolean(), reason }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      const prev = (await c.query(`SELECT value FROM platform_settings WHERE key='store_review_required'`)).rows[0]?.value === true;
      await c.query(`INSERT INTO platform_settings(key,value) VALUES ('store_review_required',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(b.required)]);
      await audit(c, { actor: req.user!.id, action: 'settings.store_review', entityType: 'setting', entityId: 'store_review_required', prev: { required: prev }, next: { required: b.required }, reason: b.reason, ip: req.ip });
      return { storeReviewRequired: b.required };
    });
  });

  app.get('/api/admin/review-queue', async (req) => {
    await platformPerm(req, 'sellers.read');
    return withTx({ platform: true }, async c => ({
      stores: (await c.query(
        `SELECT s.slug, s.name, s.submitted_at, b.business_name, b.category, b.description, b.city, b.region,
                (SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=s.tenant_id AND m.role='owner' LIMIT 1) AS owner_email,
                (SELECT count(*)::int FROM products p WHERE p.tenant_id=s.tenant_id AND p.status='active') AS active_products,
                (SELECT coalesce(json_agg(x), '[]'::json) FROM (
                   SELECT p.name, p.brand, (SELECT min(v.price_cents) FROM product_variants v WHERE v.product_id=p.id) AS price_cents,
                          (SELECT '/media/'||m.storage_key FROM product_media m WHERE m.product_id=p.id ORDER BY m.position LIMIT 1) AS image
                   FROM products p WHERE p.tenant_id=s.tenant_id AND p.status='active' ORDER BY p.created_at LIMIT 8) x) AS sample_products
         FROM stores s JOIN businesses b ON b.tenant_id=s.tenant_id WHERE s.status='pending_review' ORDER BY s.submitted_at`)).rows,
      verifications: (await c.query(
        `SELECT b.tenant_id AS "tenantId", b.business_name, b.legal_type, b.registration_number, b.verification_note AS note, b.verification_requested_at AS requested_at, s.slug,
                (SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=b.tenant_id AND m.role='owner' LIMIT 1) AS owner_email
         FROM businesses b JOIN stores s ON s.tenant_id=b.tenant_id WHERE b.verification_status='pending' ORDER BY b.verification_requested_at`)).rows,
    }));
  });

  app.post('/api/admin/stores/:slug/approve', async (req) => {
    await platformPerm(req, 'reviews.write');
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    const b = z.object({ note: z.string().trim().max(500).optional() }).strict().parse(req.body ?? {});
    return withTx({ platform: true }, async c => {
      const s = (await c.query(`UPDATE stores SET status='published', published_at=coalesce(published_at,now()), reviewed_at=now(), review_note=$2 WHERE slug=$1 AND status='pending_review' RETURNING id, tenant_id, name`, [slug, b.note ?? null])).rows[0];
      if (!s) throw new HttpError(409, 'not_pending_review');
      await c.query('UPDATE businesses SET onboarding_completed_at=coalesce(onboarding_completed_at,now()) WHERE tenant_id=$1', [s.tenant_id]);
      await audit(c, { actor: req.user!.id, tenantId: s.tenant_id, action: 'store.approve', entityType: 'store', entityId: s.id, prev: { status: 'pending_review' }, next: { status: 'published' }, reason: b.note, ip: req.ip });
      const to = await ownerEmail(c, s.tenant_id);
      if (to) await enqueue(c, { tenantId: s.tenant_id, to, template: 'store_approved', data: { storeName: s.name, url: url(`/store/${slug}`) } });
      return { slug, status: 'published' };
    });
  });
  app.post('/api/admin/stores/:slug/reject', async (req) => {
    await platformPerm(req, 'reviews.write');
    const { slug } = z.object({ slug: z.string().regex(SLUG) }).parse(req.params);
    const b = z.object({ reason }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      const s = (await c.query(`UPDATE stores SET status='draft', reviewed_at=now(), review_note=$2 WHERE slug=$1 AND status='pending_review' RETURNING id, tenant_id, name`, [slug, b.reason])).rows[0];
      if (!s) throw new HttpError(409, 'not_pending_review');
      await audit(c, { actor: req.user!.id, tenantId: s.tenant_id, action: 'store.reject', entityType: 'store', entityId: s.id, prev: { status: 'pending_review' }, next: { status: 'draft' }, reason: b.reason, ip: req.ip });
      const to = await ownerEmail(c, s.tenant_id);
      if (to) await enqueue(c, { tenantId: s.tenant_id, to, template: 'store_rejected', data: { storeName: s.name, reason: b.reason, url: url('/dashboard/settings') } });
      return { slug, status: 'draft' };
    });
  });

  // ---------------- Verified seller (never purchasable: set only by staff after review) ----------------
  app.post('/api/seller/verification/request', async (req) => {
    const t = await tenantCtx(req); if (t.role !== 'owner') throw new HttpError(403, 'forbidden');
    const b = z.object({ registrationNumber: z.string().trim().max(80).optional(), note: z.string().trim().min(10).max(1000) }).strict().parse(req.body);
    return withTx(t, async c => {
      const cur = (await c.query('SELECT verification_status FROM businesses WHERE tenant_id=$1', [t.tenantId])).rows[0];
      if (!['unverified', 'rejected'].includes(cur.verification_status)) throw new HttpError(409, `verification_${cur.verification_status}`);
      await c.query(`UPDATE businesses SET verification_status='pending', verification_note=$2, registration_number=coalesce($3,registration_number), verification_requested_at=now(), verification_decision_reason=NULL WHERE tenant_id=$1`, [t.tenantId, b.note, b.registrationNumber ?? null]);
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'verification.request', entityType: 'business', entityId: t.tenantId, prev: { status: cur.verification_status }, next: { status: 'pending' } });
      return { status: 'pending' };
    });
  });
  app.post('/api/admin/verifications/:tenantId/decide', async (req) => {
    await platformPerm(req, 'reviews.write');
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['verified', 'rejected']), reason }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      const r = await c.query(`UPDATE businesses SET verification_status=$2, verification_reviewed_at=now(), verification_decision_reason=$3 WHERE tenant_id=$1 AND verification_status='pending' RETURNING business_name`, [tenantId, b.decision, b.reason]);
      if (!r.rowCount) throw new HttpError(409, 'not_pending_verification');
      await audit(c, { actor: req.user!.id, tenantId, action: `verification.${b.decision}`, entityType: 'business', entityId: tenantId, prev: { status: 'pending' }, next: { status: b.decision }, reason: b.reason, ip: req.ip });
      const to = await ownerEmail(c, tenantId);
      if (to) await enqueue(c, { tenantId, to, template: 'verification_decided', data: { decision: b.decision, reason: b.reason, url: url('/dashboard/settings') } });
      return { status: b.decision };
    });
  });

  // ---------------- Product moderation ----------------
  app.get('/api/admin/products', async (req) => {
    await platformPerm(req, 'sellers.read');
    const q = z.object({ q: z.string().trim().max(80).optional(), status: z.enum(['draft', 'active', 'archived', 'removed']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, c => '\\' + c)}%` : null;
    return withTx({ platform: true }, async c => (await c.query(
      `SELECT p.id, p.name, p.brand, p.status, p.moderation_reason, s.slug AS store_slug, b.business_name,
              (SELECT min(v.price_cents) FROM product_variants v WHERE v.product_id=p.id) AS price_cents
       FROM products p JOIN stores s ON s.tenant_id=p.tenant_id JOIN businesses b ON b.tenant_id=p.tenant_id
       WHERE ($1::text IS NULL OR p.name ILIKE $1 ESCAPE '\\' OR p.brand ILIKE $1 ESCAPE '\\' OR s.slug ILIKE $1 ESCAPE '\\' OR b.business_name ILIKE $1 ESCAPE '\\') AND ($2::text IS NULL OR p.status=$2)
       ORDER BY p.created_at DESC LIMIT $3`, [like, q.status ?? null, q.limit])).rows);
  });
  app.post('/api/admin/products/:id/remove', async (req) => {
    await platformPerm(req, 'reviews.write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ reason }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      const p = (await c.query('SELECT id, tenant_id, name, status FROM products WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new HttpError(404, 'not_found'); if (p.status === 'removed') throw new HttpError(409, 'already_removed');
      await c.query(`UPDATE products SET status='removed', moderation_reason=$2, moderated_at=now(), updated_at=now() WHERE id=$1`, [id, b.reason]);
      await audit(c, { actor: req.user!.id, tenantId: p.tenant_id, action: 'product.remove', entityType: 'product', entityId: id, prev: { status: p.status }, next: { status: 'removed' }, reason: b.reason, ip: req.ip });
      const to = await ownerEmail(c, p.tenant_id);
      if (to) await enqueue(c, { tenantId: p.tenant_id, to, template: 'product_removed', data: { name: p.name, reason: b.reason, url: url('/dashboard/products') } });
      return { id, status: 'removed' };
    });
  });
  app.post('/api/admin/products/:id/restore', async (req) => {
    await platformPerm(req, 'reviews.write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ reason }).strict().parse(req.body);
    return withTx({ platform: true }, async c => {
      const r = await c.query(`UPDATE products SET status='draft', moderation_reason=NULL, moderated_at=now(), updated_at=now() WHERE id=$1 AND status='removed' RETURNING tenant_id`, [id]);
      if (!r.rowCount) throw new HttpError(409, 'not_removed');
      await audit(c, { actor: req.user!.id, tenantId: r.rows[0].tenant_id, action: 'product.restore', entityType: 'product', entityId: id, prev: { status: 'removed' }, next: { status: 'draft' }, reason: b.reason, ip: req.ip });
      return { id, status: 'draft' };
    });
  });

  // ---------------- Seller account closure ----------------
  // Closes the store and removes the seller's personal data and product photos. Orders, refunds and the ledger are kept because
  // financial records must be retained; how long is a legal question (see docs). Customers' personal data on kept orders can be erased separately.
  app.post('/api/seller/close-account', async (req) => {
    const t = await tenantCtx(req); if (t.role !== 'owner') throw new HttpError(403, 'forbidden');
    const b = z.object({ password: z.string().min(1), confirm: z.literal('CLOSE') }).strict().parse(req.body);
    if (req.user!.mfaEnabledAt && !req.user!.mfaAt) throw new HttpError(403, 'mfa_required');
    const keys = await withTx({ platform: true }, async c => {
      const u = (await c.query('SELECT email, password_hash FROM users WHERE id=$1', [t.userId])).rows[0];
      if (!(await verifyPassword(b.password, u.password_hash))) throw new HttpError(401, 'invalid_credentials');
      const open = Number((await c.query(`SELECT count(*) n FROM orders WHERE tenant_id=$1 AND status = ANY($2)`, [t.tenantId, OPEN_ORDER])).rows[0].n);
      if (open > 0) throw new HttpError(409, `open_orders:${open}`);
      const unresolved = Number((await c.query('SELECT count(*) n FROM payments WHERE tenant_id=$1 AND needs_refund AND refund_resolved_at IS NULL', [t.tenantId])).rows[0].n);
      if (unresolved > 0) throw new HttpError(409, 'unresolved_refunds');
      // unpaid checkouts: cancel and give their stock back
      await c.query(`UPDATE inventory_levels l SET reserved = l.reserved - i.quantity FROM order_items i JOIN orders o ON o.id=i.order_id JOIN product_variants v ON v.id=i.variant_id
                     WHERE o.tenant_id=$1 AND o.status='awaiting_payment' AND l.variant_id=i.variant_id AND v.track_inventory`, [t.tenantId]);
      await c.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE tenant_id=$1 AND status='awaiting_payment'`, [t.tenantId]);
      await enqueue(c, { tenantId: t.tenantId, to: u.email, template: 'account_closed', data: {} });        // sent to the old address before it is anonymised
      await c.query(`UPDATE tenants SET status='closed' WHERE id=$1`, [t.tenantId]);
      await c.query(`UPDATE stores SET status='suspended', review_note='Account closed by the owner' WHERE tenant_id=$1`, [t.tenantId]);
      await c.query(`UPDATE products SET status='archived' WHERE tenant_id=$1 AND status NOT IN ('removed','archived')`, [t.tenantId]);
      await c.query(`UPDATE businesses SET contact_email=NULL, contact_phone=NULL, description=NULL, registration_number=NULL, tax_number=NULL, social='{}', city=NULL, verification_note=NULL WHERE tenant_id=$1`, [t.tenantId]);
      const media = (await c.query('DELETE FROM product_media WHERE tenant_id=$1 RETURNING storage_key', [t.tenantId])).rows.map(r => r.storage_key as string);
      // seller accounts that belong only to this business are anonymised and disabled
      const users = (await c.query(`SELECT m.user_id FROM memberships m WHERE m.tenant_id=$1 AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.user_id=m.user_id AND o.tenant_id<>$1)`, [t.tenantId])).rows.map(r => r.user_id as string);
      for (const uid of users) {
        await c.query(`UPDATE users SET email='closed-'||id||'@invalid.example', full_name='Closed account', password_hash='!', disabled_at=now(), mfa_secret_enc=NULL, mfa_enabled_at=NULL, mfa_recovery='[]' WHERE id=$1`, [uid]);
        await c.query('DELETE FROM sessions WHERE user_id=$1', [uid]); await c.query('DELETE FROM mfa_challenges WHERE user_id=$1', [uid]); await c.query('DELETE FROM email_tokens WHERE user_id=$1', [uid]);
      }
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'account.closed', entityType: 'tenant', entityId: t.tenantId, next: { status: 'closed' }, ip: req.ip });
      return media;
    });
    for (const k of keys) await files.remove(k);       // photos are deleted from storage after the database commit
    return { ok: true, closed: true };
  });

  // ---------------- Customer privacy erasure ----------------
  // Replaces a customer's personal details on their ORDERS with placeholders. Amounts, dates, items and the ledger stay for accounting.
  // Refused while any of their orders is still being fulfilled. The audit entry stores a hash of the email, never the address itself.
  app.post('/api/admin/privacy/erase-customer', async (req) => {
    await platformPerm(req, 'privacy.write');
    const b = z.object({ email: z.string().email().max(254), reason }).strict().parse(req.body);
    const removed = await withTx({ platform: true }, async c => {
      const orders = (await c.query(`SELECT id, tenant_id, status FROM orders WHERE lower(customer_email)=lower($1) AND anonymised_at IS NULL FOR UPDATE`, [b.email])).rows;
      if (!orders.length) throw new HttpError(404, 'no_orders_found');
      const open = orders.filter(o => ['awaiting_payment', ...OPEN_ORDER].includes(o.status)).length;
      if (open) throw new HttpError(409, `open_orders:${open}`);
      const ids = orders.map(o => o.id as string);
      const uploads: string[] = [];
      const items = (await c.query('SELECT id, custom_values FROM order_items WHERE order_id = ANY($1::uuid[]) AND jsonb_array_length(custom_values) > 0', [ids])).rows;
      for (const it of items) {
        const scrubbed = (it.custom_values as any[]).map(v => ({ label: v.label, type: v.type, value: '[erased]' }));
        for (const v of it.custom_values as any[]) if (v.type === 'image') {
          const u = (await c.query('DELETE FROM custom_uploads WHERE id=$1 RETURNING storage_key', [v.value])).rows[0]; if (u) uploads.push(u.storage_key);
        }
        await c.query('UPDATE order_items SET custom_values=$2 WHERE id=$1', [it.id, JSON.stringify(scrubbed)]);
      }
      await c.query(`UPDATE orders SET customer_name='Erased customer', customer_email='erased-'||id||'@invalid.example', delivery_address=NULL, anonymised_at=now() WHERE id = ANY($1::uuid[])`, [ids]);
      const mails = await c.query(`UPDATE email_outbox SET to_email='erased@invalid.example', subject='[erased]', text_body='[erased]', html_body='[erased]' WHERE lower(to_email)=lower($1)`, [b.email]);
      const hash = createHash('sha256').update(b.email.toLowerCase()).digest('hex').slice(0, 16);
      await audit(c, { actor: req.user!.id, action: 'privacy.erase_customer', entityType: 'customer', entityId: hash, next: { orders: ids.length, emails: mails.rowCount, uploads: uploads.length }, reason: b.reason, ip: req.ip });
      return { orders: ids.length, emails: mails.rowCount ?? 0, uploads };
    });
    for (const k of removed.uploads) await files.remove(k);
    return { orders: removed.orders, emails: removed.emails, uploads: removed.uploads.length };
  });
}
