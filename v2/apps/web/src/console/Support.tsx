import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useApi } from '../api';
import { Button, Chip } from '../components/ui';
import { money } from '../format';
import { useArea } from './ConsoleShell';
import { Notes, Page, Rows, SearchBar, fail, stamp } from './shared';

const statusChip = (s: string) => (s === 'paid' ? <Chip variant="ok">Paid</Chip> : <Chip variant="outline">{s.replace('_', ' ')}</Chip>);

/** Order lookup for support and finance: by order number, buyer name or email. */
export function OrderSearch({ refundHint }: { refundHint?: boolean }) {
  const area = useArea(); const [term, setTerm] = useState(''); const { data } = useApi<any[]>(`/api/${area}/orders?limit=50${term.trim() ? `&q=${encodeURIComponent(term.trim())}` : ''}`);
  return <Page title={area === 'finance' ? 'Orders and refunds' : 'Orders'} sub="Find an order by number (for example 10042), buyer name or email."><SearchBar value={term} onChange={setTerm} placeholder="Order number, name or email" />
    <Rows empty="No orders match.">{(data ?? []).map(o => <Link key={o.id} to={`/${area}/orders/${o.id}`} className="tr"><div className="t"><b>#{o.number} · {o.buyerName}</b><div>{o.email} · {stamp(o.createdAt)}</div></div><b>{money(o.totalCents)}</b>{statusChip(o.paymentStatus)}</Link>)}</Rows>{refundHint && null}</Page>;
}

export function OrderView() {
  const area = useArea(); const { id = '' } = useParams(); const { data: o, reload, error } = useApi<any>(`/api/${area}/orders/${id}`); const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [refunding, setRefunding] = useState<string | null>(null);
  if (error) return <div className="empty"><h2 className="serif">We could not find that order</h2></div>; if (!o) return <div className="skeleton" style={{ height: 240 }} />;
  const resend = async () => { setErr(''); setMsg(''); setBusy(true); try { await api(`/api/support/orders/${id}/resend-confirmation`, { method: 'POST', body: {} }); setMsg('Confirmation email queued.'); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  return <Page title={`Order #${o.number}`} sub={<>{stamp(o.createdAt)} · {statusChip(o.paymentStatus)}</>} actions={<Link to={`/${area}${area === 'finance' ? '/orders' : ''}`} className="btn ghost sm">Back</Link>}>
    <div className="card sd-card" style={{ marginTop: 16 }}><b>Buyer</b><p style={{ fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>{o.buyerName} · {o.email}<br />{o.shipTo.line1}{o.shipTo.line2 ? `, ${o.shipTo.line2}` : ''}, {o.shipTo.city}, {o.shipTo.region} {o.shipTo.postal}</p>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 8 }}><span className="muted">Items {money(o.itemsCents)} · Shipping {money(o.shippingCents)} · GST {money(o.taxCents)}</span><b>{money(o.totalCents)}</b></div></div>
    {o.sellers.map((s: any) => <div key={s.id} className="card sd-card" style={{ marginTop: 16 }}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><b style={{ flex: 1 }}>{s.shop.name}</b><Chip variant="outline">{s.status.replace('_', ' ')}</Chip>{area === 'finance' && ['paid', 'partially_refunded'].includes(o.paymentStatus) && <Button size="sm" variant="ghost" onClick={() => setRefunding(refunding === s.id ? null : s.id)}>Refund…</Button>}</div>
      {s.lines.map((l: any) => <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 8 }}><span>{l.title}{l.variant ? ` · ${l.variant}` : ''} × {l.quantity}{l.refundedQty ? ` (${l.refundedQty} refunded)` : ''}</span><b style={{ fontWeight: 500 }}>{money(l.unitCents * l.quantity)}</b></div>)}
      <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>Commission {money(s.commissionCents)} · Refunded {money(s.refundedCents)}{s.tracking ? ` · ${s.tracking.carrier.replace('_', ' ')} ${s.tracking.number}` : ''}</div>
      {refunding === s.id && <RefundForm seller={s} onDone={() => { setRefunding(null); reload(); }} />}</div>)}
    <div className="card sd-card" style={{ marginTop: 16 }}><b>Payments and refunds</b>{o.payments.map((p: any) => <div key={p.id} style={{ fontSize: 14, marginTop: 8 }}>{money(p.amountCents)} · {p.status} · {p.provider} · <code style={{ fontSize: 12 }}>{p.providerRef}</code></div>)}{o.refunds.map((r: any) => <div key={r.id} style={{ fontSize: 14, marginTop: 8 }}>Refund {money(r.amountCents)} · {r.status} · “{r.reason}” · {r.byEmail ?? 'seller'} · {stamp(r.createdAt)}</div>)}</div>
    <div className="card sd-card" style={{ marginTop: 16 }}><b>Emails about this order</b>{o.emails.length === 0 && <p className="muted" style={{ fontSize: 14, marginTop: 6 }}>None.</p>}{o.emails.map((e: any, i: number) => <div key={i} style={{ fontSize: 14, marginTop: 8 }}>{e.template.replace(/_/g, ' ')} · {e.status}{e.attempts ? ` (${e.attempts} tries)` : ''} · {stamp(e.sentAt ?? e.createdAt)}</div>)}
      {area === 'support' && <Button size="sm" variant="ghost" style={{ marginTop: 12 }} disabled={busy || !['paid', 'partially_refunded', 'refunded'].includes(o.paymentStatus)} onClick={resend}>Resend the confirmation</Button>}{msg && <div className="saved" role="status" style={{ color: 'var(--ok)' }}>{msg}</div>}{err && <div className="err" role="alert">{err}</div>}</div>
    {(o.threads ?? []).map((t: any) => <div key={t.id} className="card sd-card" style={{ marginTop: 16 }}><b>Messages with {t.shop}</b><div className="muted" style={{ fontSize: 12 }}>Read only, for resolving disputes.</div>{(t.messages ?? []).map((m: any, i: number) => <div key={i} style={{ fontSize: 14, marginTop: 8 }}><b style={{ fontWeight: 600 }}>{m.sender === 'buyer' ? 'Buyer' : 'Maker'}:</b> {m.body} <span className="muted" style={{ fontSize: 12 }}>{stamp(m.createdAt)}</span></div>)}</div>)}
    {area === 'support' && <Notes path={`/api/support/orders/${id}/notes`} notes={o.notes} onAdded={reload} />}</Page>;
}

function RefundForm({ seller, onDone }: { seller: any; onDone: () => void }) {
  const [qtys, setQtys] = useState<Record<string, number>>({}); const [ship, setShip] = useState(false); const [reason, setReason] = useState(''); const [restock, setRestock] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [key] = useState(() => crypto.randomUUID());
  const go = async () => { setErr(''); setBusy(true); try { await api(`/api/finance/orders/${seller.id}/refund`, { method: 'POST', body: { lines: Object.entries(qtys).filter(([, n]) => n > 0).map(([lineId, quantity]) => ({ lineId, quantity })), includeShipping: ship, reason: reason.trim(), restock }, headers: { 'idempotency-key': key } }); onDone(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  return <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}><div className="muted" style={{ fontSize: 13 }}>Tax and commission come back in the same share. The buyer is refunded to their original payment.</div>
    {seller.lines.map((l: any) => { const left = l.quantity - l.refundedQty; return left > 0 && <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 14 }}><span style={{ flex: 1 }}>{l.title}</span><select aria-label={`Refund quantity for ${l.title}`} className="field" style={{ width: 'auto' }} value={qtys[l.id] ?? 0} onChange={e => setQtys({ ...qtys, [l.id]: Number(e.target.value) })}>{Array.from({ length: left + 1 }, (_, i) => <option key={i}>{i}</option>)}</select></div>; })}
    <label className="tgl"><input type="checkbox" checked={ship} onChange={e => setShip(e.target.checked)} />Also refund shipping</label><label className="tgl"><input type="checkbox" checked={restock} onChange={e => setRestock(e.target.checked)} />Put the items back in stock</label>
    <label className="label" htmlFor={`rr-${seller.id}`}>Reason</label><input id={`rr-${seller.id}`} className="field" value={reason} onChange={e => setReason(e.target.value)} />{err && <div className="err" role="alert">{err}</div>}
    <Button size="sm" style={{ marginTop: 12 }} disabled={busy || reason.trim().length < 3 || (!ship && !Object.values(qtys).some(n => n > 0))} onClick={go}>Refund</Button></div>;
}

export function PeopleLookup() {
  const area = useArea(); const [term, setTerm] = useState(''); const { data } = useApi<any[]>(`/api/${area}/users?limit=30${term.trim() ? `&q=${encodeURIComponent(term.trim())}` : ''}`);
  return <Page title="People" sub="Look up a buyer or seller by name or email."><SearchBar value={term} onChange={setTerm} placeholder="Name or email" />
    <Rows empty="Nobody matches.">{(data ?? []).map(u => <Link key={u.id} to={`/${area}/users/${u.id}`} className="tr"><div className="t"><b>{u.fullName}</b><div>{u.email}</div></div>{u.status === 'disabled' && <Chip>Disabled</Chip>}</Link>)}</Rows></Page>;
}
export function PersonView() {
  const area = useArea(); const { id = '' } = useParams(); const { data: u, reload, error } = useApi<any>(`/api/${area}/users/${id}`);
  if (error) return <div className="empty"><h2 className="serif">We could not find that person</h2></div>; if (!u) return <div className="skeleton" style={{ height: 200 }} />;
  return <Page title={u.fullName} sub={<>{u.email} · joined {stamp(u.createdAt)} · {u.status}</>} actions={<Link to={`/${area}/users`} className="btn ghost sm">Back</Link>}>
    <h2 className="serif" style={{ fontSize: 20, marginTop: 20 }}>Orders</h2><Rows empty="No orders.">{u.orders.map((o: any) => <Link key={o.id} to={`/${area}/orders/${o.id}`} className="tr"><div className="t"><b>#{o.number}</b><div>{stamp(o.createdAt)}</div></div><b>{money(o.totalCents)}</b>{statusChip(o.paymentStatus)}</Link>)}</Rows>
    <Notes path={`/api/${area}/users/${id}/notes`} notes={u.notes} onAdded={reload} /></Page>;
}
