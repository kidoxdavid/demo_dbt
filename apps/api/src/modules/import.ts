import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { parseCsv } from '../lib/csv.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
export const FIELDS = ['name', 'description', 'brand', 'option', 'sku', 'price', 'cost', 'stock'] as const;
export type Field = typeof FIELDS[number];
const SYNONYMS: Record<Field, string[]> = {
  name: ['name', 'title', 'product', 'productname', 'item', 'itemname', 'producttitle'],
  description: ['description', 'desc', 'details', 'body'],
  brand: ['brand', 'vendor', 'manufacturer', 'make'],
  option: ['option', 'variant', 'variantname', 'size', 'colour', 'color', 'optionname'],
  sku: ['sku', 'code', 'itemcode', 'productcode', 'barcode', 'upc'],
  price: ['price', 'sellingprice', 'retailprice', 'saleprice', 'unitprice', 'cost$'],
  cost: ['cost', 'costprice', 'unitcost', 'buyprice', 'wholesale', 'cogs'],
  stock: ['stock', 'quantity', 'qty', 'inventory', 'onhand', 'instock', 'available'],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]/g, '');

/** Suggest a column→field mapping from header names. Each field and each column is used at most once. */
export function suggestMapping(headers: string[]): Record<number, Field> {
  const out: Record<number, Field> = {}; const used = new Set<Field>();
  headers.forEach((h, i) => {
    const n = norm(h);
    for (const f of FIELDS) if (!used.has(f) && SYNONYMS[f].includes(n)) { out[i] = f; used.add(f); break; }
  });
  return out;
}

const money = (v: string): number | null | 'bad' => {
  const t = v.trim().replace(/^\$/, '').replace(/,/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'bad';
  return Math.round(parseFloat(t) * 100);
};

export interface ParsedRow { line: number; name: string; description?: string; brand?: string; option: string; sku?: string; priceCents?: number; costCents?: number; stock: number; issues: string[]; duplicate?: string }

export async function analyze(csv: string, mapping: Record<number, Field>, existing: { skus: Set<string>; names: Set<string> }) {
  let grid: string[][];
  try { grid = parseCsv(csv); } catch { throw new HttpError(422, 'csv_malformed'); }
  if (grid.length < 2) throw new HttpError(422, 'csv_empty');
  if (grid.length > 2001) throw new HttpError(422, 'csv_too_many_rows');
  const headers = grid[0]; const body = grid.slice(1);
  const col = (f: Field) => Object.entries(mapping).find(([, v]) => v === f)?.[0];
  const idx = Object.fromEntries(FIELDS.map(f => [f, col(f) === undefined ? -1 : Number(col(f))])) as Record<Field, number>;
  const get = (r: string[], f: Field) => (idx[f] >= 0 ? (r[idx[f]] ?? '').trim() : '');
  const seenSku = new Map<string, number>();
  const rows: ParsedRow[] = body.map((r, n) => {
    const issues: string[] = []; const line = n + 2;
    const name = get(r, 'name'); if (!name) issues.push('Missing product name'); if (name.length > 200) issues.push('Name is longer than 200 characters');
    const p = money(get(r, 'price')); const c = money(get(r, 'cost'));
    if (idx.price < 0) issues.push('No price column mapped'); else if (p === null) issues.push('Missing price'); else if (p === 'bad') issues.push(`Invalid price "${get(r, 'price')}"`);
    if (c === 'bad') issues.push(`Invalid cost "${get(r, 'cost')}"`);
    const stockRaw = get(r, 'stock'); let stock = 0;
    if (stockRaw !== '') { if (!/^\d+$/.test(stockRaw)) issues.push(`Invalid quantity "${stockRaw}"`); else stock = parseInt(stockRaw, 10); }
    if (stock > 1_000_000) issues.push('Quantity is too large');
    const sku = get(r, 'sku') || undefined; let duplicate: string | undefined;
    if (sku) {
      if (existing.skus.has(sku.toLowerCase())) duplicate = `SKU "${sku}" already exists in your catalogue`;
      else if (seenSku.has(sku.toLowerCase())) issues.push(`SKU "${sku}" repeats line ${seenSku.get(sku.toLowerCase())} in this file`);
      else seenSku.set(sku.toLowerCase(), line);
    }
    return { line, name, description: get(r, 'description') || undefined, brand: get(r, 'brand') || undefined, option: get(r, 'option') || 'Default', sku,
      priceCents: typeof p === 'number' ? p : undefined, costCents: typeof c === 'number' ? c : undefined, stock, issues, duplicate };
  });
  // Rows with the same name become options of one product. Name-only matches with existing products are flagged, never merged.
  const groups = new Map<string, ParsedRow[]>();
  for (const r of rows) { const k = r.name.toLowerCase(); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  for (const [k, rs] of groups) {
    if (k && existing.names.has(k)) for (const r of rs) r.duplicate ??= `A product named "${r.name}" already exists`;
    const opts = new Map<string, number>();
    for (const r of rs) { const o = r.option.toLowerCase(); if (opts.has(o) && rs.length > 1) r.issues.push(`Option "${r.option}" repeats line ${opts.get(o)} for this product`); else opts.set(o, r.line); }
  }
  const ok = rows.filter(r => !r.issues.length && !r.duplicate);
  return { headers, mapping, rows, summary: { total: rows.length, importable: ok.length, withIssues: rows.filter(r => r.issues.length).length, duplicates: rows.filter(r => r.duplicate && !r.issues.length).length,
    products: new Set(ok.map(r => r.name.toLowerCase())).size, mappedFields: Object.values(mapping) } };
}

export function registerImport(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx> }) {
  const body = z.object({
    csv: z.string().min(1).max(2_000_000),
    mapping: z.record(z.string().regex(/^\d+$/), z.enum(FIELDS)).optional(),
    importAsDraft: z.boolean().default(true),
  }).strict();

  async function load(t: TenantCtx, csv: string, m?: Record<string, Field>) {
    const grid = (() => { try { return parseCsv(csv); } catch { throw new HttpError(422, 'csv_malformed'); } })();
    if (!grid.length) throw new HttpError(422, 'csv_empty');
    const mapping = m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [Number(k), v])) as Record<number, Field> : suggestMapping(grid[0]);
    const vals = Object.values(mapping);
    if (new Set(vals).size !== vals.length) throw new HttpError(422, 'mapping_duplicate_field');
    const existing = await withTx(t, async c => ({
      skus: new Set((await c.query('SELECT lower(sku) s FROM product_variants WHERE sku IS NOT NULL')).rows.map(r => r.s as string)),
      names: new Set((await c.query(`SELECT lower(name) n FROM products WHERE status<>'archived'`)).rows.map(r => r.n as string)),
    }));
    return analyze(csv, mapping, existing);
  }

  // Preview only: nothing is written.
  app.post('/api/seller/imports/preview', async (req) => {
    const t = await deps.tenantCtx(req); if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const b = body.parse(req.body);
    const a = await load(t, b.csv, b.mapping);
    return { ...a, rows: a.rows.slice(0, 200), truncated: a.rows.length > 200 };
  });

  // Import approved rows. Rows with issues or duplicates are skipped; existing data is never overwritten.
  app.post('/api/seller/imports/commit', async (req, reply) => {
    const t = await deps.tenantCtx(req); if (!['owner', 'manager'].includes(t.role)) throw new HttpError(403, 'forbidden');
    const b = body.parse(req.body);
    const a = await load(t, b.csv, b.mapping);
    const ok = a.rows.filter(r => !r.issues.length && !r.duplicate);
    if (!ok.length) throw new HttpError(422, 'nothing_to_import');
    const groups = new Map<string, ParsedRow[]>();
    for (const r of ok) { const k = r.name.toLowerCase(); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
    const status = b.importAsDraft ? 'draft' : 'active';
    const created = await withTx(t, async c => {
      if (status === 'active') {
        const lim = (await c.query(`SELECT (p.limits->>'active_products')::int AS lim FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE t.id=$1`, [t.tenantId])).rows[0]?.lim;
        const n = (await c.query(`SELECT count(*)::int n FROM products WHERE status='active'`)).rows[0].n;
        if (lim != null && n + groups.size > lim) throw new HttpError(402, 'plan_limit_active_products');
      }
      let products = 0, variants = 0;
      for (const rs of groups.values()) {
        const first = rs[0];
        const p = (await c.query(`INSERT INTO products(tenant_id,name,description,brand,status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [t.tenantId, first.name, first.description ?? null, first.brand ?? null, status])).rows[0];
        products++;
        for (const r of rs) {
          const v = (await c.query(`INSERT INTO product_variants(tenant_id,product_id,title,sku,price_cents,cost_cents) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [t.tenantId, p.id, rs.length === 1 && r.option === 'Default' ? 'Default' : r.option, r.sku ?? null, r.priceCents, r.costCents ?? null])).rows[0];
          await c.query('INSERT INTO inventory_levels(variant_id,tenant_id,on_hand) VALUES ($1,$2,$3)', [v.id, t.tenantId, r.stock]);
          if (r.stock) await c.query(`INSERT INTO inventory_movements(tenant_id,variant_id,delta,reason,actor_user_id,note) VALUES ($1,$2,$3,'initial',$4,'CSV import')`, [t.tenantId, v.id, r.stock, t.userId]);
          variants++;
        }
      }
      await audit(c, { actor: t.userId, tenantId: t.tenantId, action: 'products.import', entityType: 'import', next: { products, variants, skipped: a.rows.length - ok.length } });
      return { products, variants };
    });
    return reply.code(201).send({ ...created, skipped: a.rows.length - ok.length, status });
  });
}
