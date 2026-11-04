import { z } from 'zod';
import { HttpError } from './errors.js';

/** Seller-defined customer inputs for a product (names, dates, notes, a choice, a reference image). */
export const fieldIn = z.object({
  label: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'textarea', 'select', 'image']),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  maxLength: z.number().int().min(1).max(1000).optional(),
}).strict().refine(f => f.type !== 'select' || (f.options && new Set(f.options).size >= 2), { message: 'A choice field needs at least 2 different options' });

export const customFieldsIn = z.array(fieldIn).max(10)
  .refine(a => new Set(a.map(f => f.label.toLowerCase())).size === a.length, { message: 'Field names must be unique' });

export interface Field { key: string; label: string; type: 'text' | 'textarea' | 'select' | 'image'; required: boolean; options?: string[]; maxLength?: number }

export function withKeys(fields: z.infer<typeof customFieldsIn>): Field[] {
  const used = new Set<string>();
  return fields.map((f, i) => {
    let key = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || `field_${i + 1}`;
    while (used.has(key)) key = `${key.slice(0, 36)}_${i + 1}`;
    used.add(key);
    return { key, label: f.label, type: f.type, required: f.required, ...(f.options && { options: f.options }), ...(f.maxLength && { maxLength: f.maxLength }) };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();

/**
 * Validate one cart line's answers against the product's current fields. Returns a snapshot (label, type, value) to store on the
 * order item, so later edits to the product never rewrite what the customer was asked or answered. Never trusts the client.
 */
export function validateCustom(fields: Field[], values: Record<string, string>, availableUploads: Set<string>): { snapshot: { label: string; type: string; value: string }[]; uploadIds: string[] } {
  const known = new Set(fields.map(f => f.key));
  for (const k of Object.keys(values)) if (!known.has(k)) throw new HttpError(422, 'custom_unknown_field');
  const snapshot: { label: string; type: string; value: string }[] = []; const uploadIds: string[] = [];
  for (const f of fields) {
    const v = clean(values[f.key] ?? '');
    if (!v) { if (f.required) throw new HttpError(422, `custom_required:${f.label}`); continue; }
    if (f.type === 'text' && v.length > (f.maxLength ?? 100)) throw new HttpError(422, `custom_too_long:${f.label}`);
    if (f.type === 'textarea' && v.length > (f.maxLength ?? 1000)) throw new HttpError(422, `custom_too_long:${f.label}`);
    if (f.type === 'select' && !f.options?.includes(v)) throw new HttpError(422, `custom_invalid_choice:${f.label}`);
    if (f.type === 'image') { if (!isUuid(v) || !availableUploads.has(v)) throw new HttpError(422, `custom_invalid_upload:${f.label}`); uploadIds.push(v); }
    snapshot.push({ label: f.label, type: f.type, value: v });
  }
  return { snapshot, uploadIds };
}
