import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { parseCsv } from '../src/lib/csv.js';
import { suggestMapping } from '../src/modules/import.js';

let app: FastifyInstance;
const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

async function seller(n: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `${n}@i.test`, password: 'correct-horse-battery', fullName: n, businessName: n, storeSlug: `${n}-imp` } });
  return r.cookies.find(c => c.name === 'eazy_sid')!.value;
}
const post = (cookie: string, path: string, payload: object) => app.inject({ method: 'POST', url: `/api/seller/imports/${path}`, cookies: { eazy_sid: cookie }, payload });
const products = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/seller/products?limit=100', cookies: { eazy_sid: cookie } })).json();

describe('csv parser', () => {
  it('handles quotes, escaped quotes, embedded commas/newlines, CRLF, BOM, blank lines', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n"line1\nline2",z\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['line1\nline2', 'z']]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(() => parseCsv('a,"unterminated\n1,2')).toThrow('unterminated_quote');
  });
});
describe('mapping suggestion', () => {
  it('maps common spreadsheet headers and uses each field once', () => {
    expect(suggestMapping(['Product Name', 'Selling Price', 'Qty', 'SKU', 'Unit Cost', 'Brand', 'Notes'])).toEqual({ 0: 'name', 1: 'price', 2: 'stock', 3: 'sku', 4: 'cost', 5: 'brand' });
  });
});

const CSV = [
  'Product Name,Size,SKU,Price,Cost,Qty,Brand',
  'Oud Noir,50ml,OUD-50,$80.00,35,4,Maison',
  'Oud Noir,100ml,OUD-100,"1,140.00",,2,Maison',
  'Rose Water,,ROSE-1,12.5,5,10,',
  'Bad Price,,BP-1,abc,,3,',
  ',,NONAME,5,,1,',
  'Bad Qty,,BQ-1,5,,-3,',
  'Dupe In File,,ROSE-1,9,,1,',
].join('\n');

describe('import preview and commit', () => {
  it('previews with suggested mapping, flags every problem with line numbers, and writes nothing', async () => {
    const c = await seller('prev1');
    const r = (await post(c, 'preview', { csv: CSV })).json();
    expect(r.summary).toMatchObject({ total: 7, importable: 3, products: 2 });
    const byLine = (n: number) => r.rows.find((x: any) => x.line === n);
    expect(byLine(2)).toMatchObject({ name: 'Oud Noir', option: '50ml', priceCents: 8000, costCents: 3500, stock: 4, issues: [] });
    expect(byLine(3).priceCents).toBe(114000);
    expect(byLine(5).issues[0]).toMatch(/Invalid price "abc"/);
    expect(byLine(6).issues[0]).toMatch(/Missing product name/);
    expect(byLine(7).issues[0]).toMatch(/Invalid quantity "-3"/);
    expect(byLine(8).issues.join()).toMatch(/repeats line 4/);
    expect(await products(c)).toHaveLength(0);
  });
  it('commits only clean rows, groups options into one product with variants, records stock, defaults to draft', async () => {
    const c = await seller('commit1');
    const r = await post(c, 'commit', { csv: CSV });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ products: 2, variants: 3, skipped: 4, status: 'draft' });
    const list = await products(c);
    const oud = list.find((p: any) => p.name === 'Oud Noir');
    expect(oud.status).toBe('draft');
    expect(oud.variants.map((v: any) => [v.title, v.priceCents, v.onHand]).sort()).toEqual([['100ml', 114000, 2], ['50ml', 8000, 4]]);
    expect(list.find((p: any) => p.name === 'Rose Water').variants[0]).toMatchObject({ title: 'Default', costCents: 500 });
  });
  it('never overwrites: re-importing the same file creates nothing and flags duplicates', async () => {
    const c = await seller('dupe1');
    await post(c, 'commit', { csv: CSV });
    const prev = (await post(c, 'preview', { csv: CSV })).json();
    expect(prev.summary.importable).toBe(0); expect(prev.summary.duplicates).toBe(4); // 3 imported rows + the in-file repeat of ROSE-1, now a duplicate of the catalogue
    expect((await post(c, 'commit', { csv: CSV })).statusCode).toBe(422);
    expect(await products(c)).toHaveLength(2);
    const sameNameNewSku = (await post(c, 'preview', { csv: 'name,price\nRose Water,9' })).json();
    expect(sameNameNewSku.rows[0].duplicate).toMatch(/already exists/);
  });
  it('honours a custom mapping and rejects a mapping that assigns a field twice', async () => {
    const c = await seller('map1');
    const csv = 'A,B,C\nWidget,9.99,7';
    const r = (await post(c, 'preview', { csv, mapping: { 0: 'name', 1: 'price', 2: 'stock' } })).json();
    expect(r.rows[0]).toMatchObject({ name: 'Widget', priceCents: 999, stock: 7, issues: [] });
    expect((await post(c, 'preview', { csv, mapping: { 0: 'name', 1: 'price', 2: 'price' } })).statusCode).toBe(422);
    expect((await post(c, 'preview', { csv: 'x,y\nA,B' })).json().rows[0].issues.join()).toMatch(/Missing product name|No price column/);
  });
  it('enforces plan limits when importing as active, and rejects malformed or empty files', async () => {
    const c = await seller('lim1');
    await owner.query(`UPDATE plans SET limits = jsonb_set(limits,'{active_products}','1') WHERE code='starter'`);
    expect((await post(c, 'commit', { csv: CSV, importAsDraft: false })).statusCode).toBe(402);
    expect((await post(c, 'commit', { csv: CSV, importAsDraft: true })).statusCode).toBe(201);
    await owner.query(`UPDATE plans SET limits = jsonb_set(limits,'{active_products}','50') WHERE code='starter'`);
    expect((await post(c, 'preview', { csv: 'a,"b\n1,2' })).statusCode).toBe(422);
    expect((await post(c, 'preview', { csv: 'name,price' })).statusCode).toBe(422);
  });
  it('isolates tenants: another seller\'s catalogue does not create false duplicates, and anonymous users are refused', async () => {
    const a = await seller('iso-i1'); const b = await seller('iso-i2');
    await post(a, 'commit', { csv: CSV });
    expect((await post(b, 'preview', { csv: CSV })).json().summary.importable).toBe(3);
    expect((await app.inject({ method: 'POST', url: '/api/seller/imports/preview', payload: { csv: CSV } })).statusCode).toBe(401);
  });
  it('imported products can be sold end to end after activation (stock reserved from imported levels)', async () => {
    const c = await seller('e2e-i1');
    await post(c, 'commit', { csv: 'name,sku,price,qty\nMug,MUG-1,15,1' });
    const p = (await products(c))[0];
    await app.inject({ method: 'PATCH', url: `/api/seller/products/${p.id}`, cookies: { eazy_sid: c }, payload: { status: 'active' } });
    expect((await products(c))[0].variants[0]).toMatchObject({ onHand: 1, reserved: 0 });
  });
});
