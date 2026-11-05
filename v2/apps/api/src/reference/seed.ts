import type { Client } from '../db.js';
import { CATEGORIES } from './categories.js';

/** Insert launch categories and attributes that are missing. Never overwrites: staff edits in the admin console win. */
export async function seedReference(c: Client) {
  let order = 10;
  for (const cat of CATEGORIES) {
    const r = await c.query(
      `INSERT INTO categories(slug,name,tile_name,art_kind,art_tone,seller_tips,photo_guide,allows_custom_attributes,restricted,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (slug) DO NOTHING RETURNING id`, [cat.slug, cat.name, cat.tile, cat.art, cat.tone, cat.tips, cat.photos, !!cat.custom, !!cat.restricted, order]);
    order += 10;
    if (!r.rowCount) continue;                           // already there: do not touch its attributes either
    let s = 10;
    for (const a of cat.attrs) {
      await c.query(`INSERT INTO attribute_definitions(category_id,key,label,type,unit,options,required,filterable,help,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.rows[0].id, a.key, a.label, a.type, a.unit ?? null, a.options ? JSON.stringify(a.options.map(o => ({ value: o.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label: o }))) : null, !!a.required, !!a.filterable, a.help ?? null, s]);
      s += 10;
    }
  }
}
