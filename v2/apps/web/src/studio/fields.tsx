import { useState } from 'react';
import { ApiError, api } from '../api';

export interface AttrDef { key: string; label: string; type: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'boolean'; required?: boolean; unit?: string | null; options?: { value: string; label: string }[] | null; help?: string | null }
/** Upload one image or video to the seller's media library (raw body; the server decides the real type from the first bytes). */
export async function uploadMedia(file: File): Promise<{ id: string; kind: string; url: string }> {
  const r = await fetch('/api/studio/media', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'upload_failed', j); return { id: j.id, kind: j.kind, url: j.kind === 'video' ? `/api/studio/media/${j.id}/poster` : `/api/studio/media/${j.id}/w640` };
}
export const UPLOAD_ERRORS: Record<string, string> = { unsupported_file_type: 'That file type is not supported. Use JPG, PNG, WebP, MP4 or WebM.', file_too_large: 'That file is too large.', body_too_large: 'That file is too large.', corrupt_media: 'We could not read that file. Try another.', video_too_long: 'That video is too long.' };
export const dollars = (c: number | null | undefined) => (c || c === 0 ? (c / 100).toFixed(2) : '');
export const cents = (v: string) => { const n = Number(v.replace(/[$,\s]/g, '')); return Number.isFinite(n) && n >= 0 && v.trim() !== '' ? Math.round(n * 100) : null; };
export const errText = (e: unknown, map: Record<string, string> = {}) => (e instanceof ApiError ? map[e.code] ?? map[e.code.split(':')[0]] ?? UPLOAD_ERRORS[e.code] ?? (e.status === 403 ? 'You do not have permission to do that.' : e.status === 429 ? 'Too many tries. Wait a minute.' : 'Something went wrong. Try again.') : 'Something went wrong. Try again.');

/** Category attribute inputs (technique, material, size, hair origin and so on). Which ones are needed comes from the category, never from the browser. */
export function AttributeFields({ defs, value, onChange, only }: { defs: AttrDef[]; value: Record<string, unknown>; onChange: (key: string, v: unknown) => void; only?: (d: AttrDef) => boolean }) {
  return <>{defs.filter(d => !only || only(d)).map(d => { const v = value[d.key]; const id = `attr-${d.key}`; const label = <label className="label" htmlFor={id}>{d.label}{d.unit ? ` (${d.unit})` : ''}{d.required ? '' : ' (optional)'}</label>;
    if (d.type === 'boolean') return <label key={d.key} className="tgl"><input type="checkbox" checked={v === true} onChange={e => onChange(d.key, e.target.checked)} />{d.label}</label>;
    if (d.type === 'select') return <div key={d.key}>{label}<select id={id} className="field" value={(v as string) ?? ''} onChange={e => onChange(d.key, e.target.value || undefined)}><option value="">Choose…</option>{(d.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>;
    if (d.type === 'multiselect') return <fieldset key={d.key} style={{ border: 0 }}><legend className="label">{d.label}{d.required ? '' : ' (optional)'}</legend>{(d.options ?? []).map(o => { const cur = (Array.isArray(v) ? v : []) as string[]; return <label key={o.value} className="tgl"><input type="checkbox" checked={cur.includes(o.value)} onChange={e => onChange(d.key, e.target.checked ? [...cur, o.value] : cur.filter(x => x !== o.value))} />{o.label}</label>; })}</fieldset>;
    if (d.type === 'number') return <div key={d.key}>{label}<input id={id} className="field" inputMode="decimal" value={v === undefined ? '' : String(v)} onChange={e => onChange(d.key, e.target.value === '' ? undefined : Number(e.target.value))} /></div>;
    return <div key={d.key}>{label}<input id={id} className="field" value={(v as string) ?? ''} onChange={e => onChange(d.key, e.target.value || undefined)} />{d.help && <div className="hint">{d.help}</div>}</div>; })}</>;
}
export function useSaved<T>(save: (v: T) => Promise<unknown>) {
  const [state, set] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'); const run = async (v: T) => { set('saving'); try { await save(v); set('saved'); } catch { set('error'); } }; return [state, run] as const;
}
void api;
