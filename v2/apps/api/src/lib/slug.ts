import type { Client } from '../db.js';
export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';
/** A free shop slug: clay-ember, clay-ember-2, clay-ember-3 ... Reserved words are skipped. */
const RESERVED = new Set(['admin', 'api', 'studio', 'support', 'finance', 'marketing', 'shop', 'shops', 'c', 'p', 'basket', 'account', 'saved', 'search', 'login', 'signup', 'start', 'health']);
export async function freeSlug(c: Client, name: string) {
  const base = slugify(name); for (let i = 1; i < 200; i++) { const s = i === 1 ? base : `${base}-${i}`;
    if (!RESERVED.has(s) && s.length >= 2 && !(await c.query('SELECT 1 FROM shops WHERE slug=$1', [s])).rowCount) return s; }
  throw new Error('no free slug');
}
