import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit, realPng } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });
afterEach(async () => { await oq(`DELETE FROM platform_settings WHERE key='store_review_required'`); delete process.env.REQUIRE_TERMS; });

const PW = 'correct-horse-battery';
const PNG = await realPng(64, 48);
const post = (url: string, payload: object, cookie?: string) => app.inject({ method: 'POST', url, payload, ...(cookie ? ck(cookie) : {}) });
const put = (url: string, payload: object, cookie: string) => app.inject({ method: 'PUT', url, payload, ...ck(cookie) });
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, ...(cookie ? ck(cookie) : {}) });
const outbox = async (to: string, template: string) => (await oq(`SELECT * FROM email_outbox WHERE to_email=$1 AND template=$2 ORDER BY created_at`, [to, template])).rows;

async function staff(n: string, role: string) {
  const s = await k.seller(n); const id = (await oq('SELECT id FROM users WHERE email=$1', [`${n}@k.test`])).rows[0].id;
  await oq('INSERT INTO platform_staff(user_id,role_key) VALUES ($1,$2)', [id, role]); return s.cookie;
}
/** A seller with a complete profile and one active product, NOT yet published. */
async function draftSeller(n: string) {
  const r = await post('/api/auth/signup', { email: `${n}@g.test`, password: PW, fullName: n, businessName: `${n} Biz`, storeSlug: `${n}-gov` });
  const cookie = r.cookies.find(c => c.name === 'eazy_sid')!.value;
  await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(cookie), payload: { category: 'Gifts', description: 'Nice things', fulfilment: { pickup: true, delivery: false, shipping: false } } });
  const p = await k.product(cookie); return { cookie, slug: `${n}-gov`, email: `${n}@g.test`, tenantId: r.json().tenantId as string, p };
}
const turnReviewOn = (cookie: string) => put('/api/admin/settings/store-review', { required: true, reason: 'Launching with manual review' }, cookie);

describe('store review before going live', () => {
  it('needs settings.write and a reason, and is audited', async () => {
    const adm = await staff('gv1', 'super_admin'); const mod = await staff('gv2', 'moderator');
    expect((await put('/api/admin/settings/store-review', { required: true, reason: 'Launch review' }, mod)).statusCode).toBe(403);
    expect((await put('/api/admin/settings/store-review', { required: true }, adm)).statusCode).toBe(400);
    expect((await turnReviewOn(adm)).json()).toEqual({ storeReviewRequired: true });
    expect((await get('/api/admin/settings', mod)).json()).toEqual({ storeReviewRequired: true });
    const log = (await oq(`SELECT * FROM audit_logs WHERE action='settings.store_review' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log).toMatchObject({ reason: 'Launching with manual review', previous_value: { required: false }, new_value: { required: true } });
  });
  it('a submitted store waits for approval, then goes live, and the seller is told', async () => {
    const adm = await staff('gv3', 'super_admin'); const mod = await staff('gv4', 'moderator'); const sup = await staff('gv5', 'support');
    await turnReviewOn(adm); const s = await draftSeller('gv6');
    const pub = await post('/api/seller/store/publish', {}, s.cookie); expect(pub.json().status).toBe('pending_review');
    expect((await get(`/api/public/stores/${s.slug}`)).statusCode).toBe(404);                     // not visible while waiting
    expect((await get('/api/public/marketplace')).json().stores.map((x: any) => x.slug)).not.toContain(s.slug);
    const q = (await get('/api/admin/review-queue', sup)).json(); const row = q.stores.find((x: any) => x.slug === s.slug);
    expect(row).toMatchObject({ business_name: 'gv6 Biz', owner_email: s.email, active_products: 1 });
    expect((await post(`/api/admin/stores/${s.slug}/approve`, {}, sup)).statusCode).toBe(403);   // support cannot decide
    expect((await post(`/api/admin/stores/${s.slug}/approve`, { note: 'Looks good' }, mod)).json().status).toBe('published');
    expect((await get(`/api/public/stores/${s.slug}`)).statusCode).toBe(200);
    expect((await post(`/api/admin/stores/${s.slug}/approve`, {}, mod)).statusCode).toBe(409);   // not pending any more
    expect((await outbox(s.email, 'store_approved'))).toHaveLength(1);
    expect((await oq(`SELECT reason FROM audit_logs WHERE action='store.approve' AND tenant_id=$1`, [s.tenantId])).rows[0].reason).toBe('Looks good');
  });
  it('a rejection needs a reason, returns the store to draft with the note, and the seller can resubmit', async () => {
    const adm = await staff('gv7', 'super_admin'); const mod = await staff('gv8', 'moderator');
    await turnReviewOn(adm); const s = await draftSeller('gv9'); await post('/api/seller/store/publish', {}, s.cookie);
    expect((await post(`/api/admin/stores/${s.slug}/reject`, {}, mod)).statusCode).toBe(400);
    expect((await post(`/api/admin/stores/${s.slug}/reject`, { reason: 'Please describe what you sell more clearly' }, mod)).json().status).toBe('draft');
    const biz = (await get('/api/seller/business', s.cookie)).json(); expect(biz.store).toMatchObject({ status: 'draft', review_note: 'Please describe what you sell more clearly' });
    expect((await outbox(s.email, 'store_rejected'))[0].text_body).toContain('describe what you sell more clearly');
    expect((await post('/api/seller/store/publish', {}, s.cookie)).json().status).toBe('pending_review');
    expect((await get('/api/admin/review-queue', mod)).json().stores.map((x: any) => x.slug)).toContain(s.slug);
  });
  it('an already live store stays live when review is switched on', async () => {
    const adm = await staff('gv10', 'super_admin'); const s = await k.seller('gv11');       // published immediately (review off at the time)
    await turnReviewOn(adm);
    expect((await post('/api/seller/store/publish', {}, s.cookie)).json().status).toBe('published');
    expect((await get(`/api/public/stores/${s.slug}`)).statusCode).toBe(200);
  });
});

describe('verified seller badge', () => {
  it('is requested by the owner, decided by staff with a reason, shown publicly, and cannot be bought with a plan', async () => {
    const mod = await staff('gv12', 'moderator'); const s = await k.seller('gv13'); const other = await k.seller('gv14');
    await k.product(s.cookie); await k.product(other.cookie);
    expect((await post('/api/seller/verification/request', { note: 'short' }, s.cookie)).statusCode).toBe(400);
    expect((await post('/api/seller/verification/request', { registrationNumber: 'AB-12345', note: 'Registered sole proprietorship in Alberta.' }, s.cookie)).json().status).toBe('pending');
    expect((await post('/api/seller/verification/request', { note: 'Asking again while pending.' }, s.cookie)).statusCode).toBe(409);
    const q = (await get('/api/admin/review-queue', mod)).json().verifications.find((v: any) => v.tenantId === s.tenantId);
    expect(q).toMatchObject({ registration_number: 'AB-12345', owner_email: 'gv13@k.test' });
    expect((await get(`/api/public/stores/${s.slug}`)).json().verified).toBe(false);          // pending is not verified
    expect((await post(`/api/admin/verifications/${s.tenantId}/decide`, { decision: 'verified' }, mod)).statusCode).toBe(400);
    expect((await post(`/api/admin/verifications/${s.tenantId}/decide`, { decision: 'verified', reason: 'Registry entry matches the details provided' }, mod)).json().status).toBe('verified');
    expect((await get(`/api/public/stores/${s.slug}`)).json().verified).toBe(true);
    const mk = (await get('/api/public/marketplace')).json().stores; expect(mk.find((x: any) => x.slug === s.slug).verified).toBe(true); expect(mk.find((x: any) => x.slug === other.slug).verified).toBe(false);
    // buying the top plan does nothing for an unverified seller
    await oq(`UPDATE tenants SET plan_id=(SELECT id FROM plans WHERE code='enterprise') WHERE id=$1`, [other.tenantId]);
    expect((await get(`/api/public/stores/${other.slug}`)).json().verified).toBe(false);
    expect((await post(`/api/admin/verifications/${s.tenantId}/decide`, { decision: 'rejected', reason: 'Second decision should fail' }, mod)).statusCode).toBe(409);
  });
  it('a rejected request can be resubmitted', async () => {
    const mod = await staff('gv15', 'moderator'); const s = await k.seller('gv16');
    await post('/api/seller/verification/request', { note: 'First attempt without documents.' }, s.cookie);
    await post(`/api/admin/verifications/${s.tenantId}/decide`, { decision: 'rejected', reason: 'No registration number provided' }, mod);
    expect((await outbox('gv16@k.test', 'verification_decided'))[0].text_body).toContain('No registration number provided');
    expect((await post('/api/seller/verification/request', { registrationNumber: 'XY-9', note: 'Second attempt with number.' }, s.cookie)).json().status).toBe('pending');
  });
});

describe('product moderation', () => {
  it('removes a product everywhere, tells the seller, blocks reactivation and checkout, and staff can restore it', async () => {
    const mod = await staff('gv17', 'moderator'); const sup = await staff('gv18', 'support'); const s = await k.seller('gv19'); const p = await k.product(s.cookie, { name: 'Bad Item' });
    expect((await get(`/api/public/stores/${s.slug}/products/${p.id}`)).statusCode).toBe(200);
    expect((await post(`/api/admin/products/${p.id}/remove`, { reason: 'Prohibited item category' }, sup)).statusCode).toBe(403);
    expect((await post(`/api/admin/products/${p.id}/remove`, {}, mod)).statusCode).toBe(400);
    expect((await post(`/api/admin/products/${p.id}/remove`, { reason: 'Prohibited item category' }, mod)).json().status).toBe('removed');
    expect((await get(`/api/public/stores/${s.slug}/products/${p.id}`)).statusCode).toBe(404);
    expect((await get('/api/public/marketplace?q=Bad%20Item')).json().products).toEqual([]);
    expect((await k.checkout(s.slug, p.variantId, 1)).statusCode).toBe(422);
    const mine = (await get('/api/seller/products', s.cookie)).json().find((x: any) => x.id === p.id); expect(mine).toMatchObject({ status: 'removed', moderationReason: 'Prohibited item category' });
    expect((await app.inject({ method: 'PATCH', url: `/api/seller/products/${p.id}`, ...ck(s.cookie), payload: { status: 'active' } })).json().error).toBe('removed_by_moderator');
    expect((await outbox('gv19@k.test', 'product_removed'))[0].text_body).toContain('Prohibited item category');
    expect((await get('/api/admin/products?q=Bad%20Item&status=removed', sup)).json()[0]).toMatchObject({ id: p.id, store_slug: s.slug, moderation_reason: 'Prohibited item category' });
    expect((await post(`/api/admin/products/${p.id}/remove`, { reason: 'Removing it twice again' }, mod)).statusCode).toBe(409);
    expect((await post(`/api/admin/products/${p.id}/restore`, { reason: 'Appeal accepted, item is allowed' }, mod)).json().status).toBe('draft');
    expect((await app.inject({ method: 'PATCH', url: `/api/seller/products/${p.id}`, ...ck(s.cookie), payload: { status: 'active' } })).statusCode).toBe(200);
    expect((await oq(`SELECT count(*)::int n FROM audit_logs WHERE entity_id=$1 AND action IN ('product.remove','product.restore')`, [p.id])).rows[0].n).toBe(2);
  });
});

describe('terms acceptance', () => {
  it('is recorded at signup, can be accepted later, and gates publishing when required', async () => {
    process.env.REQUIRE_TERMS = 'true';
    const a = await post('/api/auth/signup', { email: 'tm1@g.test', password: PW, fullName: 'T', businessName: 'T Biz', storeSlug: 'tm1-gov' });
    const ca = a.cookies.find(c => c.name === 'eazy_sid')!.value;
    await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(ca), payload: { category: 'x', description: 'y' } });
    expect((await get('/api/me', ca)).json().termsAccepted).toBe(false);
    const blocked = await post('/api/seller/store/publish', {}, ca); expect(blocked.statusCode).toBe(403); expect(blocked.json().error).toBe('terms_not_accepted');
    expect((await post('/api/auth/accept-terms', {}, ca)).json().version).toMatch(/draft/);
    expect((await post('/api/seller/store/publish', {}, ca)).statusCode).toBe(200);
    const b = await post('/api/auth/signup', { email: 'tm2@g.test', password: PW, fullName: 'T2', businessName: 'T2 Biz', storeSlug: 'tm2-gov', acceptTerms: true });
    expect((await get('/api/me', b.cookies.find(c => c.name === 'eazy_sid')!.value)).json().termsAccepted).toBe(true);
    expect((await oq('SELECT terms_version FROM users WHERE email=$1', ['tm2@g.test'])).rows[0].terms_version).toMatch(/draft/);
  });
});

describe('seller account closure', () => {
  const close = (cookie: string, body: object) => post('/api/seller/close-account', body, cookie);
  it('is blocked while orders are open or a customer is owed a refund', async () => {
    const s = await k.seller('gv20'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 1);
    const r = await close(s.cookie, { password: PW, confirm: 'CLOSE' }); expect(r.statusCode).toBe(409); expect(r.json().error).toBe('open_orders:1');
    for (const st of ['processing', 'shipped', 'completed']) await app.inject({ method: 'POST', url: `/api/seller/orders/${o.orderId}/status`, ...ck(s.cookie), payload: { status: st } });
    await oq(`UPDATE payments SET needs_refund=true WHERE id=$1`, [o.paymentId]);
    expect((await close(s.cookie, { password: PW, confirm: 'CLOSE' })).json().error).toBe('unresolved_refunds');
    expect((await close(s.cookie, { password: 'wrong-password-1', confirm: 'CLOSE' })).statusCode).toBe(401);
    expect((await close(s.cookie, { password: PW, confirm: 'close' })).statusCode).toBe(400);
  });
  it('closes the store, deletes photos and personal details, keeps financial records, and blocks sign-in', async () => {
    const s = await k.seller('gv21'); const other = await k.seller('gv22'); const op = await k.product(other.cookie);
    const p = await k.product(s.cookie, { variants: [{ priceCents: 1000, costCents: 300, stock: 5 }] });
    const img = await app.inject({ method: 'POST', url: `/api/seller/products/${p.id}/images`, headers: { 'content-type': 'image/png' }, cookies: { eazy_sid: s.cookie }, payload: PNG });
    const key = (await oq('SELECT storage_key FROM product_media WHERE product_id=$1', [p.id])).rows[0].storage_key as string;
    expect(existsSync(`${process.env.UPLOAD_DIR}/${key}`)).toBe(true); expect(img.statusCode).toBe(201);
    const done = await k.paidOrder(s, p.variantId, 1);
    for (const st of ['processing', 'shipped', 'completed']) await app.inject({ method: 'POST', url: `/api/seller/orders/${done.orderId}/status`, ...ck(s.cookie), payload: { status: st } });
    const pending = (await k.checkout(s.slug, p.variantId, 2)).json();                                    // an unpaid checkout holding 2 units
    expect((await oq('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [p.variantId])).rows[0].reserved).toBe(2);
    const ledgerBefore = (await oq('SELECT count(*)::int n FROM ledger_entries WHERE tenant_id=$1', [s.tenantId])).rows[0].n;
    expect((await close(s.cookie, { password: PW, confirm: 'CLOSE' })).json()).toEqual({ ok: true, closed: true });
    expect((await get(`/api/public/stores/${s.slug}`)).statusCode).toBe(404);
    expect((await get('/api/seller/business', s.cookie)).statusCode).toBe(401);                           // signed out
    expect((await post('/api/auth/login', { email: 'gv21@k.test', password: PW })).statusCode).toBe(401);
    const u = (await oq(`SELECT email, full_name, disabled_at FROM users WHERE id=(SELECT user_id FROM memberships WHERE tenant_id=$1 LIMIT 1)`, [s.tenantId])).rows[0];
    expect(u.email).toMatch(/^closed-.+@invalid\.example$/); expect(u.full_name).toBe('Closed account'); expect(u.disabled_at).toBeTruthy();
    expect((await oq('SELECT contact_email, description, tax_number FROM businesses WHERE tenant_id=$1', [s.tenantId])).rows[0]).toEqual({ contact_email: null, description: null, tax_number: null });
    expect(existsSync(`${process.env.UPLOAD_DIR}/${key}`)).toBe(false);
    expect((await oq('SELECT count(*)::int n FROM product_media WHERE tenant_id=$1', [s.tenantId])).rows[0].n).toBe(0);
    expect((await oq('SELECT count(*)::int n FROM ledger_entries WHERE tenant_id=$1', [s.tenantId])).rows[0].n).toBe(ledgerBefore);   // records kept
    expect((await oq('SELECT status FROM orders WHERE public_token=$1', [pending.orderToken])).rows[0].status).toBe('cancelled');
    expect((await oq('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [p.variantId])).rows[0].reserved).toBe(0);
    expect((await oq(`SELECT status FROM products WHERE id=$1`, [p.id])).rows[0].status).toBe('archived');
    expect((await outbox('gv21@k.test', 'account_closed'))).toHaveLength(1);                                // sent before the address was anonymised
    expect((await get(`/api/public/stores/${other.slug}/products/${op.id}`)).statusCode).toBe(200);        // other sellers untouched
  });
});

describe('customer privacy erasure', () => {
  const erase = (cookie: string, body: object) => post('/api/admin/privacy/erase-customer', body, cookie);
  async function customerOrders(n: string, email: string) {
    const s = await k.seller(n);
    const p = await k.product(s.cookie, { name: 'Plate', customFields: [{ label: 'Name', type: 'text' }, { label: 'Photo', type: 'image' }], variants: [{ priceCents: 2000, costCents: 500, stock: 9 }] });
    const up = (await app.inject({ method: 'POST', url: `/api/public/stores/${s.slug}/custom-upload`, headers: { 'content-type': 'image/png' }, payload: PNG })).json().id;
    const c = (await app.inject({ method: 'POST', url: `/api/public/stores/${s.slug}/checkout`, payload: { items: [{ variantId: p.variantId, quantity: 1, customizations: { name: 'Maya Private', photo: up } }], email, name: 'Maya Private', fulfilment: 'pickup' } })).json();
    await k.pay(c.paymentId);
    const id = (await app.inject({ method: 'GET', url: '/api/seller/orders', ...ck(s.cookie) })).json()[0].id as string;
    return { s, p, id, up, token: c.orderToken as string, total: c.totalCents as number };
  }
  const finish = async (s: { cookie: string }, id: string) => { for (const st of ['processing', 'shipped', 'completed']) await app.inject({ method: 'POST', url: `/api/seller/orders/${id}/status`, ...ck(s.cookie), payload: { status: st } }); };

  it('needs privacy.write and a reason, is refused while orders are open, and 404s for unknown emails', async () => {
    const adm = await staff('gv23', 'super_admin'); const mod = await staff('gv24', 'moderator'); const o = await customerOrders('gv25', 'erase-open@x.test');
    expect((await erase(mod, { email: 'erase-open@x.test', reason: 'Customer request under PIPEDA' })).statusCode).toBe(403);
    expect((await erase(adm, { email: 'erase-open@x.test' })).statusCode).toBe(400);
    expect((await erase(adm, { email: 'erase-open@x.test', reason: 'Customer request under PIPEDA' })).json().error).toBe('open_orders:1');
    expect((await erase(adm, { email: 'nobody-at-all@x.test', reason: 'Customer request under PIPEDA' })).statusCode).toBe(404);
    expect((await oq('SELECT customer_email FROM orders WHERE id=$1', [o.id])).rows[0].customer_email).toBe('erase-open@x.test');
  });
  it('replaces personal details on orders, deletes uploaded photos, redacts email history, keeps amounts and the ledger, and logs a hash not the address', async () => {
    const adm = await staff('gv26', 'super_admin'); const email = 'Maya.Erase@Example.test'; const o = await customerOrders('gv27', email); await finish(o.s, o.id);
    const key = (await oq('SELECT storage_key FROM custom_uploads WHERE id=$1', [o.up])).rows[0].storage_key as string; expect(existsSync(`${process.env.UPLOAD_DIR}/${key}`)).toBe(true);
    const ledgerSum = async () => (await oq('SELECT count(*)::int n, coalesce(sum(amount_cents),0)::int s FROM ledger_entries WHERE order_id=$1', [o.id])).rows[0];
    const before = await ledgerSum();
    const r = await erase(adm, { email: 'maya.erase@example.test', reason: 'Customer request under PIPEDA' });      // different case on purpose
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ orders: 1, uploads: 1 });
    const row = (await oq('SELECT customer_name, customer_email, delivery_address, anonymised_at, total_cents FROM orders WHERE id=$1', [o.id])).rows[0];
    expect(row).toMatchObject({ customer_name: 'Erased customer', delivery_address: null, total_cents: o.total }); expect(row.customer_email).toMatch(/^erased-.+@invalid\.example$/); expect(row.anonymised_at).toBeTruthy();
    const item = (await oq('SELECT custom_values FROM order_items WHERE order_id=$1', [o.id])).rows[0].custom_values;
    expect(item).toEqual([{ label: 'Name', type: 'text', value: '[erased]' }, { label: 'Photo', type: 'image', value: '[erased]' }]);
    expect(JSON.stringify(item)).not.toContain('Maya');
    expect(existsSync(`${process.env.UPLOAD_DIR}/${key}`)).toBe(false); expect((await oq('SELECT count(*)::int n FROM custom_uploads WHERE id=$1', [o.up])).rows[0].n).toBe(0);
    expect((await oq(`SELECT count(*)::int n FROM email_outbox WHERE lower(to_email)=lower($1)`, [email])).rows[0].n).toBe(0);
    expect(JSON.stringify((await oq(`SELECT subject, text_body FROM email_outbox WHERE template='order_confirmation' AND tenant_id=$1`, [o.s.tenantId])).rows)).not.toContain('Maya');
    expect(await ledgerSum()).toEqual(before);
    const log = (await oq(`SELECT * FROM audit_logs WHERE action='privacy.erase_customer' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log.entity_id).toMatch(/^[0-9a-f]{16}$/); expect(JSON.stringify(log)).not.toMatch(/maya/i);
    expect((await erase(adm, { email, reason: 'Running the erasure a second time' })).statusCode).toBe(404);     // nothing left to erase
    expect(readdirSync(process.env.UPLOAD_DIR!).includes(key)).toBe(false);
  });
});
