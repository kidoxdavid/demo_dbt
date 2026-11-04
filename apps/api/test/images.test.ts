import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { existsSync, readdirSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { owner, oq, ck, kit, realPng } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const MARKER = 'SECRET-HOME-ADDRESS-12345';
const jpegWithExif = (w: number, h: number, orientation?: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } }).jpeg().withExif({ IFD0: { Copyright: MARKER, ImageDescription: 'taken at my house' } })
    .withMetadata(orientation ? { orientation } : {}).toBuffer();
const upload = (cookie: string, pid: string, body: Buffer, type = 'image/jpeg') =>
  app.inject({ method: 'POST', url: `/api/seller/products/${pid}/images`, headers: { 'content-type': type }, cookies: { eazy_sid: cookie }, payload: body });
const files = () => readdirSync(process.env.UPLOAD_DIR!);

describe('image processing', () => {
  it('strips EXIF and other hidden metadata from product photos', async () => {
    const s = await k.seller('im1'); const p = await k.product(s.cookie);
    const src = await jpegWithExif(200, 100);
    expect((await sharp(src).metadata()).exif).toBeTruthy();                               // the test image really carries EXIF
    expect(src.includes(Buffer.from(MARKER))).toBe(true);
    const r = await upload(s.cookie, p.id, src); expect(r.statusCode).toBe(201);
    const served = await app.inject({ method: 'GET', url: r.json().url });
    expect(served.rawPayload.includes(Buffer.from(MARKER))).toBe(false);
    const meta = await sharp(served.rawPayload).metadata(); expect(meta.exif).toBeUndefined(); expect(meta.format).toBe('webp');
  });
  it('applies camera rotation before dropping it, so photos are not sideways', async () => {
    const s = await k.seller('im2'); const p = await k.product(s.cookie);
    const r = await upload(s.cookie, p.id, await jpegWithExif(100, 50, 6));                 // EXIF says "rotate 90 degrees"
    const meta = await sharp((await app.inject({ method: 'GET', url: r.json().url })).rawPayload).metadata();
    expect({ w: meta.width, h: meta.height }).toEqual({ w: 50, h: 100 });
  });
  it('caps big photos and serves a smaller thumbnail for grids', async () => {
    const s = await k.seller('im3'); const p = await k.product(s.cookie);
    const big = await sharp({ create: { width: 3200, height: 2000, channels: 3, background: '#aa5533' } }).jpeg().toBuffer();
    const r = await upload(s.cookie, p.id, big); const url: string = r.json().url;
    const full = await app.inject({ method: 'GET', url }); const thumb = await app.inject({ method: 'GET', url: `${url}?w=480` });
    expect((await sharp(full.rawPayload).metadata()).width).toBe(1600);
    const tm = await sharp(thumb.rawPayload).metadata(); expect(tm.width).toBe(480); expect(tm.height).toBe(300);
    expect(thumb.rawPayload.length).toBeLessThan(full.rawPayload.length);
    expect((await sharp((await app.inject({ method: 'GET', url: `${url}?w=2000` })).rawPayload).metadata()).width).toBe(1600);   // large requests get the main file
    expect((await app.inject({ method: 'GET', url: `${url}?w=abc` })).statusCode).toBe(200);
  });
  it('deleting a photo removes both files from storage', async () => {
    const s = await k.seller('im4'); const p = await k.product(s.cookie);
    const r = await upload(s.cookie, p.id, await realPng()); const key = (r.json().url as string).replace('/media/', '');
    const thumb = key.replace('.webp', '_t.webp'); expect(existsSync(`${process.env.UPLOAD_DIR}/${key}`)).toBe(true); expect(existsSync(`${process.env.UPLOAD_DIR}/${thumb}`)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/seller/images/${r.json().id}`, ...ck(s.cookie) })).statusCode).toBe(200);
    expect(existsSync(`${process.env.UPLOAD_DIR}/${key}`)).toBe(false); expect(existsSync(`${process.env.UPLOAD_DIR}/${thumb}`)).toBe(false);
  });
  it('rejects files that only look like images, and stores nothing', async () => {
    const s = await k.seller('im5'); const p = await k.product(s.cookie);
    const before = files().length;
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);           // valid PNG signature, garbage body
    expect((await upload(s.cookie, p.id, fake, 'image/png')).statusCode).toBe(415);
    const truncated = (await realPng(300, 300)).subarray(0, 120);
    expect((await upload(s.cookie, p.id, truncated, 'image/png')).statusCode).toBe(415);
    expect((await upload(s.cookie, p.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png')).statusCode).toBe(415);   // SVG can carry scripts
    expect(files().length).toBe(before);
  });
  it('refuses decompression bombs (a small file that expands to a huge bitmap)', async () => {
    const s = await k.seller('im6'); const p = await k.product(s.cookie);
    const bomb = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: '#000000' } }).png({ compressionLevel: 9 }).toBuffer();   // ~49 megapixels
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    expect((await upload(s.cookie, p.id, bomb, 'image/png')).statusCode).toBe(415);
  }, 60000);
  it('keeps transparency, and strips metadata from customers\' reference photos too', async () => {
    const s = await k.seller('im7'); const p = await k.product(s.cookie, { customFields: [{ label: 'Sketch', type: 'image' }] });
    const alpha = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.4 } } }).png().toBuffer();
    const a = await upload(s.cookie, p.id, alpha, 'image/png'); expect((await sharp((await app.inject({ method: 'GET', url: a.json().url })).rawPayload).metadata()).hasAlpha).toBe(true);
    const up = await app.inject({ method: 'POST', url: `/api/public/stores/${s.slug}/custom-upload`, headers: { 'content-type': 'image/jpeg' }, payload: await jpegWithExif(120, 80) });
    expect(up.statusCode).toBe(201);
    const c = await app.inject({ method: 'POST', url: `/api/public/stores/${s.slug}/checkout`, payload: { items: [{ variantId: p.variantId, quantity: 1, customizations: { sketch: up.json().id } }], email: 'b@x.test', name: 'B', fulfilment: 'pickup' } });
    expect(c.statusCode).toBe(201);
    const img = await app.inject({ method: 'GET', url: `/api/seller/custom-uploads/${up.json().id}`, ...ck(s.cookie) });
    expect(img.rawPayload.includes(Buffer.from(MARKER))).toBe(false); expect((await sharp(img.rawPayload).metadata()).exif).toBeUndefined();
  });
});

describe('storefront search and paging', () => {
  async function shop(n: string) {
    const s = await k.seller(n);
    for (const [name, brand, price] of [['Oud Noir', 'Maison Zed', 8500], ['Rose Water', 'Maison Zed', 1500], ['Amber Candle', 'Lume', 3200], ['Vetiver Sport', 'Lume', 5200]] as const)
      await k.product(s.cookie, { name, brand, variants: [{ priceCents: price, costCents: 100, stock: 9 }] });
    return s;
  }
  const list = (slug: string, qs = '') => app.inject({ method: 'GET', url: `/api/public/stores/${slug}/products${qs}` });
  it('searches by name, brand and description, tolerates typos, treats wildcards literally, and reports the total', async () => {
    const s = await shop('ss1');
    const names = async (qs: string) => (await list(s.slug, qs)).json().map((p: any) => p.name).sort();
    expect(await names('?q=oud')).toEqual(['Oud Noir']);
    expect(await names('?q=lume')).toEqual(['Amber Candle', 'Vetiver Sport']);
    expect(await names('?q=rose%20watr')).toEqual(['Rose Water']);                                  // typo
    expect(await names('?q=%25')).toEqual([]); expect(await names('?q=_____')).toEqual([]);
    const all = await list(s.slug); expect(all.headers['x-total-count']).toBe('4'); expect(all.json()).toHaveLength(4);
    const none = await list(s.slug, '?q=zzzzzz'); expect(none.statusCode).toBe(200); expect(none.json()).toEqual([]); expect(none.headers['x-total-count']).toBe('0');
    expect((await list(s.slug, '?q=lume')).headers['x-total-count']).toBe('2');
  });
  it('sorts by price and pages without gaps or repeats', async () => {
    const s = await shop('ss2');
    const asc = (await list(s.slug, '?sort=price_asc')).json().map((p: any) => p.name); expect(asc).toEqual(['Rose Water', 'Amber Candle', 'Vetiver Sport', 'Oud Noir']);
    expect((await list(s.slug, '?sort=price_desc')).json().map((p: any) => p.name)).toEqual([...asc].reverse());
    const p1 = (await list(s.slug, '?sort=price_asc&limit=3&offset=0')).json(); const p2 = (await list(s.slug, '?sort=price_asc&limit=3&offset=3')).json();
    expect([...p1, ...p2].map((p: any) => p.name)).toEqual(asc); expect((await list(s.slug, '?sort=bogus')).statusCode).toBe(400);
  });
  it('never exposes costs or internals through search results', async () => {
    const s = await shop('ss3'); const body = (await list(s.slug, '?q=oud')).body;
    expect(body).not.toMatch(/cost|on_hand|tenant|reserved/i);
  });
});

describe('search ranks exact matches and only falls back to typo tolerance when nothing matches', () => {
  it('"Item 07" finds Item 07, not every numbered item; typos still work when there is no exact match', async () => {
    const s = await k.seller('ss9');
    for (let i = 1; i <= 12; i++) await k.product(s.cookie, { name: `Item ${String(i).padStart(2, '0')}`, variants: [{ priceCents: 1000 + i, stock: 5 }] });
    const sf = async (q: string) => { const r = await app.inject({ method: 'GET', url: `/api/public/stores/${s.slug}/products?q=${encodeURIComponent(q)}` }); return { names: r.json().map((p: any) => p.name), total: r.headers['x-total-count'] }; };
    expect(await sf('Item 07')).toEqual({ names: ['Item 07'], total: '1' });
    expect((await sf('Item 1')).names.sort()).toEqual(['Item 10', 'Item 11', 'Item 12']);          // genuine partial matches are all kept
    expect((await sf('Itam 07')).names).toContain('Item 07');                                       // no exact match: typo tolerance kicks in
    const mk = async (q: string) => (await app.inject({ method: 'GET', url: `/api/public/marketplace?q=${encodeURIComponent(q)}` })).json().products.map((p: any) => p.name);
    expect(await mk('Item 07')).toEqual(['Item 07']);
    expect(await mk('Itam 07')).toContain('Item 07');
  });
});
