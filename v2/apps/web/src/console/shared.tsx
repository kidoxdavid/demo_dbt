import { useState, type ReactNode } from 'react';
import { api, useApi } from '../api';
import { Button } from '../components/ui';
import { money } from '../format';
import { errText } from '../studio/fields';
import { useArea } from './ConsoleShell';

export const stamp = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
export const MAP: Record<string, string> = { exceeds_available: 'That is more than is available to pay out.', cannot_change_self: 'You cannot change your own account.', last_admin: 'There must always be at least one active admin.', role_exists: 'They already have that role.', reason_required: 'A reason is required.', not_in_queue: 'Someone already decided this one.',
  product_not_available: 'One of the chosen products is not for sale any more.', shop_not_available: 'That shop is not live.', category_not_found: 'One of the categories does not exist.', term_in_related: 'The word cannot be a synonym of itself.', seller_id_required: 'Choose a seller for that role.', seller_not_found: 'That seller does not exist.', exceeds_refundable: 'That is more than is left to refund.',
  quantity_exceeds_remaining: 'That is more than is left of that item.', shipping_already_refunded: 'Shipping was already refunded.', not_refundable: 'This order cannot be refunded.', nothing_to_refund: 'Choose something to refund.', refund_provider_error: 'The payment service did not answer. Nothing was refunded.', validation_failed: 'Please check the fields and try again.', invalid_value: 'That value is not allowed.' };
export const fail = (e: unknown) => errText(e, MAP);

export function Page({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <div className="sd-page"><div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><h1 className="serif">{title}</h1>{actions && <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>{actions}</span>}</div>{sub && <div className="sub">{sub}</div>}{children}</div>;
}
export const Stat = ({ n, l, sub }: { n: ReactNode; l: string; sub?: string }) => <div className="card sd-card" style={{ flex: 1, minWidth: 150 }}><div className="serif" style={{ fontSize: 32 }}>{n}</div><div style={{ fontWeight: 600, fontSize: 14 }}>{l}</div>{sub && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>}</div>;
export const Rows = ({ children, empty }: { children: ReactNode[] | ReactNode; empty?: string }) => (Array.isArray(children) && children.length === 0 ? <div className="empty"><p>{empty ?? 'Nothing here.'}</p></div> : <div className="card table">{children}</div>);
export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) { return <div className="tools"><input className="field" type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} /></div>; }

/** Internal notes on an order, person or seller: visible to staff only. */
export function Notes({ path, notes, onAdded }: { path: string; notes: { id: number; body: string; createdAt: string; authorEmail: string | null }[]; onAdded: () => void }) {
  const [body, setBody] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const add = async () => { setErr(''); setBusy(true); try { await api(path, { method: 'POST', body: { body: body.trim() } }); setBody(''); onAdded(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  return <div className="card sd-card" style={{ marginTop: 16 }}><b>Internal notes</b><div className="hint muted" style={{ fontSize: 12, marginTop: 2 }}>Only staff can see these.</div>
    {notes.map(n => <div key={n.id} style={{ marginTop: 10, fontSize: 14 }}><div>{n.body}</div><div className="muted" style={{ fontSize: 12 }}>{n.authorEmail ?? 'unknown'} · {stamp(n.createdAt)}</div></div>)}
    <label className="label" htmlFor="note-body">Add a note</label><textarea id="note-body" className="field" rows={2} maxLength={2000} value={body} onChange={e => setBody(e.target.value)} />{err && <div className="err" role="alert">{err}</div>}<Button size="sm" style={{ marginTop: 10 }} disabled={busy || !body.trim()} onClick={add}>Save note</Button></div>;
}

/** The audit log: who did what, when, and why. Append-only on the server. */
export function AuditPage() {
  const area = useArea(); const [action, setAction] = useState(''); const [entity, setEntity] = useState(''); const { data } = useApi<any[]>(`/api/${area}/audit?limit=100${action ? `&action=${encodeURIComponent(action)}` : ''}${entity ? `&entityType=${encodeURIComponent(entity)}` : ''}`);
  return <Page title="Audit log" sub="Every sensitive change, newest first. Entries cannot be edited or deleted.">
    <div className="tools"><input className="field" aria-label="Filter by action" placeholder="Action, e.g. payout.create" value={action} onChange={e => setAction(e.target.value.trim())} /><input className="field" aria-label="Filter by type" placeholder="Type, e.g. seller" value={entity} onChange={e => setEntity(e.target.value.trim())} /></div>
    <Rows empty="No entries match.">{(data ?? []).map(a => <div key={a.id} className="tr" style={{ alignItems: 'flex-start' }}><div className="t"><b>{a.action}</b><div>{a.entityType}{a.entityId ? ` · ${String(a.entityId).length > 30 ? String(a.entityId).slice(0, 8) : a.entityId}` : ''} · {a.actorEmail ?? 'system'} · {a.area ?? ''}</div>{a.reason && <div style={{ color: 'var(--ink)' }}>“{a.reason}”</div>}{a.next && <div style={{ wordBreak: 'break-all' }}>{JSON.stringify(a.next).slice(0, 200)}</div>}</div><span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{stamp(a.at)}</span></div>)}</Rows></Page>;
}
export const m = money;
