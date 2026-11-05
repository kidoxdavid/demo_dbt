import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useApi } from '../api';
import { ProductArt } from '../art/ProductArt';
import { Button, Chip } from '../components/ui';
import { money } from '../format';
import { useConsole } from './ConsoleShell';
import { Notes, Page, Rows, SearchBar, Stat, fail, stamp } from './shared';

const ROLES = ['admin', 'support', 'finance', 'catalogue', 'marketing'];

export function AdminOverview() {
  const { data: o } = useApi<any>('/api/admin/overview'); const { data: q } = useApi<any[]>('/api/admin/moderation');
  if (!o) return <div className="skeleton" style={{ height: 200 }} />;
  return <Page title="Overview" sub="The whole marketplace at a glance.">
    <div style={{ display: 'flex', gap: 16, marginTop: 18, flexWrap: 'wrap' }}><Stat n={o.users.n} l="People" sub={`${o.users.new7} new this week`} /><Stat n={o.sellers.active} l="Active sellers" sub={`${o.sellers.live} shops live`} /><Stat n={o.products.published} l="Live products" /><Stat n={o.orders30d.orders} l="Orders, 30 days" sub={`${money(o.orders30d.gmv)} total paid`} /></div>
    <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap' }}><Link to="/admin/moderation" className="card sd-card" style={{ flex: 1, minWidth: 220 }}><div className="serif" style={{ fontSize: 32 }}>{q?.length ?? o.products.queued}</div><b>In the review queue</b><div className="muted" style={{ fontSize: 12 }}>Products in restricted categories waiting for a decision</div></Link>
      <div className="card sd-card" style={{ flex: 1, minWidth: 220 }}><div className="serif" style={{ fontSize: 32 }}>{o.orders30d.open}</div><b>Orders still to ship</b><div className="muted" style={{ fontSize: 12 }}>Across all sellers</div></div></div></Page>;
}

export function PeoplePage() {
  const [term, setTerm] = useState(''); const { data } = useApi<any[]>(`/api/admin/users?limit=50${term ? `&q=${encodeURIComponent(term)}` : ''}`);
  return <Page title="People" sub="Buyers, sellers and staff. Open a person to manage their roles."><SearchBar value={term} onChange={setTerm} placeholder="Search by name or email" />
    <Rows empty="Nobody matches.">{(data ?? []).map(u => <Link key={u.id} to={`/admin/users/${u.id}`} className="tr"><div className="t"><b>{u.fullName}</b><div>{u.email} · joined {stamp(u.createdAt)}</div></div>{u.roles.map((r: any) => <Chip key={r.id} variant="outline">{r.role.replace('_', ' ')}</Chip>)}{u.status === 'disabled' && <Chip>Disabled</Chip>}</Link>)}</Rows></Page>;
}

export function PersonPage() {
  const { id = '' } = useParams(); const { user: me } = useConsole(); const { data: u, reload, error } = useApi<any>(`/api/admin/users/${id}`); const [role, setRole] = useState('support'); const [sellerId, setSellerId] = useState(''); const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (error) return <div className="empty"><h2 className="serif">We could not find that person</h2></div>; if (!u) return <div className="skeleton" style={{ height: 200 }} />;
  const run = async (fn: () => Promise<unknown>) => { setErr(''); setBusy(true); try { await fn(); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  const isSeller = (r: string) => r.startsWith('seller_');
  return <Page title={u.fullName} sub={<>{u.email} · joined {stamp(u.createdAt)} · {u.status === 'active' ? 'active' : 'disabled'}</>} actions={<Link to="/admin/users" className="btn ghost sm">Back</Link>}>
    <div className="card sd-card" style={{ marginTop: 16 }}><b>Roles</b>{u.roles.length === 0 && <p className="muted" style={{ fontSize: 14, marginTop: 6 }}>A buyer, no special roles.</p>}
      {u.roles.map((r: any) => <div key={r.id} className="tr" style={{ borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }}><span style={{ flex: 1, fontSize: 14 }}>{r.role.replace('_', ' ')}{r.sellerId ? ` · seller ${String(r.sellerId).slice(0, 8)}` : ''}</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`/api/admin/users/${id}/roles/${r.id}`, { method: 'DELETE' }))}>Remove</Button></div>)}
      <div className="two" style={{ marginTop: 14 }}><div><label className="label" htmlFor="gr-role">Give a role</label><select id="gr-role" className="field" value={role} onChange={e => setRole(e.target.value)}>{[...ROLES, 'seller_owner', 'seller_manager', 'seller_staff'].map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select></div>
        {isSeller(role) && <div><label className="label" htmlFor="gr-seller">Seller id</label><input id="gr-seller" className="field" value={sellerId} onChange={e => setSellerId(e.target.value.trim())} placeholder="Seller id from the sellers list" /></div>}</div>
      <Button size="sm" style={{ marginTop: 12 }} disabled={busy || (isSeller(role) && !sellerId)} onClick={() => run(() => api(`/api/admin/users/${id}/roles`, { method: 'POST', body: { role, ...(isSeller(role) ? { sellerId } : {}) } }))}>Give role</Button></div>
    {u.id !== me?.id && <div className="card sd-card" style={{ marginTop: 16 }}><b>{u.status === 'active' ? 'Disable this account' : 'Re-enable this account'}</b><p className="muted" style={{ fontSize: 13, marginTop: 4 }}>{u.status === 'active' ? 'They are signed out everywhere and cannot sign in again until re-enabled.' : 'They will be able to sign in again.'}</p>
      <label className="label" htmlFor="du-why">Reason (kept in the audit log)</label><input id="du-why" className="field" value={reason} onChange={e => setReason(e.target.value)} /><Button size="sm" style={{ marginTop: 12 }} disabled={busy || reason.trim().length < 3} onClick={() => run(async () => { await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'disabled' : 'active', reason: reason.trim() } }); setReason(''); })}>{u.status === 'active' ? 'Disable' : 'Re-enable'}</Button></div>}
    {err && <div className="err" role="alert">{err}</div>}
    <h2 className="serif" style={{ fontSize: 20, marginTop: 24 }}>Orders</h2><Rows empty="No orders.">{u.orders.map((o: any) => <div key={o.id} className="tr"><div className="t"><b>#{o.number}</b><div>{stamp(o.createdAt)} · {o.paymentStatus.replace('_', ' ')}</div></div><b>{money(o.totalCents)}</b></div>)}</Rows>
    <Notes path={`/api/admin/users/${id}/notes`} notes={u.notes} onAdded={reload} /></Page>;
}

export function SellersPage() {
  const [term, setTerm] = useState(''); const [status, setStatus] = useState(''); const { data } = useApi<any[]>(`/api/admin/sellers?limit=50${term ? `&q=${encodeURIComponent(term)}` : ''}${status ? `&status=${status}` : ''}`);
  return <Page title="Sellers" sub="Businesses selling on eazystores."><SearchBar value={term} onChange={setTerm} placeholder="Search by business, shop or owner email" />
    <div className="seg" role="tablist">{[['', 'All'], ['active', 'Active'], ['suspended', 'Suspended'], ['closed', 'Closed']].map(([v, l]) => <button key={v} role="tab" aria-selected={status === v} className={status === v ? 'on' : ''} onClick={() => setStatus(v)}>{l}</button>)}</div>
    <Rows empty="No sellers match.">{(data ?? []).map(s => <Link key={s.id} to={`/admin/sellers/${s.id}`} className="tr"><div className="t"><b>{s.shops[0]?.name ?? s.legalName}</b><div>{s.legalName} · {s.ownerEmail ?? 'no owner'} · {s.liveProducts} live products</div></div><b>{money(s.salesCents)}</b>{s.status !== 'active' ? <Chip>{s.status}</Chip> : s.verificationTier === 'verified_maker' ? <Chip variant="ok">Verified maker</Chip> : null}</Link>)}</Rows></Page>;
}

export function SellerPage() {
  const { id = '' } = useParams(); const { data: s, reload, error } = useApi<any>(`/api/admin/sellers/${id}`); const [status, setStatus] = useState(''); const [tier, setTier] = useState(''); const [bps, setBps] = useState<string | null>(null); const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState('');
  if (error) return <div className="empty"><h2 className="serif">We could not find that seller</h2></div>; if (!s) return <div className="skeleton" style={{ height: 200 }} />;
  const st = status || s.status, tr = tier || s.verificationTier; const cur = bps ?? (s.commissionBps === null ? '' : String(s.commissionBps / 100)); const bpsVal = cur.trim() === '' ? null : Math.round(Number(cur) * 100);
  const changed = st !== s.status || tr !== s.verificationTier || bpsVal !== s.commissionBps;
  const save = async () => { setErr(''); setSaved(''); setBusy(true); try { await api(`/api/admin/sellers/${id}`, { method: 'PATCH', body: { ...(st !== s.status ? { status: st } : {}), ...(tr !== s.verificationTier ? { verificationTier: tr } : {}), ...(bpsVal !== s.commissionBps ? { commissionBps: bpsVal } : {}), reason: reason.trim() } }); setStatus(''); setTier(''); setBps(null); setReason(''); setSaved('Saved.'); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  return <Page title={s.shops[0]?.name ?? s.legalName} sub={<>{s.legalName} · {s.ownerEmail ?? 'no owner'} · {s.liveProducts} live products · {money(s.salesCents)} sold</>} actions={<Link to="/admin/sellers" className="btn ghost sm">Back</Link>}>
    <div className="card sd-card form" style={{ marginTop: 16 }}><b>Standing</b>
      <label className="label" htmlFor="sl-st">Status</label><select id="sl-st" className="field" value={st} onChange={e => setStatus(e.target.value)}><option value="active">Active</option><option value="suspended">Suspended (shop hidden, no sales)</option><option value="closed">Closed</option></select>
      <label className="label" htmlFor="sl-tier">Verification</label><select id="sl-tier" className="field" value={tr} onChange={e => setTier(e.target.value)}><option value="basic">Basic</option><option value="payout_verified">Payout verified</option><option value="verified_maker">Verified maker</option></select>
      <label className="label" htmlFor="sl-bps">Commission override (%), empty = platform rate</label><input id="sl-bps" className="field" inputMode="decimal" value={cur} onChange={e => setBps(e.target.value)} />
      <label className="label" htmlFor="sl-why">Reason (kept in the audit log)</label><input id="sl-why" className="field" value={reason} onChange={e => setReason(e.target.value)} />
      {err && <div className="err" role="alert">{err}</div>}{saved && <div className="saved" role="status" style={{ color: 'var(--ok)' }}>{saved}</div>}<Button style={{ marginTop: 14 }} disabled={busy || !changed || reason.trim().length < 3} onClick={save}>Save changes</Button></div>
    <div className="card sd-card" style={{ marginTop: 16 }}><b>Shops</b>{s.shops.map((x: any) => <div key={x.slug} style={{ fontSize: 14, marginTop: 6 }}><Link to={`/shop/${x.slug}`} style={{ textDecoration: 'underline' }}>{x.name}</Link> · {x.status}</div>)}<b style={{ display: 'block', marginTop: 14 }}>Team</b>{s.team.map((t: any) => <div key={t.id} style={{ fontSize: 14, marginTop: 6 }}><Link to={`/admin/users/${t.userId}`} style={{ textDecoration: 'underline' }}>{t.fullName}</Link> · {t.role.replace('_', ' ')} · {t.email}</div>)}<div className="muted" style={{ fontSize: 12, marginTop: 10 }}>Seller id: {s.id}</div></div>
    <h2 className="serif" style={{ fontSize: 20, marginTop: 24 }}>History</h2><Rows empty="No staff actions yet.">{s.history.map((h: any, i: number) => <div key={i} className="tr"><div className="t"><b>{h.action}</b><div>{h.actorEmail ?? 'system'}{h.reason ? ` · “${h.reason}”` : ''}</div></div><span className="muted" style={{ fontSize: 12 }}>{stamp(h.at)}</span></div>)}</Rows>
    <Notes path={`/api/admin/sellers/${id}/notes`} notes={s.notes} onAdded={reload} /></Page>;
}

export function ModerationPage() {
  const { data, reload } = useApi<any[]>('/api/admin/moderation'); const [open, setOpen] = useState<string | null>(null); const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const decide = async (id: string, decision: 'approve' | 'remove') => { setErr(''); setBusy(true); try { await api(`/api/admin/moderation/${id}`, { method: 'POST', body: { decision, ...(decision === 'remove' ? { reason: reason.trim() } : {}) } }); setOpen(null); setReason(''); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  return <Page title="Review queue" sub="Products in restricted categories go live straight away and wait here to be checked. Approve them, or remove them with a reason.">
    {err && <div className="err" role="alert">{err}</div>}
    <Rows empty="The queue is empty. Nothing is waiting for review.">{(data ?? []).map(p => <div key={p.id} className="tr" style={{ flexWrap: 'wrap' }}><div style={{ width: 52, height: 52, borderRadius: 10, overflow: 'hidden', flex: 'none' }}>{p.image ? <img src={p.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : p.art ? <ProductArt kind={p.art.kind} tone={p.art.tone} /> : null}</div>
      <div className="t"><b><Link to={`/p/${p.id}`} style={{ textDecoration: 'underline' }}>{p.title}</Link></b><div>{p.shop} · {p.category} · {p.priceCents ? money(p.priceCents) : 'no price'} · {stamp(p.updatedAt)}</div></div>
      <Button size="sm" disabled={busy} onClick={() => decide(p.id, 'approve')}>Approve</Button><Button size="sm" variant="ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>Remove…</Button>
      {open === p.id && <div style={{ flexBasis: '100%', display: 'flex', gap: 10 }}><input className="field" aria-label="Reason for removing" placeholder="Reason (the seller is told)" value={reason} onChange={e => setReason(e.target.value)} /><Button size="sm" disabled={busy || reason.trim().length < 3} onClick={() => decide(p.id, 'remove')}>Remove product</Button></div>}</div>)}</Rows></Page>;
}

export function SettingsPage() {
  const { data: settings, reload } = useApi<any[]>('/api/admin/settings'); const { data: flags, reload: reloadFlags } = useApi<Record<string, boolean>>('/api/admin/flags'); const [edit, setEdit] = useState<string | null>(null); const [val, setVal] = useState(''); const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const start = (s: any) => { setEdit(s.key); setVal(JSON.stringify(s.value)); setReason(''); setErr(''); };
  const save = async () => { setErr(''); setBusy(true); try { let v: unknown; try { v = JSON.parse(val); } catch { setErr('That is not valid. Text needs quotes, for example "atelier".'); return; } await api(`/api/admin/settings/${edit}`, { method: 'PUT', body: { value: v, reason: reason.trim() || undefined } }); setEdit(null); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  const flag = async (key: string, enabled: boolean) => { try { await api(`/api/admin/flags/${key}`, { method: 'PUT', body: { enabled } }); reloadFlags(); } catch (e) { setErr(fail(e)); } };
  return <Page title="Settings" sub="Business rules live here, not in code. Every change is checked and written to the audit log.">
    <h2 className="serif" style={{ fontSize: 20, marginTop: 20 }}>Rules</h2><Rows>{(settings ?? []).map(s => <div key={s.key} className="tr" style={{ alignItems: 'flex-start' }}><div className="t"><b>{s.key}</b><div>{s.help}</div><code style={{ fontSize: 12, wordBreak: 'break-all' }}>{JSON.stringify(s.value).slice(0, 160)}</code></div><Button size="sm" variant="ghost" onClick={() => start(s)}>Change</Button></div>)}</Rows>
    {edit && <div className="card sd-card form" style={{ marginTop: 16 }}><b>{edit}</b><label className="label" htmlFor="st-val">New value (JSON)</label><textarea id="st-val" className="field" rows={4} value={val} onChange={e => setVal(e.target.value)} /><label className="label" htmlFor="st-why">Reason</label><input id="st-why" className="field" value={reason} onChange={e => setReason(e.target.value)} />
      {err && <div className="err" role="alert">{err}</div>}<div style={{ display: 'flex', gap: 10, marginTop: 14 }}><Button disabled={busy} onClick={save}>Save</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div></div>}
    <h2 className="serif" style={{ fontSize: 20, marginTop: 24 }}>Features</h2><Rows>{Object.entries(flags ?? {}).map(([k, on]) => <label key={k} className="tr" style={{ cursor: 'pointer' }}><div className="t"><b>{k.replace(/_/g, ' ')}</b></div><input type="checkbox" checked={on} onChange={e => flag(k, e.target.checked)} aria-label={`${k} on`} style={{ width: 20, height: 20, accentColor: 'var(--acc)' }} /></label>)}</Rows>
    {!edit && err && <div className="err" role="alert">{err}</div>}</Page>;
}
