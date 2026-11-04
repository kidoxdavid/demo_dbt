import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError, errorText, money, toCents } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';
import { IcoBox, IcoChart, IcoCog, IcoHome, IcoTag } from '../icons';
import { SecurityPanel } from './Security';

type Me = { role: string; permissions: string[]; email: string; mfaEnabled: boolean; mfaSatisfied: boolean };
const NAV = [
  { to: '/admin', label: 'Overview', Icon: IcoHome, end: true }, { to: '/admin/review', label: 'Review queue', Icon: IcoChart }, { to: '/admin/sellers', label: 'Sellers', Icon: IcoBox }, { to: '/admin/products', label: 'Products', Icon: IcoBox },
  { to: '/admin/plans', label: 'Plans', Icon: IcoTag }, { to: '/admin/tax', label: 'Tax rates', Icon: IcoTag }, { to: '/admin/featured', label: 'Featured', Icon: IcoChart }, { to: '/admin/privacy', label: 'Privacy', Icon: IcoCog }, { to: '/admin/audit', label: 'Audit log', Icon: IcoCog },
];

/** Platform staff area. The server enforces every permission; the UI only hides what a role cannot do. */
export function AdminShell() {
  const nav = useNavigate();
  const [me, setMe] = useState<Me | null>(null); const [denied, setDenied] = useState(false);
  useEffect(() => { document.body.classList.add('seller'); return () => document.body.classList.remove('seller'); }, []);
  const loadMe = useCallback(() => api('/api/admin/me').then(setMe).catch(e => { if (e instanceof ApiError && e.status === 401) nav('/login'); else setDenied(true); }), [nav]);
  useEffect(() => { loadMe(); }, [loadMe]);
  if (denied) return <div className="wrap" style={{ paddingTop: 48 }}><h1>Staff only</h1><p className="muted">This area is for EazyStores staff. <Link to="/dashboard">Go to your seller dashboard</Link>.</p></div>;
  if (!me) return <div className="wrap"><p className="muted">Loading…</p></div>;
  const can = (p: string) => me.permissions.includes(p);
  const logout = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); nav('/'); };
  // Staff can suspend sellers and change fees, so nothing else loads until two-factor is set up and verified for this session.
  if (!me.mfaSatisfied) return <div className="wrap" style={{ maxWidth: 640, paddingTop: 48 }}>
    <span className="kicker">Staff security</span><h1 style={{ margin: '12px 0 8px' }}>{me.mfaEnabled ? 'Verify your sign-in' : 'Set up two-factor sign-in'}</h1>
    {me.mfaEnabled
      ? <><Alert kind="warn">Two-factor is on for your account, but this session has not been verified. Log out and sign in again, then enter your 6-digit code.</Alert><p><button onClick={logout}>Log out</button></p></>
      : <><p className="muted">EazyStores staff accounts must use two-factor sign-in before they can open the admin area.</p><SecurityPanel required onChange={loadMe} /><p><button className="ghost" onClick={logout}>Log out</button></p></>}
  </div>;
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
          <Route path="review" element={<AdminReview can={can} />} />
          <Route path="products" element={<AdminProducts can={can} />} />
          <Route path="privacy" element={<AdminPrivacy can={can} />} />
          <Route path="sellers" element={<AdminSellers can={can} />} />
          <Route path="plans" element={<AdminPlans can={can} />} />
          <Route path="tax" element={<AdminTax can={can} />} />
          <Route path="featured" element={<AdminFeatured can={can} />} />
          <Route path="audit" element={<AdminAudit can={can} />} />
        </Routes>
      </main>
      <nav className="tabbar" aria-label="Admin navigation" style={{ gridTemplateColumns: 'none', gridAutoFlow: 'column', gridAutoColumns: 'minmax(84px,1fr)', overflowX: 'auto' }}>
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

function AdminTax({ can }: { can: (p: string) => boolean }) {
  const [rows, setRows] = useState<any[] | null>(null); const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null);
  const load = useCallback(() => api('/api/admin/tax-rates').then(setRows).catch(e => setMsg({ k: 'err', t: errorText(e) })), []);
  useEffect(() => { load(); }, [load]);
  return <>
    <div className="pagehead"><div><h1>Tax rates</h1><p>Rates are data, not code. Every change needs a reason and records the old and new values. Starting values were entered by the developer and have not been checked against official sources: verify each one before real sales.</p></div></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    {rows && <section className="card"><div className="table-scroll"><table>
      <thead><tr><th>Province</th><th>Components</th>{can('tax.write') && <th><span className="sr-only">Edit</span></th>}</tr></thead>
      <tbody>{rows.map(r => <TaxRow key={`${r.country}-${r.region}`} r={r} editable={can('tax.write')} onSaved={() => { setMsg({ k: 'ok', t: `${r.name} updated.` }); load(); }} onError={t => setMsg({ k: 'err', t })} />)}</tbody></table></div></section>}
  </>;
}
function TaxRow({ r, editable, onSaved, onError }: { r: any; editable: boolean; onSaved: () => void; onError: (t: string) => void }) {
  const [open, setOpen] = useState(false); const [vals, setVals] = useState<string[]>(r.components.map((c: any) => (c.ppm / 10000).toString())); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await api(`/api/admin/tax-rates/${r.country}/${r.region}`, { method: 'PATCH', body: { reason, components: r.components.map((c: any, i: number) => ({ ...c, ppm: Math.round(parseFloat(vals[i]) * 10000) })) } }); setOpen(false); setReason(''); onSaved(); }
    catch (x) { onError(errorText(x)); } finally { setBusy(false); }
  }
  return <><tr><td><b>{r.name}</b> <span className="muted small">{r.region}</span></td><td>{r.components.map((c: any) => `${c.name} ${(c.ppm / 10000).toString()}%`).join(' + ')}{r.notes && <div className="muted small">{r.notes}</div>}</td>
    {editable && <td><button className="secondary sm" onClick={() => setOpen(o => !o)}>{open ? 'Close' : 'Edit'}</button></td>}</tr>
    {open && <tr><td colSpan={3}><form onSubmit={save} className="row" style={{ alignItems: 'flex-end' }}>
      {r.components.map((c: any, i: number) => <div key={c.name} style={{ flex: '0 1 140px' }}><Field label={`${c.name} (%)`}>{id => <input id={id} required inputMode="decimal" pattern="\d+(\.\d{1,4})?" value={vals[i]} onChange={e => setVals(v => v.map((x, j) => j === i ? e.target.value : x))} />}</Field></div>)}
      <div style={{ flex: '1 1 240px' }}><Field label="Reason (required)">{id => <input id={id} required minLength={5} value={reason} onChange={e => setReason(e.target.value)} />}</Field></div>
      <button disabled={busy || reason.trim().length < 5}>{busy ? 'Saving…' : 'Save rate'}</button></form></td></tr>}</>;
}

function Reasoned({ label, actions, onSubmit, onCancel }: { label: string; actions: string; onSubmit: (reason: string) => Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  return <form className="row" style={{ alignItems: 'flex-end', marginTop: 10 }} onSubmit={async e => { e.preventDefault(); setBusy(true); try { await onSubmit(reason); } finally { setBusy(false); } }}>
    <div style={{ flex: '1 1 260px' }}><Field label={label}>{id => <input id={id} required minLength={5} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />}</Field></div>
    <button disabled={busy || reason.trim().length < 5}>{busy ? 'Saving…' : actions}</button><button type="button" className="ghost" onClick={onCancel}>Cancel</button></form>;
}

function AdminReview({ can }: { can: (p: string) => boolean }) {
  const [q, setQ] = useState<any>(null); const [setting, setSetting] = useState<boolean | null>(null); const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null);
  const [act, setAct] = useState<{ kind: 'reject' | 'vdecline' | 'verify' | 'toggle'; id: string; want?: boolean } | null>(null);
  const load = useCallback(() => { api('/api/admin/review-queue').then(setQ).catch(e => setMsg({ k: 'err', t: errorText(e) })); api('/api/admin/settings').then(r => setSetting(r.storeReviewRequired)); }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setMsg(null); try { await fn(); setMsg({ k: 'ok', t: ok }); setAct(null); load(); } catch (e) { setMsg({ k: 'err', t: errorText(e) }); } };
  return <>
    <div className="pagehead"><div><h1>Review queue</h1><p>New stores waiting to go live, and verification requests. Every decision needs a reason and is recorded.</p></div></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    <section className="card"><div className="row spread"><div><h3>Require approval before stores go live</h3><p className="muted small" style={{ margin: 0 }}>{setting === null ? 'Loading…' : setting ? 'On: new stores wait here until a moderator approves them.' : 'Off: stores go live as soon as the seller publishes. Recommended on for launch.'}</p></div>
      {can('settings.write') && setting !== null && <button className="secondary sm" onClick={() => setAct({ kind: 'toggle', id: 'x', want: !setting })}>{setting ? 'Turn off' : 'Turn on'}</button>}</div>
      {act?.kind === 'toggle' && <Reasoned label="Reason for this change" actions="Confirm" onCancel={() => setAct(null)} onSubmit={r => run(() => api('/api/admin/settings/store-review', { method: 'PUT', body: { required: act.want, reason: r } }), 'Setting updated.')} />}</section>
    <h2>Stores waiting for review ({q?.stores.length ?? 0})</h2>
    {q && !q.stores.length && <section className="card"><Empty title="Nothing waiting" /></section>}
    {q?.stores.map((s: any) => <section className="card" key={s.slug}>
      <div className="row spread"><h3>{s.name}</h3><span className="muted small">{s.owner_email}</span></div>
      <p className="small" style={{ margin: '4px 0' }}><b>{s.business_name}</b> · {s.category ?? 'no category'} · {[s.city, s.region].filter(Boolean).join(', ') || 'no location'} · {s.active_products} active product(s)</p>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>{s.description ?? 'No description'}</p>
      {s.sample_products?.length > 0 && <div className="sample">{s.sample_products.map((p: any, i: number) => <div key={i} className="sample-item">{p.image ? <img src={`${p.image}?w=480`} alt="" loading="lazy" /> : <div className="sample-ph" aria-hidden />}<span>{p.name}</span><span className="muted">{p.price_cents != null ? money(p.price_cents) : ''}</span></div>)}</div>}
      <div className="row">
        {can('reviews.write') && <><button className="sm" onClick={() => run(() => api(`/api/admin/stores/${s.slug}/approve`, { body: {} }), `${s.name} approved and live.`)}>Approve</button>
          <button className="danger sm" onClick={() => setAct({ kind: 'reject', id: s.slug })}>Reject…</button></>}</div>
      {act?.kind === 'reject' && act.id === s.slug && <Reasoned label="Reason (the seller will see this)" actions="Reject store" onCancel={() => setAct(null)} onSubmit={r => run(() => api(`/api/admin/stores/${s.slug}/reject`, { body: { reason: r } }), `${s.name} sent back to draft.`)} />}
    </section>)}
    <h2>Verification requests ({q?.verifications.length ?? 0})</h2>
    {q && !q.verifications.length && <section className="card"><Empty title="No requests" /></section>}
    {q?.verifications.map((v: any) => <section className="card" key={v.tenantId}>
      <div className="row spread"><h3>{v.business_name}</h3><span className="muted small">{v.owner_email}</span></div>
      <p className="small" style={{ margin: '4px 0' }}>{String(v.legal_type).replace(/_/g, ' ')} · registration number: <b>{v.registration_number ?? 'none given'}</b></p>
      <p className="small" style={{ margin: '4px 0 10px' }}>{v.note}</p>
      {can('reviews.write') && <div className="row"><button className="sm" onClick={() => setAct({ kind: 'verify', id: v.tenantId })}>Mark verified…</button><button className="danger sm" onClick={() => setAct({ kind: 'vdecline', id: v.tenantId })}>Decline…</button></div>}
      {(act?.kind === 'verify' || act?.kind === 'vdecline') && act.id === v.tenantId && <Reasoned label="Reason (kept on record; the seller will see it)" actions={act.kind === 'verify' ? 'Verify' : 'Decline'} onCancel={() => setAct(null)}
        onSubmit={r => run(() => api(`/api/admin/verifications/${v.tenantId}/decide`, { body: { decision: act.kind === 'verify' ? 'verified' : 'rejected', reason: r } }), 'Decision recorded.')} />}
    </section>)}
  </>;
}

function AdminProducts({ can }: { can: (p: string) => boolean }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<any[] | null>(null); const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null); const [act, setAct] = useState<{ id: string; kind: 'remove' | 'restore' } | null>(null);
  const load = useCallback(() => api(`/api/admin/products?limit=60${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows).catch(e => setMsg({ k: 'err', t: errorText(e) })), [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  return <>
    <div className="pagehead"><div><h1>Products</h1><p>Search every listing. Removing a product hides it everywhere and tells the seller why.</p></div></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    <Field label="Search by product, brand, business or store address">{id => <input id={id} type="search" value={q} onChange={e => setQ(e.target.value)} />}</Field>
    {rows && !rows.length && <section className="card" style={{ marginTop: 16 }}><Empty title="No products found" /></section>}
    {rows && rows.length > 0 && <section className="card" style={{ marginTop: 16 }}><div className="table-scroll"><table><thead><tr><th>Product</th><th>Store</th><th>Status</th>{can('reviews.write') && <th><span className="sr-only">Actions</span></th>}</tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td><b>{r.name}</b><div className="muted small">{r.brand}{r.price_cents != null ? ` · from ${money(r.price_cents)}` : ''}</div></td><td className="small">{r.business_name}<div className="muted">/store/{r.store_slug}</div></td>
        <td><Badge s={r.status} />{r.moderation_reason && <div className="muted small" style={{ maxWidth: 220 }}>{r.moderation_reason}</div>}</td>
        {can('reviews.write') && <td>{r.status === 'removed' ? <button className="secondary sm" onClick={() => setAct({ id: r.id, kind: 'restore' })}>Restore</button> : <button className="danger sm" onClick={() => setAct({ id: r.id, kind: 'remove' })}>Remove</button>}</td>}</tr>)}</tbody></table></div></section>}
    {act && <section className="card"><h3>{act.kind === 'remove' ? 'Remove this product' : 'Restore this product (as a draft)'}</h3>
      <Reasoned label={act.kind === 'remove' ? 'Reason (the seller will see this)' : 'Reason for restoring'} actions={act.kind === 'remove' ? 'Remove product' : 'Restore'} onCancel={() => setAct(null)}
        onSubmit={async r => { try { await api(`/api/admin/products/${act.id}/${act.kind}`, { body: { reason: r } }); setMsg({ k: 'ok', t: act.kind === 'remove' ? 'Product removed and the seller was told.' : 'Product restored as a draft.' }); setAct(null); load(); } catch (e) { setMsg({ k: 'err', t: errorText(e) }); } }} /></section>}
  </>;
}

function AdminPrivacy({ can }: { can: (p: string) => boolean }) {
  const [email, setEmail] = useState(''); const [reason, setReason] = useState(''); const [confirm, setConfirm] = useState(false); const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null); const [busy, setBusy] = useState(false);
  if (!can('privacy.write')) return <Alert kind="warn">Your role cannot perform privacy erasures.</Alert>;
  async function run(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { const r = await api('/api/admin/privacy/erase-customer', { body: { email, reason } }); setMsg({ k: 'ok', t: `Erased personal details on ${r.orders} order(s), ${r.emails} stored email(s) and ${r.uploads} uploaded photo(s). Amounts and dates were kept for accounting.` }); setEmail(''); setReason(''); setConfirm(false); }
    catch (x) { setMsg({ k: 'err', t: errorText(x) }); } finally { setBusy(false); }
  }
  return <>
    <div className="pagehead"><div><h1>Privacy erasure</h1><p>Handle a customer's request to erase their personal details from past orders.</p></div></div>
    <Alert kind="warn">This cannot be undone. Names, emails, delivery addresses, customisation answers and photos are replaced or deleted. Order amounts, dates, items and the ledger stay, because accounting records must be kept. It is refused while any of the customer's orders is still being fulfilled. Check the request is genuine first.</Alert>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    <form className="card" onSubmit={run}>
      <Field label="Customer email address">{id => <input id={id} type="email" required value={email} onChange={e => setEmail(e.target.value)} />}</Field>
      <Field label="Reason and how the request was verified (kept in the audit log)">{id => <textarea id={id} required minLength={5} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />}</Field>
      <label className="check"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />I have verified this request and understand it cannot be undone.</label>
      <p><button className="danger" disabled={busy || !confirm || reason.trim().length < 5}>{busy ? 'Erasing…' : 'Erase personal details'}</button></p></form>
  </>;
}
