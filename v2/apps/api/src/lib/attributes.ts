import type { Client } from '../db.js';
import { pool } from '../db.js';

export interface AttrDef { id: string; key: string; label: string; type: 'text' | 'number' | 'select' | 'multiselect' | 'color' | 'boolean'; unit: string | null; options: { value: string; label: string }[] | null; required: boolean; filterable: boolean; help: string | null }
export interface CategoryInfo { id: string; slug: string; name: string; restricted: boolean; allowsCustom: boolean; defs: AttrDef[]; chain: { id: string; slug: string; name: string }[] }

/** A category with its inherited attributes (parents first). */
export async function categoryInfo(c: Client | typeof pool, id: string): Promise<CategoryInfo | null> {
  const all = (await c.query(`SELECT id, slug, name, parent_id, restricted, allows_custom_attributes FROM categories WHERE status='active'`)).rows; const byId = new Map(all.map(r => [r.id, r]));
  const cat = byId.get(id); if (!cat) return null; const chain: any[] = []; for (let x = cat; x; x = x.parent_id ? byId.get(x.parent_id) : undefined) chain.unshift(x);
  const defs = (await c.query(`SELECT id, category_id, key, label, type, unit, options, required, filterable, help, sort FROM attribute_definitions WHERE category_id = ANY($1::uuid[])`, [chain.map(x => x.id)])).rows;
  const order = new Map(chain.map((x, i) => [x.id, i])); defs.sort((a, b) => (order.get(a.category_id)! - order.get(b.category_id)!) || a.sort - b.sort);
  return { id: cat.id, slug: cat.slug, name: cat.name, restricted: cat.restricted, allowsCustom: cat.allows_custom_attributes, chain: chain.map(x => ({ id: x.id, slug: x.slug, name: x.name })), defs };
}

export interface AttrProblem { key: string; problem: string }
/** Check submitted values against the category's definitions. Drafts may be incomplete; publishing requires the required ones. Free-form keys only where the category allows them. */
export function validateAttributes(info: CategoryInfo, input: Record<string, unknown>, opts: { publish?: boolean } = {}): { values: Record<string, unknown>; problems: AttrProblem[] } {
  const values: Record<string, unknown> = {}; const problems: AttrProblem[] = []; const defs = new Map(info.defs.map(d => [d.key, d]));
  for (const [key, v] of Object.entries(input)) {
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) continue;                       // empty means "not set"
    const d = defs.get(key);
    if (!d) { if (info.allowsCustom && /^[a-z][a-z0-9_]{0,39}$/.test(key) && typeof v === 'string' && v.length <= 200) values[key] = v; else problems.push({ key, problem: 'unknown_attribute' }); continue; }
    const opts_ = new Set((d.options ?? []).map(o => o.value));
    switch (d.type) {
      case 'text': if (typeof v === 'string' && v.length <= 200) values[key] = v.trim(); else problems.push({ key, problem: 'invalid_text' }); break;
      case 'number': if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000) values[key] = v; else problems.push({ key, problem: 'invalid_number' }); break;
      case 'boolean': if (typeof v === 'boolean') values[key] = v; else problems.push({ key, problem: 'invalid_boolean' }); break;
      case 'color': if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) values[key] = v.toLowerCase(); else problems.push({ key, problem: 'invalid_colour' }); break;
      case 'select': if (typeof v === 'string' && opts_.has(v)) values[key] = v; else problems.push({ key, problem: 'invalid_choice' }); break;
      case 'multiselect': if (Array.isArray(v) && v.length <= 20 && v.every(x => typeof x === 'string' && opts_.has(x))) values[key] = [...new Set(v as string[])]; else problems.push({ key, problem: 'invalid_choice' }); break;
    }
  }
  if (opts.publish) for (const d of info.defs) if (d.required && values[d.key] === undefined) problems.push({ key: d.key, problem: 'required' });
  return { values, problems };
}
