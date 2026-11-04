import { expect } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

export const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
export async function oq(sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_admin','on',true)`); const r = await c.query(sql, params); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
export const ck = (cookie: string) => ({ cookies: { eazy_sid: cookie } });

export function kit(getApp: () => FastifyInstance) {
  const app = () => getApp();
  async function seller(n: string, opts: { category?: string } = {}) {
    const r = await app().inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `${n}@k.test`, password: 'correct-horse-battery', fullName: n, businessName: `${n} Biz`, storeSlug: `${n}-shop` } });
    if (!r.cookies.find(c => c.name === 'eazy_sid')) throw new Error('signup failed: ' + r.statusCode + ' ' + r.body);
    const cookie = r.cookies.find(c => c.name === 'eazy_sid')!.value;
    await app().inject({ method: 'PATCH', url: '/api/seller/business', ...ck(cookie), payload: { category: opts.category ?? 'gifts', description: 'x', fulfilment: { pickup: true, delivery: true, shipping: false } } });
    await app().inject({ method: 'POST', url: '/api/seller/store/publish', ...ck(cookie) });
    await oq(`UPDATE stores SET delivery_fee_cents=500 WHERE slug=$1`, [`${n}-shop`]);
    return { cookie, slug: `${n}-shop`, tenantId: r.json().tenantId as string };
  }
  async function product(cookie: string, over: Record<string, unknown> = {}) {
    const r = await app().inject({ method: 'POST', url: '/api/seller/products', ...ck(cookie), payload: { name: 'Stand', status: 'active', variants: [{ title: 'Black', priceCents: 2000, costCents: 800, stock: 5 }], ...over } });
    expect(r.statusCode).toBe(201);
    const list = (await app().inject({ method: 'GET', url: '/api/seller/products', ...ck(cookie) })).json();
    const p = list.find((x: any) => x.id === r.json().id);
    return { id: r.json().id as string, variantId: p.variants[0].id as string };
  }
  const checkout = (slug: string, variantId: string, quantity = 1, extra: object = {}) => app().inject({ method: 'POST', url: `/api/public/stores/${slug}/checkout`,
    payload: { items: [{ variantId, quantity }], email: 'buyer@x.test', name: 'Buyer', fulfilment: 'pickup', ...extra } });
  const pay = (paymentId: string, outcome = 'succeeded') => app().inject({ method: 'POST', url: `/api/public/payments/${paymentId}/simulate`, payload: { outcome } });
  /** A paid order: returns ids needed by tests. */
  async function paidOrder(s: { cookie: string; slug: string }, variantId: string, qty = 2, extra: object = {}) {
    const c = (await checkout(s.slug, variantId, qty, extra)).json();
    await pay(c.paymentId);
    const list = (await app().inject({ method: 'GET', url: '/api/seller/orders', ...ck(s.cookie) })).json();
    const o = list.find((x: any) => Number(x.number) === c.orderNumber);
    return { orderId: o.id as string, token: c.orderToken as string, paymentId: c.paymentId as string, total: c.totalCents as number };
  }
  const stock = async (variantId: string) => (await oq('SELECT on_hand, reserved FROM inventory_levels WHERE variant_id=$1', [variantId])).rows[0];
  return { seller, product, checkout, pay, paidOrder, stock };
}

/** A real, decodable PNG. Uploads are decoded and re-encoded, so fake image bytes are (rightly) rejected. */
export const realPng = (w = 64, h = 48, bg = '#c8a05a') => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();
