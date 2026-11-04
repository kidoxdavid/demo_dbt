import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readdirSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { cleanupOrphanUploads } from '../src/modules/commerce.js';
import sharp from 'sharp';
import { owner, oq, ck, kit, realPng } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const PNG = await realPng(64, 48);
const FIELDS = [
  { label: 'Name on plate', type: 'text', required: true, maxLength: 12 },
  { label: 'Notes', type: 'textarea' },
  { label: 'Colour', type: 'select', required: true, options: ['Black', 'White'] },
  { label: 'Reference photo', type: 'image' },
];
const upload = (slug: string, body: Buffer = PNG, type = 'image/png') => app.inject({ method: 'POST', url: `/api/public/stores/${slug}/custom-upload`, headers: { 'content-type': type }, payload: body });
const buy = (slug: string, variantId: string, customizations?: Record<string, string>, quantity = 1) => app.inject({
  method: 'POST', url: `/api/public/stores/${slug}/checkout`, payload: { items: [{ variantId, quantity, ...(customizations && { customizations }) }], email: 'b@x.test', name: 'B', fulfilment: 'pickup' } });
const okAnswers = { name_on_plate: 'MAYA', colour: 'Black' };

async function customProduct(n: string) {
  const s = await k.seller(n);
  const p = await k.product(s.cookie, { name: 'Name Plate', madeToOrder: false, customFields: FIELDS, variants: [{ title: 'Std', priceCents: 2800, costCents: 700, stock: 10 }] });
  return { s, p };
}

describe('custom field definitions', () => {
  it('derives stable keys, exposes fields publicly, and validates the definition', async () => {
    const { s, p } = await customProduct('cu1');
    const pub = (await app.inject({ method: 'GET', url: `/api/public/stores/${s.slug}/products/${p.id}` })).json();
    expect(pub.customFields.map((f: any) => f.key)).toEqual(['name_on_plate', 'notes', 'colour', 'reference_photo']);
    expect(pub.customFields[2]).toMatchObject({ type: 'select', required: true, options: ['Black', 'White'] });
    const bad = (customFields: unknown) => app.inject({ method: 'POST', url: '/api/seller/products', ...ck(s.cookie), payload: { name: 'X', variants: [{ priceCents: 1 }], customFields } });
    expect((await bad([{ label: 'Pick', type: 'select', options: ['Only one'] }])).statusCode).toBe(400);
    expect((await bad([{ label: 'A', type: 'text' }, { label: 'a', type: 'text' }])).statusCode).toBe(400);
    expect((await bad(Array.from({ length: 11 }, (_, i) => ({ label: `F${i}`, type: 'text' })))).statusCode).toBe(400);
    expect((await bad([{ label: 'A', type: 'file' }])).statusCode).toBe(400);
    expect((await bad([{ label: '!!!', type: 'text' }])).statusCode).toBe(201); // key falls back to field_1
  });
});

describe('checkout validation', () => {
  it('enforces required, length, choices and unknown fields on the server, without leaving stock reserved', async () => {
    const { s, p } = await customProduct('cu2');
    const expectErr = async (c: Record<string, string> | undefined, code: string) => { const r = await buy(s.slug, p.variantId, c); expect(r.statusCode).toBe(422); expect(r.json().error).toBe(code); };
    await expectErr(undefined, 'custom_required:Name on plate');
    await expectErr({ name_on_plate: 'MAYA' }, 'custom_required:Colour');
    await expectErr({ ...okAnswers, name_on_plate: 'WAY TOO LONG NAME' }, 'custom_too_long:Name on plate');
    await expectErr({ ...okAnswers, colour: 'Purple' }, 'custom_invalid_choice:Colour');
    await expectErr({ ...okAnswers, hacker: 'x' }, 'custom_unknown_field');
    await expectErr({ ...okAnswers, reference_photo: 'not-a-real-upload' }, 'custom_invalid_upload:Reference photo');
    expect(await k.stock(p.variantId)).toEqual({ on_hand: 10, reserved: 0 });
  });
  it('stores a snapshot on the order item that later product edits cannot change; seller sees it', async () => {
    const { s, p } = await customProduct('cu3');
    const r = await buy(s.slug, p.variantId, { ...okAnswers, notes: 'Gift wrap please' }); expect(r.statusCode).toBe(201);
    await app.inject({ method: 'PATCH', url: `/api/seller/products/${p.id}`, ...ck(s.cookie), payload: { customFields: [{ label: 'Totally different', type: 'text' }] } });
    const id = (await app.inject({ method: 'GET', url: '/api/seller/orders', ...ck(s.cookie) })).json()[0].id;
    const o = (await app.inject({ method: 'GET', url: `/api/seller/orders/${id}`, ...ck(s.cookie) })).json();
    expect(o.items[0].custom_values).toEqual([{ label: 'Name on plate', type: 'text', value: 'MAYA' }, { label: 'Notes', type: 'textarea', value: 'Gift wrap please' }, { label: 'Colour', type: 'select', value: 'Black' }]);
    expect((await buy(s.slug, p.variantId, okAnswers)).json().error).toBe('custom_unknown_field'); // old keys are now unknown
  });
  it('keeps lines with different customisation separate while reserving stock in total', async () => {
    const { s, p } = await customProduct('cu4');
    const r = await app.inject({ method: 'POST', url: `/api/public/stores/${s.slug}/checkout`, payload: { email: 'b@x.test', name: 'B', fulfilment: 'pickup', items: [
      { variantId: p.variantId, quantity: 1, customizations: { name_on_plate: 'ANA', colour: 'Black' } }, { variantId: p.variantId, quantity: 2, customizations: { name_on_plate: 'BEN', colour: 'White' } },
      { variantId: p.variantId, quantity: 1, customizations: { name_on_plate: 'ANA', colour: 'Black' } }] } });
    expect(r.statusCode).toBe(201); expect(r.json().totalCents).toBe(4 * 2800);
    expect((await oq(`SELECT quantity FROM order_items WHERE order_id=(SELECT id FROM orders WHERE public_token=$1) ORDER BY quantity`, [r.json().orderToken])).rows.map(x => x.quantity)).toEqual([2, 2]);
    expect(await k.stock(p.variantId)).toEqual({ on_hand: 10, reserved: 4 });
  });
});

describe('customer image uploads', () => {
  it('accepts valid images, rejects spoofed/oversized ones, keeps them private, and attaches them to the order', async () => {
    const { s, p } = await customProduct('cu5');
    expect((await upload(s.slug, Buffer.from('<script>alert(1)</script>'.padEnd(40)))).statusCode).toBe(415);
    expect((await upload(s.slug, Buffer.alloc(6 * 1024 * 1024, 1))).statusCode).toBe(413);
    expect((await upload('nope-nope-nope')).statusCode).toBe(404);
    const up = await upload(s.slug); expect(up.statusCode).toBe(201);
    const r = await buy(s.slug, p.variantId, { ...okAnswers, reference_photo: up.json().id }); expect(r.statusCode).toBe(201);
    const orderId = (await app.inject({ method: 'GET', url: '/api/seller/orders', ...ck(s.cookie) })).json()[0].id;
    const item = (await app.inject({ method: 'GET', url: `/api/seller/orders/${orderId}`, ...ck(s.cookie) })).json().items[0];
    const photo = item.custom_values.find((v: any) => v.type === 'image');
    expect(photo.value).toBe(up.json().id);
    const img = await app.inject({ method: 'GET', url: `/api/seller/custom-uploads/${photo.value}`, ...ck(s.cookie) });
    expect(img.statusCode).toBe(200); expect(img.headers['content-type']).toBe('image/webp'); expect(img.headers['cache-control']).toContain('private'); expect((await sharp(img.rawPayload).metadata()).format).toBe('webp');
    expect((await app.inject({ method: 'GET', url: `/api/seller/custom-uploads/${photo.value}` })).statusCode).toBe(401);
    const other = await k.seller('cu5b');
    expect((await app.inject({ method: 'GET', url: `/api/seller/custom-uploads/${photo.value}`, ...ck(other.cookie) })).statusCode).toBe(404);
    const key = (await oq('SELECT storage_key FROM custom_uploads WHERE id=$1', [photo.value])).rows[0].storage_key;
    expect((await app.inject({ method: 'GET', url: `/media/${key}` })).statusCode).toBe(404); // never served by the public media route
  });
  it("an upload can be used once, only in its own store; concurrent use of one image has a single winner", async () => {
    const a = await customProduct('cu6'); const b = await customProduct('cu6b');
    const up = (await upload(a.s.slug)).json().id;
    expect((await buy(b.s.slug, b.p.variantId, { ...okAnswers, reference_photo: up })).statusCode).toBe(422); // other store's upload
    const rs = await Promise.all([1, 2, 3].map(() => buy(a.s.slug, a.p.variantId, { ...okAnswers, reference_photo: up })));
    expect(rs.map(r => r.statusCode).sort()).toEqual([201, 422, 422]);
    expect((await buy(a.s.slug, a.p.variantId, { ...okAnswers, reference_photo: up })).statusCode).toBe(422); // already attached
    expect(await k.stock(a.p.variantId)).toEqual({ on_hand: 10, reserved: 1 });
  });
  it('abandoned uploads expire; attached ones are kept', async () => {
    const { s, p } = await customProduct('cu7');
    const kept = (await upload(s.slug)).json().id; const orphan = (await upload(s.slug)).json().id;
    await buy(s.slug, p.variantId, { ...okAnswers, reference_photo: kept });
    await oq(`UPDATE custom_uploads SET created_at = now() - interval '2 days' WHERE id = ANY($1::uuid[])`, [[kept, orphan]]);
    const before = readdirSync(process.env.UPLOAD_DIR!).length;
    expect(await cleanupOrphanUploads(24)).toBeGreaterThanOrEqual(1);
    expect((await oq('SELECT id FROM custom_uploads WHERE id = ANY($1::uuid[])', [[kept, orphan]])).rows.map(r => r.id)).toEqual([kept]);
    expect(readdirSync(process.env.UPLOAD_DIR!).length).toBeLessThan(before);
  });
});
