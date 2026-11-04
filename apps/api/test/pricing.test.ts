import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const post = (url: string, payload: object, cookie?: string) => app.inject({ method: 'POST', url, payload, ...(cookie ? ck(cookie) : {}) });
const put = (url: string, payload: object, cookie: string) => app.inject({ method: 'PUT', url, payload, ...ck(cookie) });
const patch = (url: string, payload: object, cookie: string) => app.inject({ method: 'PATCH', url, payload, ...ck(cookie) });
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, ...(cookie ? ck(cookie) : {}) });
const addr = (region = 'AB') => ({ fulfilment: 'delivery', address: { line1: '1 Main', city: 'X', region, postalCode: 'T2T2T2', country: 'CA' } });
async function shop(n: string, o: { price?: number; weight?: number; region?: string; federal?: boolean } = {}) {
  const s = await k.seller(n);
  if (o.region || o.federal) await patch('/api/seller/business', { region: o.region, taxFederal: !!o.federal }, s.cookie);
  const p = await k.product(s.cookie, { variants: [{ priceCents: o.price ?? 2000, costCents: 500, stock: 200, weightGrams: o.weight }] });
  return { s, p };
}
const disc = (cookie: string, body: object) => post('/api/seller/discounts', body, cookie);
const buyWith = (slug: string, variantId: string, code: string | undefined, qty = 1, extra: object = {}) =>
  app.inject({ method: 'POST', url: `/api/public/stores/${slug}/checkout`, payload: { items: [{ variantId, quantity: qty }], email: 'b@x.test', name: 'B', fulfilment: 'pickup', ...(code ? { discountCode: code } : {}), ...extra } });
const quote = (slug: string, variantId: string, body: object = {}, qty = 1) => post(`/api/public/stores/${slug}/quote`, { items: [{ variantId, quantity: qty }], fulfilment: 'pickup', ...body });

describe('discount codes: the amounts', () => {
  it('percent off the subtotal, tax on the discounted amount, platform fee only on money actually paid for goods', async () => {
    const { s, p } = await shop('pr1', { region: 'AB', federal: true });                    // 2 x $20 = $40
    expect((await disc(s.cookie, { code: 'SAVE10', kind: 'percent', value: 10 })).statusCode).toBe(201);
    const c = (await buyWith(s.slug, p.variantId, 'save10', 2)).json();                      // lower-case on purpose
    expect(c).toMatchObject({ discountCents: 400, discountCode: 'SAVE10', taxCents: 180, totalCents: 3780 });     // (4000-400) * 5% = 180
    await k.pay(c.paymentId);
    const orderId = (await oq('SELECT id FROM orders WHERE public_token=$1', [c.orderToken])).rows[0].id;
    const led = (await oq('SELECT account, amount_cents::int a FROM ledger_entries WHERE order_id=$1', [orderId])).rows; const by = (a: string) => led.filter(r => r.account === a).reduce((n, r) => n + r.a, 0);
    expect({ cash: by('cash_received'), fee: by('platform_fee'), tax: by('tax_payable'), payable: by('seller_payable') }).toEqual({ cash: 3780, fee: -108, tax: -180, payable: -3492 });   // fee = 3% of $36.00
    expect(led.reduce((n, r) => n + r.a, 0)).toBe(0);
  });
  it('fixed amounts never exceed the subtotal; free shipping waives a real delivery fee and refuses pickup', async () => {
    const { s, p } = await shop('pr2', { price: 800 });
    await disc(s.cookie, { code: 'BIG20', kind: 'fixed', value: 2000 }); await disc(s.cookie, { code: 'SHIPFREE', kind: 'free_shipping' });
    expect((await buyWith(s.slug, p.variantId, 'BIG20')).json()).toMatchObject({ discountCents: 800, totalCents: 0 });                 // capped at the $8.00 subtotal
    const sf = (await buyWith(s.slug, p.variantId, 'SHIPFREE', 1, addr())).json(); expect(sf).toMatchObject({ shippingCents: 0, discountCents: 0, totalCents: 800 });
    const pickup = await buyWith(s.slug, p.variantId, 'SHIPFREE'); expect(pickup.statusCode).toBe(422); expect(pickup.json().error).toBe('discount_invalid:not_applicable');
  });
  it('rejects unknown, paused, not-yet-started, expired and below-minimum codes with a reason', async () => {
    const { s, p } = await shop('pr3');
    const day = 86_400_000; const iso = (d: number) => new Date(Date.now() + d).toISOString();
    await disc(s.cookie, { code: 'PAUSED', kind: 'percent', value: 5 }); const id = (await get('/api/seller/discounts', s.cookie)).json()[0].id; await patch(`/api/seller/discounts/${id}`, { active: false }, s.cookie);
    await disc(s.cookie, { code: 'LATER', kind: 'percent', value: 5, startsAt: iso(day) }); await disc(s.cookie, { code: 'OLD', kind: 'percent', value: 5, startsAt: iso(-3 * day), endsAt: iso(-day) });
    await disc(s.cookie, { code: 'BIGSPEND', kind: 'percent', value: 5, minSubtotalCents: 10000 });
    const why = async (code: string) => (await buyWith(s.slug, p.variantId, code)).json().error;
    expect(await why('NOPE')).toBe('discount_invalid:not_found'); expect(await why('PAUSED')).toBe('discount_invalid:inactive'); expect(await why('LATER')).toBe('discount_invalid:not_started');
    expect(await why('OLD')).toBe('discount_invalid:expired'); expect(await why('BIGSPEND')).toBe('discount_invalid:min_subtotal:10000');
    expect((await oq('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [s.tenantId])).rows[0].n).toBe(0);   // failed attempts leave nothing behind
  });
});

describe('discount codes: limits', () => {
  it('total uses: the limit holds, and a cancelled order gives the use back', async () => {
    const { s, p } = await shop('pr4'); await disc(s.cookie, { code: 'ONCE', kind: 'percent', value: 10, maxUses: 1 });
    const first = await buyWith(s.slug, p.variantId, 'ONCE'); expect(first.statusCode).toBe(201);
    expect((await buyWith(s.slug, p.variantId, 'ONCE')).json().error).toBe('discount_invalid:used_up');
    await k.pay(first.json().paymentId, 'failed');                                          // payment fails: order cancelled
    expect((await buyWith(s.slug, p.variantId, 'ONCE')).statusCode).toBe(201);
  });
  it('uses per email: the same address is stopped (any capitalisation), another is not', async () => {
    const { s, p } = await shop('pr5'); await disc(s.cookie, { code: 'WELCOME', kind: 'fixed', value: 300, maxUsesPerEmail: 1 });
    expect((await buyWith(s.slug, p.variantId, 'WELCOME', 1, { email: 'Ann@x.test' })).statusCode).toBe(201);
    expect((await buyWith(s.slug, p.variantId, 'WELCOME', 1, { email: 'ann@X.TEST' })).json().error).toBe('discount_invalid:used_by_you');
    expect((await buyWith(s.slug, p.variantId, 'WELCOME', 1, { email: 'bob@x.test' })).statusCode).toBe(201);
  });
  it('five simultaneous checkouts for a one-use code: exactly one wins', async () => {
    const { s, p } = await shop('pr6'); await disc(s.cookie, { code: 'RACE', kind: 'percent', value: 50, maxUses: 1 });
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => buyWith(s.slug, p.variantId, 'RACE', 1, { email: `r${i}@x.test` })));
    expect(rs.map(r => r.statusCode).sort()).toEqual([201, 422, 422, 422, 422]);
    expect((await oq(`SELECT count(*)::int n FROM discount_redemptions r JOIN discounts d ON d.id=r.discount_id WHERE d.code='RACE'`)).rows[0].n).toBe(1);
  });
  it('a quote shows exactly what checkout charges and uses up nothing', async () => {
    const { s, p } = await shop('pr7', { region: 'AB', federal: true }); await disc(s.cookie, { code: 'ONLYONE', kind: 'percent', value: 25, maxUses: 1 });
    const q = (await quote(s.slug, p.variantId, { discountCode: 'ONLYONE' }, 2)).json(); const q2 = (await quote(s.slug, p.variantId, { discountCode: 'ONLYONE' }, 2)).json();
    expect(q2).toEqual(q);                                                                  // asking twice consumes nothing
    const c = (await buyWith(s.slug, p.variantId, 'ONLYONE', 2)).json();
    expect(q).toMatchObject({ subtotalCents: 4000, discountCents: c.discountCents, taxCents: c.taxCents, totalCents: c.totalCents });
    expect((await quote(s.slug, p.variantId, { discountCode: 'ONLYONE' })).json().error).toBe('discount_invalid:used_up');
  });
  it('the shopper cannot supply a price or a discount amount', async () => {
    const { s, p } = await shop('pr8');
    expect((await buyWith(s.slug, p.variantId, undefined, 1, { discountCents: 9999 })).statusCode).toBe(400);
    expect((await post(`/api/public/stores/${s.slug}/quote`, { items: [{ variantId: p.variantId, quantity: 1, priceCents: 1 }], fulfilment: 'pickup' })).statusCode).toBe(400);
  });
});

describe('discounts, refunds and reports', () => {
  it('refunds of a discounted order balance the ledger exactly; the dashboard reports the discount and lowers profit by it', async () => {
    const { s, p } = await shop('pr9', { price: 3333, region: 'AB', federal: true }); await disc(s.cookie, { code: 'TENOFF', kind: 'percent', value: 10 });
    const c = (await buyWith(s.slug, p.variantId, 'TENOFF')).json(); await k.pay(c.paymentId);
    const id = (await get('/api/seller/orders', s.cookie)).json()[0].id; const total = c.totalCents;
    const parts = [Math.floor(total / 3), Math.floor(total / 3)]; parts.push(total - parts[0] - parts[1]);
    const d0 = (await get('/api/seller/dashboard', s.cookie)).json();
    expect(d0).toMatchObject({ grossSalesCents: 3333, discountsCents: 333, cogsCents: 500, grossProfitCents: 3333 - 500 - 333 });
    for (const amt of parts) expect((await post(`/api/seller/orders/${id}/refunds`, { amountCents: amt, reason: 'Refund in three parts' }, s.cookie)).statusCode).toBe(201);
    const led = (await oq('SELECT account, amount_cents::int a FROM ledger_entries WHERE order_id=$1', [id])).rows;
    for (const a of ['cash_received', 'platform_fee', 'tax_payable', 'seller_payable']) expect(led.filter(r => r.account === a).reduce((n, r) => n + r.a, 0)).toBe(0);
  });
  it('the customer email shows the discount line', async () => {
    const { s, p } = await shop('pr10'); await disc(s.cookie, { code: 'MAILME', kind: 'fixed', value: 500 });
    const c = (await buyWith(s.slug, p.variantId, 'MAILME', 1, { email: 'discount-mail@x.test' })).json(); await k.pay(c.paymentId);
    const m = (await oq(`SELECT text_body FROM email_outbox WHERE to_email='discount-mail@x.test' AND template='order_confirmation'`)).rows[0];
    expect(m.text_body).toContain('Discount -$5.00');
  });
});

describe('managing discount codes', () => {
  it('validates the deal, rejects duplicates, and only allows pausing, extending or capping afterwards', async () => {
    const { s } = await shop('pr11'); const bad = (b: object) => disc(s.cookie, b);
    expect((await bad({ code: 'X', kind: 'percent', value: 10 })).statusCode).toBe(400);                         // too short
    expect((await bad({ code: 'ZERO', kind: 'percent', value: 0 })).statusCode).toBe(400); expect((await bad({ code: 'OVER', kind: 'percent', value: 101 })).statusCode).toBe(400);
    expect((await bad({ code: 'FIXZERO', kind: 'fixed', value: 0 })).statusCode).toBe(400); expect((await bad({ code: 'FSVAL', kind: 'free_shipping', value: 5 })).statusCode).toBe(400);
    expect((await bad({ code: 'BACKWARDS', kind: 'percent', value: 5, startsAt: '2030-02-01T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' })).statusCode).toBe(400);
    expect((await bad({ code: 'bad code!', kind: 'percent', value: 5 })).statusCode).toBe(400);
    expect((await bad({ code: 'dup1', kind: 'percent', value: 5 })).statusCode).toBe(201); expect((await bad({ code: 'DUP1', kind: 'percent', value: 9 })).json().error).toBe('code_exists');
    const id = (await get('/api/seller/discounts', s.cookie)).json()[0].id;
    expect((await patch(`/api/seller/discounts/${id}`, { value: 99 }, s.cookie)).statusCode).toBe(400);           // the deal itself is fixed
    expect((await patch(`/api/seller/discounts/${id}`, { active: false, maxUses: 5 }, s.cookie)).statusCode).toBe(200);
    expect((await get('/api/seller/discounts', s.cookie)).json()[0]).toMatchObject({ code: 'DUP1', active: false, maxUses: 5 });
  });
  it('is private to the seller, and staff-role members cannot create codes', async () => {
    const a = await shop('pr12'); const b = await shop('pr13'); await disc(a.s.cookie, { code: 'MINE', kind: 'percent', value: 10 });
    const id = (await get('/api/seller/discounts', a.s.cookie)).json()[0].id;
    expect((await get('/api/seller/discounts', b.s.cookie)).json()).toEqual([]);
    expect((await patch(`/api/seller/discounts/${id}`, { active: false }, b.s.cookie)).statusCode).toBe(404);
    expect((await buyWith(b.s.slug, b.p.variantId, 'MINE')).json().error).toBe('discount_invalid:not_found');     // codes do not work in another store
    await oq(`UPDATE memberships SET role='staff' WHERE tenant_id=$1`, [b.s.tenantId]);
    expect((await disc(b.s.cookie, { code: 'STAFFTRY', kind: 'percent', value: 10 })).statusCode).toBe(403);
  });
  it('reports redemptions and the amount given away', async () => {
    const { s, p } = await shop('pr14'); await disc(s.cookie, { code: 'COUNTME', kind: 'fixed', value: 200 });
    for (let i = 0; i < 3; i++) await buyWith(s.slug, p.variantId, 'COUNTME', 1, { email: `c${i}@x.test` });
    expect((await get('/api/seller/discounts', s.cookie)).json()[0]).toMatchObject({ redemptions: 3, discountGivenCents: 600 });
  });
});

describe('shipping rules', () => {
  const rules = (cookie: string, list: object[]) => put('/api/seller/shipping-rules', { rules: list }, cookie);
  it('first matching rule wins by province, weight and order value; a missing match is refused, never free', async () => {
    const { s, p } = await shop('shr1', { price: 2000, weight: 400 });
    expect((await rules(s.cookie, [
      { name: 'Free over $50 in Alberta', regions: ['AB'], minSubtotalCents: 5000, priceCents: 0 },
      { name: 'Alberta light', regions: ['AB'], maxWeightG: 1000, priceCents: 600 },
      { name: 'Alberta heavy', regions: ['AB'], minWeightG: 1001, priceCents: 1500 },
      { name: 'Rest of Canada', regions: [], priceCents: 1800 },
    ])).json()).toEqual({ saved: 4 });
    const q = async (qty: number, region: string) => (await quote(s.slug, p.variantId, { fulfilment: 'delivery', region }, qty)).json();
    expect(await q(1, 'AB')).toMatchObject({ shippingCents: 600, shippingRule: 'Alberta light' });                 // 400 g
    expect(await q(3, 'AB')).toMatchObject({ shippingCents: 0, shippingRule: 'Free over $50 in Alberta' });        // $60 subtotal
    expect(await q(2, 'AB')).toMatchObject({ shippingCents: 600 });                                                 // 800 g, $40
    expect(await q(2, 'ON')).toMatchObject({ shippingCents: 1800, shippingRule: 'Rest of Canada' });
    expect((await quote(s.slug, p.variantId, { fulfilment: 'pickup' })).json().shippingCents).toBe(0);              // pickup is never charged shipping
    const only = await rules(s.cookie, [{ name: 'Alberta only', regions: ['AB'], priceCents: 500 }]); expect(only.statusCode).toBe(200);
    const no = await quote(s.slug, p.variantId, { fulfilment: 'delivery', region: 'BC' }); expect(no.statusCode).toBe(422); expect(no.json().error).toBe('no_shipping_option');
  });
  it('heavy orders fall to the heavy rule, and checkout charges exactly what the quote showed', async () => {
    const { s, p } = await shop('shr2', { price: 1000, weight: 600 });
    await rules(s.cookie, [{ name: 'Light', maxWeightG: 1000, priceCents: 700 }, { name: 'Heavy', minWeightG: 1001, priceCents: 2100 }]);
    const q = (await quote(s.slug, p.variantId, { fulfilment: 'delivery', region: 'AB' }, 2)).json();                 // 1200 g
    expect(q).toMatchObject({ shippingCents: 2100, shippingRule: 'Heavy' });
    const c = (await buyWith(s.slug, p.variantId, undefined, 2, addr('AB'))).json(); expect(c).toMatchObject({ shippingCents: 2100, totalCents: q.totalCents });
    expect((await buyWith(s.slug, p.variantId, undefined, 2, addr('QC'))).json().shippingCents).toBe(2100);          // no regions listed = everywhere
  });
  it('without rules the store flat fee applies; invalid rules are rejected; rules are private and audited', async () => {
    const { s, p } = await shop('shr3'); const other = await shop('shr4');
    expect((await quote(s.slug, p.variantId, { fulfilment: 'delivery', region: 'AB' })).json().shippingCents).toBe(500);       // helper sets a $5 flat fee
    for (const bad of [[{ name: 'x', priceCents: 1, regions: ['ZZ'] }], [{ name: 'x', priceCents: 1, minWeightG: 500, maxWeightG: 100 }], [{ name: 'x', priceCents: 1, minSubtotalCents: 900, maxSubtotalCents: 100 }], [{ name: '', priceCents: 1 }], [{ name: 'x', priceCents: -1 }]])
      expect((await rules(s.cookie, bad)).statusCode, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    await rules(s.cookie, [{ name: 'Mine', priceCents: 111 }]);
    expect((await get('/api/seller/shipping-rules', other.s.cookie)).json()).toEqual([]);
    expect((await quote(other.s.slug, other.p.variantId, { fulfilment: 'delivery', region: 'AB' })).json().shippingCents).toBe(500);          // another store is unaffected
    expect((await get('/api/seller/shipping-rules', s.cookie)).json()).toHaveLength(1);
    expect((await oq(`SELECT count(*)::int n FROM audit_logs WHERE action='shipping_rules.replace' AND tenant_id=$1`, [s.tenantId])).rows[0].n).toBe(1);
    await oq(`UPDATE memberships SET role='staff' WHERE tenant_id=$1`, [s.tenantId]); expect((await rules(s.cookie, [{ name: 'T', priceCents: 1 }])).statusCode).toBe(403);
  });
  it('free-shipping codes also waive a rule-based fee, and rules apply before tax', async () => {
    const { s, p } = await shop('shr5', { region: 'AB', federal: true, price: 4000 });
    await rules(s.cookie, [{ name: 'Flat', priceCents: 1000 }]); await disc(s.cookie, { code: 'FREESHIP', kind: 'free_shipping' });
    expect((await quote(s.slug, p.variantId, { fulfilment: 'delivery', region: 'AB' })).json()).toMatchObject({ shippingCents: 1000, taxCents: 250, totalCents: 5250 });   // (4000+1000) * 5%
    expect((await quote(s.slug, p.variantId, { fulfilment: 'delivery', region: 'AB', discountCode: 'FREESHIP' })).json()).toMatchObject({ shippingCents: 0, taxCents: 200, totalCents: 4200 });
  });
});

describe('weight and barcode on variants', () => {
  it('stores them, returns them to the seller, and refuses a duplicate barcode within a store only', async () => {
    const a = await k.seller('wb1'); const b = await k.seller('wb2');
    const mk = (cookie: string, barcode: string) => post('/api/seller/products', { name: 'Thing', variants: [{ priceCents: 100, weightGrams: 250, barcode }] }, cookie);
    expect((await mk(a.cookie, '0123456789012')).statusCode).toBe(201);
    const dup = await mk(a.cookie, '0123456789012'); expect(dup.statusCode).toBe(409); expect(dup.json().error).toBe('duplicate_barcode');
    expect((await mk(b.cookie, '0123456789012')).statusCode).toBe(201);
    expect((await get('/api/seller/products', a.cookie)).json()[0].variants[0]).toMatchObject({ barcode: '0123456789012', weightGrams: 250 });
    expect((await post('/api/seller/products', { name: 'Neg', variants: [{ priceCents: 100, weightGrams: -5 }] }, a.cookie)).statusCode).toBe(400);
  });
});
