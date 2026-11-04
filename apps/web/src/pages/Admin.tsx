import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError, errorText, money, toCents } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';
import { IcoBox, IcoChart, IcoCog, IcoHome, IcoTag } from '../icons';

type Me = { role: string; permissions: string[]; email: string };
const NAV = [
  { to: '/admin', label: 'Overview', Icon: IcoHome, end: true }, { to: '/admin/sellers', label: 'Sellers', Icon: IcoBox },
  { to: '/admin/plans', label: 'Plans', Icon: IcoTag }, { to: '/admin/featured', label: 'Featured', Icon: IcoChart }, { to: '/admin/audit', label: 'Audit log', Icon: IcoCog },
];

/** Platform staff area. The server enforces every permission; the UI only hides what a role cannot do. */
export function AdminShell() {
  const nav = useNavigate();
  const [me, setMe] = useState<Me | null>(null); const [denied, setDenied] = useState(false);
  useEffect(() => { document.body.classList.add('seller'); return () => document.body.classList.remove('seller'); }, []);
  useEffect(() => {
    api('/api/admin/me').then(setMe).catch(e => { if (e instanceof ApiError && e.status === 401) nav('/login'); else setDenied(true); });
  }, [nav]);
  if (denied) return <div className="wrap" style={{ paddingTop: 48 }}><h1>Staff only</h1><p className="muted">This area is for EazyStores staff. <Link to="/dashboard">Go to your seller dashboard</Link>.</p></div>;
  if (!me) return <div className="wrap"><p className="muted">Loading…</p></div>;
  const can = (p: string) => me.permissions.includes(p);
  const logout = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); nav('/'); };
  return <div className="app">
    <aside className="side" aria-label="Admin navigation">
      <Link to="/admin" className="plogo">Eazy<i>Stores</i></Link>
      <div className="small muted" style={{ padding: '0 12px 14px', textTransform: 'uppercase', letterSpacing: '.12em', fontSize: '.64rem' }}>Staff</div>
      {NAV.map(({ to, label, Icon, end }) => <NavLink key={to} end={end} to={to} className={({ isActive }) => `nav${isActive ? ' active' : ''}`}><Icon />{label}</NavLink>)}
      <div className="foot"><div className="small" style={{ fontWeight: 600 }}>{me.email}</div><div className="small muted" style={{ marginBottom: 10 }}>{me.role.replace('_', ' ')}</div><button className="secondary sm" onClick={logout}>Log out</button></div>
    </aside>
    <div>
      <div className="mtop"><Link to="/admin" className="plogo">Eazy<i>Stores</i> <span className="muted small">Staff</span></Link><button className="ghost sm" onClick={logout}>Log out</button></div>
      <main className="main">
        <Routes>
          <Route index element={<AdminOverview />} />
          <Route path="sellers" element={<AdminSellers can={can} />} />
          <Route path="plans" element={<AdminPlans can={can} />} />
          <Route path="featured" element={<AdminFeatured can={can} />} />
          <Route path="audit" element={<AdminAudit can={can} />} />
        </Routes>
      </main>
      <nav className="tabbar" aria-label="Admin navigation" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
        {NAV.map(({ to, label, Icon, end }) => <NavLink key={to} end={end} to={to} className={({ isActive }) => isActive ? 'active' : ''}><Icon />{label}</NavLink>)}
      </nav>
    </div>
  </div>;
}

function AdminOverview() {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { api('/api/admin/overview').then(setD).catch(e => setErr(errorText(e))); }, []);
  if (err) return <Alert kind="err">{err}</Alert>;
  if (!d) return <p className="muted">Loading…</p>;
  return <>
    <div className="pagehead"><div><h1>Platform overview</h1><p>Live figures from the database.</p></div></div>
    {d.unresolvedUnfulfilledPayments > 0 && <Alert kind="warn">{d.unresolvedUnfulfilledPayments} customer payment(s) are waiting for a seller to refund an order that could not be fulfilled.</Alert>}
    <div className="grid">
      <div className="card stat accent"><div className="n">{money(d.gmvCents)}</div><div className="l">Gross merchandise value</div></div>
      <div className="card stat"><div className="n">{money(d.platformFeesCents)}</div><div className="l">Platform fees (net of refunds)</div></div>
      <div className="card stat"><div className="n">{d.paidOrders}</div><div className="l">Paid orders</div></div>
      <div className="card stat"><div className="n">{money(d.refundsCents)}</div><div className="l">Refunded</div></div>
      <div className="card stat"><div className="n">{d.sellers.active}<span className="muted small"> / {d.sellers.total}</span></div><div className="l">Active sellers</div></div>
      <div className="card stat"><div className="n">{d.sellers.suspended}</div><div className="l">Suspended</div></div>
      <div className="card stat"><div className="n">{d.publishedStores}</div><div className="l">Published stores</div></div>
      <div className="card stat"><div className="n">{d.activeProducts}</div><div className="l">Active products</div></div>
    </div>
    <p className="muted small">{d.note} Subscription revenue is not shown because subscription billing is not built yet.</p>
  </>;
}

function AdminSellers({ can }: { can: (p: string) => boolean }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<any[] | null>(null); const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null);
  const [acting, setActing] = useState<{ id: string; kind: 'suspend' | 'reinstate' } | null>(null); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api(`/api/admin/sellers?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows).catch(e => setMsg({ k: 'err', t: errorText(e) })), [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!acting) return; setBusy(true); setMsg(null);
    try { await api(`/api/admin/sellers/${acting.id}/${acting.kind}`, { body: { reason } }); setMsg({ k: 'ok', t: acting.kind === 'suspend' ? 'Seller suspended. Their store is hidden and cannot be republished.' : 'Seller reinstated. Their store is back to draft until they republish.' }); setActing(null); setReason(''); load(); }
    catch (x) { setMsg({ k: 'err', t: errorText(x) }); } finally { setBusy(false); }
  }
  return <>
    <div className="pagehead"><div><h1>Sellers</h1><p>Review accounts, and suspend or reinstate with a recorded reason.</p></div></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    <Field label="Search by business name or store address">{id => <input id={id} type="search" value={q} onChange={e => setQ(e.target.value)} />}</Field>
    {rows && !rows.length && <section className="card" style={{ marginTop: 16 }}><Empty title="No sellers found">Try a different search.</Empty></section>}
    {rows && rows.length > 0 && <section className="card" style={{ marginTop: 16 }}><div className="table-scroll"><table>
      <thead><tr><th>Business</th><th>Owner</th><th>Store</th><th>Active products</th><th>Paid orders</th><th>Status</th>{(can('sellers.suspend')) && <th><span className="sr-only">Actions</span></th>}</tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}>
        <td><b>{r.business_name}</b><div className="muted small">{r.category ?? '—'}</div></td><td className="small">{r.owner_email}</td>
        <td className="small">{r.slug ? <a href={`/store/${r.slug}`} target="_blank" rel="noreferrer">/store/{r.slug}</a> : '—'}<div><Badge s={r.store_status ?? 'draft'} /></div></td>
        <td>{r.active_products}</td><td>{r.paid_orders}</td>
        <td><Badge s={r.status} />{r.suspended_reason && <div className="muted small" style={{ maxWidth: 220 }}>{r.suspended_reason}</div>}</td>
        {can('sellers.suspend') && <td>{r.status === 'active' ? <button className="danger sm" onClick={() => { setActing({ id: r.id, kind: 'suspend' }); setReason(''); }}>Suspend</button>
          : r.status === 'suspended' ? <button className="secondary sm" onClick={() => { setActing({ id: r.id, kind: 'reinstate' }); setReason(''); }}>Reinstate</button> : null}</td>}
      </tr>)}</tbody></table></div></section>}
    {acting && <section className="card" aria-live="polite"><h3>{acting.kind === 'suspend' ? 'Suspend this seller' : 'Reinstate this seller'}</h3>
      <form onSubmit={submit}><Field label="Reason (required, kept in the audit log)" hint={acting.kind === 'suspend' ? 'Their store will be hidden from the marketplace and customers.' : 'Their store returns to draft; they must republish it.'}>
        {id => <textarea id={id} required minLength={5} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />}</Field>
        <div className="row" style={{ marginTop: 12 }}><button disabled={busy || reason.trim().length < 5}>{busy ? 'Saving…' : acting.kind === 'suspend' ? 'Suspend seller' : 'Reinstate seller'}</button><button type="button" className="ghost" onClick={() => setActing(null)}>Cancel</button></div></form></section>}
  </>;
}

function AdminPlans({ can }: { can: (p: string) => boolean }) {
  const [plans, setPlans] = useState<any[] | null>(null); const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null);
  const load = useCallback(() => api('/api/admin/plans').then(setPlans).catch(e => setMsg({ k: 'err', t: errorText(e) })), []);
  useEffect(() => { load(); }, [load]);
  return <>
    <div className="pagehead"><div><h1>Plans</h1><p>Prices and fees are placeholders until the commercial model is decided. Every change needs a reason and is recorded with the old and new values.</p></div></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    {plans?.map(p => <PlanCard key={p.code} p={p} editable={can('plans.write')} onSaved={() => { setMsg({ k: 'ok', t: `${p.name} updated.` }); load(); }} onError={t => setMsg({ k: 'err', t })} />)}
  </>;
}
function PlanCard({ p, editable, onSaved, onError }: { p: any; editable: boolean; onSaved: () => void; onError: (t: string) => void }) {
  const [m, setM] = useState((p.price_monthly_cents / 100).toFixed(2)); const [a, setA] = useState((p.price_annual_cents / 100).toFixed(2)); const [fee, setFee] = useState((p.transaction_fee_bps / 100).toFixed(2)); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const changed = toCents(m) !== p.price_monthly_cents || toCents(a) !== p.price_annual_cents || Math.round(parseFloat(fee || '0') * 100) !== p.transaction_fee_bps;
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await api(`/api/admin/plans/${p.code}`, { method: 'PATCH', body: { priceMonthlyCents: toCents(m), priceAnnualCents: toCents(a), transactionFeeBps: Math.round(parseFloat(fee || '0') * 100), reason } }); setReason(''); onSaved(); }
    catch (x) { onError(errorText(x)); } finally { setBusy(false); }
  }
  return <section className="card"><div className="row spread"><h3>{p.name}</h3><span className="muted small">{p.code} · limits {Object.entries(p.limits).map(([k, v]) => `${k.replace('_', ' ')}: ${v ?? 'unlimited'}`).join(', ')}</span></div>
    <form onSubmit={save}><div className="row" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 130px' }}><Field label="Monthly ($)">{id => <input id={id} disabled={!editable} inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={m} onChange={e => setM(e.target.value)} />}</Field></div>
      <div style={{ flex: '1 1 130px' }}><Field label="Annual ($)">{id => <input id={id} disabled={!editable} inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={a} onChange={e => setA(e.target.value)} />}</Field></div>
      <div style={{ flex: '1 1 130px' }}><Field label="Transaction fee (%)" hint="Of the item subtotal.">{id => <input id={id} disabled={!editable} inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={fee} onChange={e => setFee(e.target.value)} />}</Field></div></div>
      {editable && changed && <><Field label="Reason for this change (required)">{id => <input id={id} required minLength={5} value={reason} onChange={e => setReason(e.target.value)} />}</Field>
        <p><button disabled={busy || reason.trim().length < 5}>{busy ? 'Saving…' : 'Save plan'}</button></p></>}
      {!editable && <p className="muted small">Your role cannot edit plans.</p>}</form></section>;
}

function AdminFeatured({ can }: { can: (p: string) => boolean }) {
  const [rows, setRows] = useState<any[]>([]); const [cur, setCur] = useState<string | null>(null); const [pick, setPick] = useState(''); const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api('/api/admin/featured').then(r => { setCur(r.slug); setPick(r.slug ?? ''); }); api('/api/admin/sellers?limit=100').then(r => setRows(r.filter((x: any) => x.store_status === 'published' && x.status === 'active' && x.active_products > 0))); }, []);
  useEffect(() => { load(); }, [load]);
  async function save(slug: string | null) {
    setBusy(true); setMsg(null);
    try { await api('/api/admin/featured', { method: 'PUT', body: { slug, reason } }); setMsg({ k: 'ok', t: slug ? 'Featured maker updated.' : 'Featured maker cleared. The newest store now leads.' }); setReason(''); load(); }
    catch (x) { setMsg({ k: 'err', t: errorText(x) }); } finally { setBusy(false); }
  }
  const editable = can('settings.write');
  return <>
    <div className="pagehead"><div><h1>Featured maker</h1><p>The store that leads the marketplace home. It is an editorial choice: a plan or payment cannot buy it.</p></div></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    <section className="card"><p>Currently: <b>{cur ?? 'none chosen (the newest store leads)'}</b></p>
      <Field label="Store">{id => <select id={id} disabled={!editable} value={pick} onChange={e => setPick(e.target.value)}><option value="">Choose a store…</option>{rows.map(r => <option key={r.slug} value={r.slug}>{r.business_name} ({r.slug})</option>)}</select>}</Field>
      <Field label="Reason (required)">{id => <input id={id} disabled={!editable} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Editors' pick for the holiday season" />}</Field>
      {editable ? <div className="row" style={{ marginTop: 14 }}><button disabled={busy || !pick || reason.trim().length < 5} onClick={() => save(pick)}>Feature this store</button>
        {cur && <button className="secondary" disabled={busy || reason.trim().length < 5} onClick={() => save(null)}>Clear</button>}</div> : <p className="muted small">Your role cannot change this.</p>}</section>
  </>;
}

function AdminAudit({ can }: { can: (p: string) => boolean }) {
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState('');
  useEffect(() => { if (can('audit.read')) api('/api/admin/audit').then(setRows).catch(e => setErr(errorText(e))); }, [can]);
  if (!can('audit.read')) return <Alert kind="warn">Your role cannot view the audit log.</Alert>;
  if (err) return <Alert kind="err">{err}</Alert>;
  const brief = (v: any) => v == null ? '' : JSON.stringify(v).slice(0, 160);
  return <>
    <div className="pagehead"><div><h1>Audit log</h1><p>The most recent 100 actions. Entries cannot be edited or deleted.</p></div></div>
    {rows && !rows.length && <section className="card"><Empty title="Nothing recorded yet" /></section>}
    {rows && rows.length > 0 && <section className="card"><div className="table-scroll"><table><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Reason</th><th>Change</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleString()}</td><td><b>{r.action}</b></td><td className="small">{r.entity_type}{r.entity_id ? ` · ${String(r.entity_id).slice(0, 8)}` : ''}</td>
        <td className="small">{r.reason ?? '—'}</td><td className="small muted" style={{ maxWidth: 320, wordBreak: 'break-word' }}>{r.previous_value && <div>was {brief(r.previous_value)}</div>}{r.new_value && <div>now {brief(r.new_value)}</div>}</td></tr>)}</tbody></table></div></section>}
  </>;
}
