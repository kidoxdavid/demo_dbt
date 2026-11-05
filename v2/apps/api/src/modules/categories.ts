import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, q, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { requirePerm } from '../guards.js';

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60);
const catIn = z.object({
  slug, name: z.string().trim().min(1).max(80), parentId: z.string().uuid().nullable().optional(), tileName: z.string().trim().max(40).nullable().optional(),
  artKind: z.string().max(20).nullable().optional(), artTone: z.string().max(20).nullable().optional(), sellerTips: z.string().max(2000).nullable().optional(), photoGuide: z.string().max(2000).nullable().optional(),
  allowsCustomAttributes: z.boolean().optional(), restricted: z.boolean().optional(), sort: z.number().int().min(0).max(100000).optional(),
}).strict();
const optionsIn = z.array(z.object({ value: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40), label: z.string().trim().min(1).max(60) }).strict()).min(1).max(60);
const attrIn = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(40), label: z.string().trim().min(1).max(80), type: z.enum(['text', 'number', 'select', 'multiselect', 'color', 'boolean']),
  unit: z.string().max(10).nullable().optional(), options: optionsIn.nullable().optional(), required: z.boolean().optional(), filterable: z.boolean().optional(), help: z.string().max(300).nullable().optional(), sort: z.number().int().min(0).max(100000).optional(),
}).strict().superRefine((a, ctx) => {
  const sel = a.type === 'select' || a.type === 'multiselect';
  if (sel && !a.options?.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'A choice list needs at least one option' });
  if (!sel && a.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only choice lists have options' });
  if (a.options && new Set(a.options.map(o => o.value)).size !== a.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option values must be unique' });
  if (a.unit && a.type !== 'number') ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Only numbers have a unit' });
});

const catView = (r: any) => ({ id: r.id, slug: r.slug, name: r.name, tileName: r.tile_name, art: r.art_kind ? { kind: r.art_kind, tone: r.art_tone } : null, restricted: r.restricted, allowsCustomAttributes: r.allows_custom_attributes, parentId: r.parent_id, sort: r.sort, status: r.status });
const attrView = (r: any) => ({ id: r.id, key: r.key, label: r.label, type: r.type, unit: r.unit, options: r.options, required: r.required, filterable: r.filterable, help: r.help, sort: r.sort });

export function registerCategories(app: FastifyInstance) {
  // ---- Public
  app.get('/api/categories', async () => {
    const rows = (await q(`SELECT * FROM categories WHERE status='active' ORDER BY sort, name`)).rows;
    const nodes = new Map(rows.map(r => [r.id, { ...catView(r), children: [] as any[] }]));
    const roots: any[] = []; for (const n of nodes.values()) { const p = n.parentId ? nodes.get(n.parentId) : null; (p ? p.children : roots).push(n); } return roots;
  });
  app.get('/api/categories/:slug', async (req) => {
    const { slug: s } = z.object({ slug }).parse(req.params);
    const all = (await q(`SELECT * FROM categories WHERE status='active'`)).rows; const byId = new Map(all.map(r => [r.id, r])); const cat = all.find(r => r.slug === s); if (!cat) throw new HttpError(404, 'not_found');
    const chain: any[] = []; for (let c = cat; c; c = c.parent_id ? byId.get(c.parent_id) : undefined) chain.unshift(c);          // root first: parents' attributes are inherited
    const attrs = (await q(`SELECT * FROM attribute_definitions WHERE category_id = ANY($1::uuid[]) ORDER BY sort, label`, [chain.map(c => c.id)])).rows;
    const order = new Map(chain.map((c, i) => [c.id, i])); attrs.sort((a, b) => (order.get(a.category_id)! - order.get(b.category_id)!) || a.sort - b.sort);
    return { ...catView(cat), sellerTips: cat.seller_tips, photoGuide: cat.photo_guide, breadcrumbs: chain.map(c => ({ slug: c.slug, name: c.name })), attributes: attrs.map(attrView),
      filters: attrs.filter(a => a.filterable).map(attrView) };
  });

  // ---- Admin (permission categories.write; every change audited)
  app.get('/api/admin/categories', async (req) => { requirePerm(req, 'categories.write'); return (await q('SELECT * FROM categories ORDER BY sort, name')).rows.map(catView); });
  app.post('/api/admin/categories', async (req, reply) => {
    const u = requirePerm(req, 'categories.write'); const b = catIn.parse(req.body);
    const row = await tx(async c => {
      if (b.parentId && !(await c.query('SELECT 1 FROM categories WHERE id=$1', [b.parentId])).rowCount) throw new HttpError(422, 'parent_not_found');
      const r = await c.query(`INSERT INTO categories(slug,name,parent_id,tile_name,art_kind,art_tone,seller_tips,photo_guide,allows_custom_attributes,restricted,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [b.slug, b.name, b.parentId ?? null, b.tileName ?? null, b.artKind ?? null, b.artTone ?? null, b.sellerTips ?? null, b.photoGuide ?? null, b.allowsCustomAttributes ?? false, b.restricted ?? false, b.sort ?? 100])
        .catch(e => { if (e.code === '23505') throw new HttpError(409, 'slug_exists'); throw e; });
      await audit(c, { actor: u.id, area: 'admin', action: 'category.create', entityType: 'category', entityId: r.rows[0].id, next: catView(r.rows[0]), ip: req.ip }); return r.rows[0];
    });
    return reply.code(201).send(catView(row));
  });
  app.patch('/api/admin/categories/:id', async (req) => {
    const u = requirePerm(req, 'categories.write'); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = catIn.partial().extend({ status: z.enum(['active', 'archived']).optional() }).strict().parse(req.body);
    return tx(async c => {
      const prev = (await c.query('SELECT * FROM categories WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!prev) throw new HttpError(404, 'not_found');
      if (b.parentId === id) throw new HttpError(422, 'parent_is_self');
      if (b.parentId) { for (let p = b.parentId as string | null; p; p = (await c.query('SELECT parent_id FROM categories WHERE id=$1', [p])).rows[0]?.parent_id ?? null) if (p === id) throw new HttpError(422, 'parent_cycle'); }
      const r = await c.query(`UPDATE categories SET slug=coalesce($2,slug), name=coalesce($3,name), parent_id=CASE WHEN $4::boolean THEN $5::uuid ELSE parent_id END, tile_name=coalesce($6,tile_name), art_kind=coalesce($7,art_kind), art_tone=coalesce($8,art_tone),
          seller_tips=coalesce($9,seller_tips), photo_guide=coalesce($10,photo_guide), allows_custom_attributes=coalesce($11,allows_custom_attributes), restricted=coalesce($12,restricted), sort=coalesce($13,sort), status=coalesce($14,status), updated_at=now() WHERE id=$1 RETURNING *`,
        [id, b.slug ?? null, b.name ?? null, 'parentId' in b, b.parentId ?? null, b.tileName ?? null, b.artKind ?? null, b.artTone ?? null, b.sellerTips ?? null, b.photoGuide ?? null, b.allowsCustomAttributes ?? null, b.restricted ?? null, b.sort ?? null, b.status ?? null])
        .catch(e => { if (e.code === '23505') throw new HttpError(409, 'slug_exists'); throw e; });
      await audit(c, { actor: u.id, area: 'admin', action: 'category.update', entityType: 'category', entityId: id, prev: catView(prev), next: catView(r.rows[0]), ip: req.ip }); return catView(r.rows[0]);
    });
  });

  app.get('/api/admin/categories/:id/attributes', async (req) => { requirePerm(req, 'categories.write'); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return (await q('SELECT * FROM attribute_definitions WHERE category_id=$1 ORDER BY sort, label', [id])).rows.map(attrView); });
  app.post('/api/admin/categories/:id/attributes', async (req, reply) => {
    const u = requirePerm(req, 'categories.write'); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = attrIn.parse(req.body);
    const row = await tx(async c => {
      if (!(await c.query('SELECT 1 FROM categories WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'not_found');
      const r = await c.query(`INSERT INTO attribute_definitions(category_id,key,label,type,unit,options,required,filterable,help,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, b.key, b.label, b.type, b.unit ?? null, b.options ? JSON.stringify(b.options) : null, b.required ?? false, b.filterable ?? false, b.help ?? null, b.sort ?? 100]).catch(e => { if (e.code === '23505') throw new HttpError(409, 'key_exists'); throw e; });
      await audit(c, { actor: u.id, area: 'admin', action: 'attribute.create', entityType: 'attribute', entityId: r.rows[0].id, next: attrView(r.rows[0]), ip: req.ip }); return r.rows[0];
    });
    return reply.code(201).send(attrView(row));
  });
  app.put('/api/admin/attributes/:id', async (req) => {
    const u = requirePerm(req, 'categories.write'); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = attrIn.parse(req.body);
    return tx(async c => {
      const prev = (await c.query('SELECT * FROM attribute_definitions WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!prev) throw new HttpError(404, 'not_found');
      const r = await c.query(`UPDATE attribute_definitions SET key=$2,label=$3,type=$4,unit=$5,options=$6,required=$7,filterable=$8,help=$9,sort=$10 WHERE id=$1 RETURNING *`,
        [id, b.key, b.label, b.type, b.unit ?? null, b.options ? JSON.stringify(b.options) : null, b.required ?? false, b.filterable ?? false, b.help ?? null, b.sort ?? prev.sort]).catch(e => { if (e.code === '23505') throw new HttpError(409, 'key_exists'); throw e; });
      await audit(c, { actor: u.id, area: 'admin', action: 'attribute.update', entityType: 'attribute', entityId: id, prev: attrView(prev), next: attrView(r.rows[0]), ip: req.ip }); return attrView(r.rows[0]);
    });
  });
  app.delete('/api/admin/attributes/:id', async (req) => {
    const u = requirePerm(req, 'categories.write'); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return tx(async c => { const r = await c.query('DELETE FROM attribute_definitions WHERE id=$1 RETURNING *', [id]); if (!r.rowCount) throw new HttpError(404, 'not_found');
      await audit(c, { actor: u.id, area: 'admin', action: 'attribute.delete', entityType: 'attribute', entityId: id, prev: attrView(r.rows[0]), ip: req.ip }); return { deleted: true }; });
  });
}
