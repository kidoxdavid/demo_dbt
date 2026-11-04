import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { taxCents, applyTax } from '../src/lib/tax.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

async function taxSeller(n: string, cfg: { region?: string; federal?: boolean; provincial?: string[]; price?: number }) {
  const s = await k.seller(n);
  if (cfg.region || cfg.federal || cfg.provincial) {
    const r = await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(s.cookie), payload: { region: cfg.region, taxFederal: !!cfg.federal, taxProvincial: cfg.provincial ?? [], taxNumber: '123456789RT0001' } });
    expect(r.statusCode).toBe(200);
  }
  const p = await k.product(s.cookie, { variants: [{ priceCents: cfg.price ?? 2000, costCents: 500, stock: 50 }] });
  return { s, p };
}
const addr = (region: string) => ({ fulfilment: 'delivery', address: { line1: '1 Main', city: 'X', region, postalCode: 'T2T2T2', country: 'CA' } });
const orderRow = async (token: string) => (await oq('SELECT * FROM orders WHERE public_token=$1', [token])).rows[0];

describe('tax arithmetic', () => {
  it('rounds half up in integer maths', () => {
    expect(taxCents(10, 50000)).toBe(1);         // 0.5 cents rounds up
    expect(taxCents(1000, 99750)).toBe(100);     // 99.75 -> 100
    expect(taxCents(1999, 50000)).toBe(100);     // 99.95 -> 100
    expect(taxCents(1999, 99750)).toBe(199);     // 199.40 -> 199
    expect(taxCents(0, 130000)).toBe(0);
  });
  it('applies federal always when registered and provincial only where registered', () => {
    const bc = [{ name: 'GST', kind: 'federal' as const, ppm: 50000 }, { name: 'PST', kind: 'provincial' as const, ppm: 70000 }];
    expect(applyTax(10000, bc, { federal: true, provincialApplies: false }).map(l => [l.name, l.cents])).toEqual([['GST', 500]]);
    expect(applyTax(10000, bc, { federal: true, provincialApplies: true }).map(l => [l.name, l.cents])).toEqual([['GST', 500], ['PST', 700]]);
    expect(applyTax(10000, bc, { federal: false, provincialApplies: true }).map(l => [l.name, l.cents])).toEqual([['PST', 700]]);
    expect(applyTax(10000, bc, { federal: false, provincialApplies: false })).toEqual([]);
  });
});

describe('tax at checkout', () => {
  it('charges nothing when the seller is not registered (the default)', async () => {
    const { s, p } = await taxSeller('tx1', {});
    const c = (await k.checkout(s.slug, p.variantId, 1)).json();
    expect(c).toMatchObject({ taxCents: 0, totalCents: 2000 });
  });
  it('pickup uses the seller province: AB GST 5%; the order and payment carry the same total', async () => {
    const { s, p } = await taxSeller('tx2', { region: 'AB', federal: true });
    const c = (await k.checkout(s.slug, p.variantId, 2)).json();
    expect(c).toMatchObject({ taxCents: 200, totalCents: 4200, taxLines: [{ name: 'GST', ppm: 50000, cents: 200 }] });
    expect(await orderRow(c.orderToken)).toMatchObject({ subtotal_cents: 4000, shipping_cents: 0, tax_cents: 200, total_cents: 4200, tax_region: 'AB' });
    expect((await oq('SELECT amount_cents FROM payments WHERE id=$1', [c.paymentId])).rows[0].amount_cents).toBe(4200);
  });
  it('delivery uses the destination: AB seller to ON charges HST 13% on goods and delivery', async () => {
    const { s, p } = await taxSeller('tx3', { region: 'AB', federal: true });
    const c = (await k.checkout(s.slug, p.variantId, 1, addr('ON'))).json();   // (2000 + 500 delivery) * 13% = 325
    expect(c).toMatchObject({ taxCents: 325, totalCents: 2825, taxLines: [{ name: 'HST', cents: 325 }] });
  });
  it('provincial tax applies only where the seller is registered for it', async () => {
    const reg = await taxSeller('tx4', { region: 'AB', federal: true, provincial: ['BC'] });
    const notReg = await taxSeller('tx5', { region: 'AB', federal: true });
    const a = (await k.checkout(reg.s.slug, reg.p.variantId, 1, addr('BC'))).json();      // 2500 * (5% + 7%) = 125 + 175
    expect(a.taxLines.map((l: any) => [l.name, l.cents])).toEqual([['GST', 125], ['PST', 175]]); expect(a.taxCents).toBe(300);
    const b = (await k.checkout(notReg.s.slug, notReg.p.variantId, 1, addr('BC'))).json();
    expect(b.taxLines.map((l: any) => l.name)).toEqual(['GST']); expect(b.taxCents).toBe(125);
  });
  it('Quebec: GST 5% plus QST 9.975% with half-up rounding per component', async () => {
    const { s, p } = await taxSeller('tx6', { region: 'QC', federal: true, provincial: ['QC'], price: 1999 });
    const c = (await k.checkout(s.slug, p.variantId, 1)).json();
    expect(c.taxLines.map((l: any) => [l.name, l.cents])).toEqual([['GST', 100], ['QST', 199]]); expect(c.totalCents).toBe(1999 + 299);
  });
  it('rejects unknown destinations and impossible settings', async () => {
    const { s, p } = await taxSeller('tx7', { region: 'AB', federal: true });
    expect((await k.checkout(s.slug, p.variantId, 1, addr('ZZ'))).json().error).toBe('tax_region_unknown');
    const bare = await k.seller('tx8');
    const noProv = await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(bare.cookie), payload: { taxFederal: true } });
    expect(noProv.statusCode).toBe(422); expect(noProv.json().error).toBe('tax_needs_province');
    const bad = await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(bare.cookie), payload: { region: 'AB', taxProvincial: ['AB'] } });
    expect(bad.json().error).toBe('no_provincial_tax:AB');
    const lower = await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(bare.cookie), payload: { region: 'bc', taxFederal: true, taxProvincial: ['bc'] } });
    expect(lower.statusCode).toBe(200); expect(lower.json().tax_provincial).toEqual(['BC']);
  });
  it('the quote endpoint returns exactly what checkout will charge', async () => {
    const { s, p } = await taxSeller('tx9', { region: 'AB', federal: true, provincial: [] });
    const q = (await app.inject({ method: 'POST', url: `/api/public/stores/${s.slug}/quote`, payload: { items: [{ variantId: p.variantId, quantity: 3 }], fulfilment: 'delivery', region: 'NS' } })).json();
    const c = (await k.checkout(s.slug, p.variantId, 3, addr('NS'))).json();
    expect(q).toMatchObject({ subtotalCents: c.totalCents - c.taxCents - c.shippingCents, shippingCents: c.shippingCents, taxCents: c.taxCents, totalCents: c.totalCents });
    expect((await app.inject({ method: 'POST', url: `/api/public/stores/${s.slug}/quote`, payload: { items: [{ variantId: p.variantId, quantity: 1, price: 1 }], fulfilment: 'pickup' } })).statusCode).toBe(400);
  });
});

describe('tax in the ledger, refunds and reports', () => {
  it('records collected tax as a liability, keeps the ledger balanced, and excludes it from seller earnings', async () => {
    const { s, p } = await taxSeller('tx10', { region: 'ON', federal: true });
    const o = await k.paidOrder(s, p.variantId, 2);                       // subtotal 4000, HST 520, total 4520, fee 3% of 4000 = 120
    const led = (await oq('SELECT account, amount_cents::int a FROM ledger_entries WHERE order_id=$1', [o.orderId])).rows;
    const by = (a: string) => led.filter(r => r.account === a).reduce((n, r) => n + r.a, 0);
    expect({ cash: by('cash_received'), fee: by('platform_fee'), tax: by('tax_payable'), payable: by('seller_payable') }).toEqual({ cash: 4520, fee: -120, tax: -520, payable: -3880 });
    expect(led.reduce((n, r) => n + r.a, 0)).toBe(0);
    const d = (await app.inject({ method: 'GET', url: '/api/seller/dashboard', ...ck(s.cookie) })).json();
    expect(d).toMatchObject({ grossSalesCents: 4000, taxCollectedCents: 520, sellerEarningsBeforeProcessorFeesCents: 3880 });
  });
  it('refunds return tax pro rata and the final refund returns the exact remainder (no rounding residue)', async () => {
    const { s, p } = await taxSeller('tx11', { region: 'QC', federal: true, provincial: ['QC'], price: 3333 });
    const c = (await k.checkout(s.slug, p.variantId, 1)).json(); await k.pay(c.paymentId);
    const id = (await app.inject({ method: 'GET', url: '/api/seller/orders', ...ck(s.cookie) })).json()[0].id;
    const total = c.totalCents; const parts = [Math.floor(total / 3), Math.floor(total / 3)]; parts.push(total - parts[0] - parts[1]);
    for (const [i, amt] of parts.entries()) {
      const r = await app.inject({ method: 'POST', url: `/api/seller/orders/${id}/refunds`, ...ck(s.cookie), payload: { amountCents: amt, reason: `Part ${i + 1} of three` } });
      expect(r.statusCode).toBe(201);
    }
    const led = (await oq('SELECT account, amount_cents::int a FROM ledger_entries WHERE order_id=$1', [id])).rows;
    const by = (a: string) => led.filter(r => r.account === a).reduce((n, r) => n + r.a, 0);
    expect(by('tax_payable')).toBe(0); expect(by('platform_fee')).toBe(0); expect(by('cash_received')).toBe(0); expect(by('seller_payable')).toBe(0);
    expect(led.reduce((n, r) => n + r.a, 0)).toBe(0);
  });
});

describe('admin tax rates', () => {
  async function staff(n: string, role: string) {
    const s = await k.seller(n); const id = (await oq('SELECT id FROM users WHERE email=$1', [`${n}@k.test`])).rows[0].id;
    await oq('INSERT INTO platform_staff(user_id,role_key) VALUES ($1,$2)', [id, role]); return s.cookie;
  }
  it('needs tax.write and a reason, is audited, and affects new orders only', async () => {
    const fin = await staff('tx12', 'finance'); const mod = await staff('tx13', 'moderator');
    const { s, p } = await taxSeller('tx14', { region: 'AB', federal: true });
    const before = (await k.checkout(s.slug, p.variantId, 1)).json();                    // 5% of 2000 = 100
    const patch = (cookie: string, payload: object) => app.inject({ method: 'PATCH', url: '/api/admin/tax-rates/CA/AB', ...ck(cookie), payload });
    const next = { components: [{ name: 'GST', kind: 'federal', ppm: 60000 }] };
    expect((await patch(mod, { ...next, reason: 'Rate change effective now' })).statusCode).toBe(403);
    expect((await patch(fin, next)).statusCode).toBe(400);
    expect((await patch(fin, { ...next, reason: 'Rate change effective now' })).statusCode).toBe(200);
    const after = (await k.checkout(s.slug, p.variantId, 1)).json();                     // 6% of 2000 = 120
    expect(after.taxCents).toBe(120); expect((await orderRow(before.orderToken)).tax_cents).toBe(100);
    const log = (await oq(`SELECT * FROM audit_logs WHERE action='tax_rate.update' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log).toMatchObject({ entity_id: 'CA-AB', reason: 'Rate change effective now' }); expect(log.previous_value.components[0].ppm).toBe(50000); expect(log.new_value.components[0].ppm).toBe(60000);
    expect((await app.inject({ method: 'GET', url: '/api/admin/tax-rates', ...ck(mod) })).json().length).toBe(13);
    expect((await patch(fin, { components: [{ name: 'GST', kind: 'federal', ppm: 50000 }], reason: 'Restore the original rate' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/tax-rates/CA/ZZ', ...ck(fin), payload: { ...next, reason: 'Unknown region test' } })).statusCode).toBe(404);
  });
});
