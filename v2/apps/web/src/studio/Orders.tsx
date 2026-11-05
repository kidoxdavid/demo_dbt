import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, useApi } from '../api';
import { ProductArt } from '../art/ProductArt';
import { Button, Chip } from '../components/ui';
import { dateRange, money } from '../format';
import { useDesktop } from '../hooks';
import { ago } from './Dashboard';
import { cents, errText } from './fields';
import { useStudio } from './StudioShell';

const STATUSES: [string, string][] = [['', 'All'], ['new', 'New'], ['accepted', 'Accepted'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']];
export const statusChip = (s: string) => (s === 'shipped' || s === 'delivered' ? <Chip variant="ok">{s === 'shipped' ? 'Shipped' : 'Delivered'}</Chip> : s === 'cancelled' ? <Chip variant="outline">Cancelled</Chip> : <Chip>{s === 'new' ? 'New' : 'Accepted'}</Chip>);
const CARRIERS: [string, string][] = [['canada_post', 'Canada Post'], ['ups', 'UPS'], ['fedex', 'FedEx'], ['purolator', 'Purolator'], ['dhl', 'DHL'], ['other', 'Other']];

export function StudioLogin() {
  const { user, shop, ready, login } = useStudio(); const loc = useLocation(); const nav = useNavigate(); const [f, setF] = useState({ email: '', password: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (ready && user && shop) return <Navigate to={(loc.state as any)?.from ?? '/studio'} replace />;
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); setBusy(true); try { await login(f.email.trim(), f.password); nav((loc.state as any)?.from ?? '/studio', { replace: true }); }
    catch (x) { setErr(x instanceof ApiError && x.code === 'invalid_credentials' ? 'That email and password do not match.' : x instanceof ApiError && x.code === 'account_locked' ? 'Too many tries. Wait a few minutes and try again.' : x instanceof ApiError && x.status === 403 ? 'This sign-in is for sellers. Sign in to the shop with a buyer account instead.' : errText(x)); } finally { setBusy(false); } };
  return <div role="main" className="screen pad" style={{ paddingTop: 40 }}><div className="co"><div style={{ textAlign: 'center' }}><span className="logo lg">eazy<b>studio</b></span><h1 className="serif" style={{ marginTop: 16, fontSize: 28 }}>Sign in to your studio</h1></div>
    <form onSubmit={submit} noValidate><label className="label" htmlFor="sl-email">Email</label><input id="sl-email" className="field" type="email" autoComplete="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required />
      <label className="label" htmlFor="sl-pw">Password</label><input id="sl-pw" className="field" type="password" autoComplete="current-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required />
      {err && <div className="err" role="alert">{err}</div>}<Button type="submit" block style={{ marginTop: 18 }} disabled={busy}>{busy ? 'One moment…' : 'Sign in'}</Button></form>
    <p className="muted" style={{ textAlign: 'center', fontSize: 14, marginTop: 16 }}>New to selling? <Link to="/studio/start/1" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>Open your shop</Link></p></div></div>;
}

export function OrdersPage() {
  const [status, setStatus] = useState(''); const [limit, setLimit] = useState(25); const { data, loading } = useApi<any>(`/api/studio/orders?limit=${limit}${status ? `&status=${status}` : ''}`); const desktop = useDesktop(); const now = new Date();
  return <div className={`sd-page${desktop ? '' : ' pad'}`} style={desktop ? undefined : { paddingTop: 10 }}><h1 className="serif">Orders</h1><div className="sub">{data ? `${data.toShip} to ship` : ' '}</div>
    <div className="seg" role="tablist">{STATUSES.map(([v, l]) => <button key={v} role="tab" aria-selected={status === v} className={status === v ? 'on' : ''} onClick={() => { setStatus(v); setLimit(25); }}>{l}</button>)}</div>
    {data?.items.length === 0 && !loading ? <div className="empty"><h2 className="serif">No orders here yet</h2><p>When someone buys, it will show up here and we will email you.</p></div>
      : <div className="card table">{(data?.items ?? []).map((o: any) => <Link key={o.id} to={`/studio/orders/${o.id}`} className="tr"><div className="t"><b>#{o.number} · {o.title}{o.itemCount > 1 ? ` + ${o.itemCount - 1} more` : ''}</b><div>{o.buyerName} · {o.city} · {ago(o.createdAt, now)}{o.shipBy && ['new', 'accepted'].includes(o.status) ? ` · ship by ${o.shipBy.slice(0, 10)}` : ''}</div></div><b>{money(o.totalCents)}</b>{statusChip(o.status)}</Link>)}</div>}
    {data && data.items.length < data.total && <Button variant="ghost" className="more" onClick={() => setLimit(limit + 25)}>Show more</Button>}</div>;
}

export function OrderDetail() {
  const { id = '' } = useParams(); const { data: o, error, reload } = useApi<any>(`/api/studio/orders/${id}`); const { refresh } = useStudio(); const desktop = useDesktop(); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [carrier, setCarrier] = useState('canada_post'); const [track, setTrack] = useState(''); const [refunding, setRefunding] = useState(false); const [qtys, setQtys] = useState<Record<string, number>>({}); const [ship, setShip] = useState(false); const [reason, setReason] = useState(''); const [restock, setRestock] = useState(true); const [cancelling, setCancelling] = useState(false);
  if (error) return <div className="empty"><h2 className="serif">We could not find that order</h2><Link to="/studio/orders" className="btn" style={{ marginTop: 16 }}>Back to orders</Link></div>;
  if (!o) return <div className="pad" style={{ paddingTop: 30 }}><div className="skeleton" style={{ height: 240 }} /></div>;
  const act = async (fn: () => Promise<unknown>, map: Record<string, string> = {}) => { setErr(''); setBusy(true); try { await fn(); await reload(); await refresh(); setRefunding(false); setCancelling(false); } catch (x) { setErr(errText(x, { invalid_transition: 'That cannot be done in this order\'s current state.', exceeds_refundable: 'That is more than is left to refund.', quantity_exceeds_remaining: 'That is more than is left of that item.', shipping_already_refunded: 'Shipping was already refunded.', nothing_to_refund: 'Choose something to refund.', not_refundable: 'This order cannot be refunded.', refund_provider_error: 'The payment service did not answer. Nothing was refunded. Try again.', ...map })); } finally { setBusy(false); } };
  const post = (path: string, body: object = {}, key?: string) => api(`/api/studio/orders/${id}/${path}`, { method: 'POST', body, headers: key ? { 'idempotency-key': key } : undefined });
  const open = ['new', 'accepted'].includes(o.status); const remaining = o.totalCents - o.refundedCents;
  return <div className={`sd-page${desktop ? '' : ' pad'}`} style={desktop ? undefined : { paddingTop: 10 }}><Link to="/studio/orders" className="crumbs">‹ Orders</Link>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}><h1 className="serif" style={{ fontSize: 30 }}>Order #{o.number}</h1>{statusChip(o.status)}</div>
    <div className="sub">Ordered {ago(o.orderedAt)} · Pack by {o.shipBy ? o.shipBy.slice(0, 10) : 'n/a'} · Arrives {o.eta?.min ? dateRange(o.eta.min, o.eta.max) : 'n/a'}</div>
    {o.gift && <div className="notice">🎁 Gift{o.gift.message ? `: “${o.gift.message}”` : ''}</div>}
    <div className="card table">{o.lines.map((l: any) => <div key={l.id} className="tr"><div style={{ width: 48, height: 48, borderRadius: 10, overflow: 'hidden', flex: 'none' }}>{l.image ? <img src={l.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : l.art ? <ProductArt kind={l.art.kind} tone={l.art.tone} /> : null}</div>
      <div className="t"><b>{l.title}</b><div>{l.variant ? `${l.variant} · ` : ''}Qty {l.quantity}{l.refundedQty ? ` (${l.refundedQty} refunded)` : ''}{l.sku ? ` · SKU ${l.sku}` : ''}</div>{Object.entries(l.personalisation ?? {}).map(([k, v]) => <div key={k} style={{ color: 'var(--ink)' }}>{k}: {String(v)}</div>)}</div><b>{money(l.unitCents * l.quantity)}</b></div>)}</div>
    <div className="card sd-card" style={{ marginTop: 16 }}><b>Ship to</b><p style={{ fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>{o.shipTo.name}<br />{o.shipTo.line1}{o.shipTo.line2 ? <>, {o.shipTo.line2}</> : null}<br />{o.shipTo.city}, {o.shipTo.region} {o.shipTo.postal}{o.shipTo.phone ? <><br />{o.shipTo.phone}</> : null}</p></div>
    <div className="card sd-card" style={{ marginTop: 16 }}><div className="r" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span className="muted">Items</span><b>{money(o.itemsCents)}</b></div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 }}><span className="muted">Shipping paid by buyer</span><b>{money(o.shippingCents)}</b></div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 }}><span className="muted">GST collected (goes to the tax authority)</span><span>{money(o.taxCents)}</span></div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 }}><span className="muted">Platform commission ({(o.commissionBps / 100).toFixed(0)}%)</span><span>−{money(o.commissionCents)}</span></div>
      {o.refundedCents > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 }}><span className="muted">Refunded to buyer</span><span>−{money(o.refundedCents)}</span></div>}<div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}><b>You earn</b><b>{money(o.youEarnCents)}</b></div></div>
    {o.tracking && <div className="card sd-card" style={{ marginTop: 16 }}><b>Tracking</b><p style={{ fontSize: 14, marginTop: 6 }}>{o.tracking.carrier.replace('_', ' ')} · {o.tracking.url ? <a href={o.tracking.url} style={{ textDecoration: 'underline' }}>{o.tracking.number}</a> : o.tracking.number}</p></div>}
    {err && <div className="err" role="alert">{err}</div>}
    <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
      {o.status === 'new' && <Button disabled={busy} onClick={() => act(() => post('accept'))}>Accept order</Button>}
      {open && <Button variant={o.status === 'new' ? 'ghost' : ''} disabled={busy} onClick={() => setShip(!ship)}>Mark as shipped</Button>}
      {o.status === 'shipped' && <Button disabled={busy} onClick={() => act(() => post('deliver'))}>Mark as delivered</Button>}
      {['new', 'accepted', 'shipped', 'delivered'].includes(o.status) && remaining > 0 && <Button variant="ghost" disabled={busy} onClick={() => setRefunding(!refunding)}>Refund</Button>}
      {open && <Button variant="ghost" disabled={busy} onClick={() => setCancelling(!cancelling)}>Cancel order</Button>}</div>
    {ship && open && <div className="card sd-card" style={{ marginTop: 14, maxWidth: 520 }}><label className="label" style={{ marginTop: 0 }} htmlFor="o-car">Carrier</label><select id="o-car" className="field" value={carrier} onChange={e => setCarrier(e.target.value)}>{CARRIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <label className="label" htmlFor="o-trk">Tracking number</label><input id="o-trk" className="field" value={track} onChange={e => setTrack(e.target.value)} /><Button style={{ marginTop: 14 }} disabled={busy || track.trim().length < 3} onClick={() => act(() => post('ship', { carrier, trackingNumber: track.trim() }), { validation_failed: 'Tracking numbers are letters, numbers and dashes (3 to 40).' })}>Save and email the buyer</Button></div>}
    {refunding && <RefundForm o={o} busy={busy} qtys={qtys} setQtys={setQtys} ship={ship2(o)} reason={reason} setReason={setReason} restock={restock} setRestock={setRestock} onRefund={(inclShip: boolean) => act(() => post('refund', { lines: Object.entries(qtys).filter(([, n]) => n > 0).map(([lineId, quantity]) => ({ lineId, quantity })), includeShipping: inclShip, reason: reason.trim(), restock }, `refund-${id}-${Date.now()}`))} />}
    {cancelling && <div className="card sd-card" style={{ marginTop: 14, maxWidth: 520 }}><b>Cancel and refund everything</b><p className="muted" style={{ fontSize: 13, marginTop: 4 }}>The buyer is refunded in full and the stock goes back.</p><label className="label" htmlFor="o-cr">Reason (the buyer sees this)</label><input id="o-cr" className="field" value={reason} onChange={e => setReason(e.target.value)} />
      <Button style={{ marginTop: 14 }} disabled={busy || reason.trim().length < 3} onClick={() => act(() => post('cancel', { reason: reason.trim() }))}>Cancel order</Button></div>}</div>;
}
const ship2 = (o: any) => ({ available: o.shippingCents > 0 });
function RefundForm({ o, busy, qtys, setQtys, ship, reason, setReason, restock, setRestock, onRefund }: any) {
  const [inclShip, setInclShip] = useState(false);
  return <div className="card sd-card" style={{ marginTop: 14, maxWidth: 520 }}><b>Refund</b><p className="muted" style={{ fontSize: 13, marginTop: 4 }}>Tax and commission are returned in the same share. The buyer is refunded to their original payment.</p>
    {o.lines.map((l: any) => { const left = l.quantity - l.refundedQty; return left > 0 && <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 14 }}><span style={{ flex: 1 }}>{l.title}{l.variant ? ` · ${l.variant}` : ''}</span><select aria-label={`Refund quantity for ${l.title}`} className="field" style={{ width: 'auto' }} value={qtys[l.id] ?? 0} onChange={e => setQtys({ ...qtys, [l.id]: Number(e.target.value) })}>{Array.from({ length: left + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select></div>; })}
    {ship.available && <label className="tgl"><input type="checkbox" checked={inclShip} onChange={e => setInclShip(e.target.checked)} />Also refund shipping</label>}
    <label className="label" htmlFor="o-rr">Reason</label><input id="o-rr" className="field" value={reason} onChange={e => setReason(e.target.value)} /><label className="tgl"><input type="checkbox" checked={restock} onChange={e => setRestock(e.target.checked)} />Put the items back in stock</label>
    <Button style={{ marginTop: 14 }} disabled={busy || reason.trim().length < 3 || (!inclShip && !Object.values(qtys).some((n: any) => n > 0))} onClick={() => onRefund(inclShip)}>Refund</Button></div>;
}
void cents;
