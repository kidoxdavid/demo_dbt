import { useFlag } from '../flags';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, useApi } from '../api';
import { useCart } from '../cart';
import { Icon } from '../components/Icon';
import { Conversation, RatingStars, ReviewForm, type Msg } from '../components/Engagement';
import { Button } from '../components/ui';
import { dateRange, money } from '../format';
import { useSession } from '../session';

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const MESSAGES: Record<string, string> = { cart_empty: 'Your basket is empty.', out_of_stock: 'Something in your basket just sold out. Check your basket and try again.', items_unavailable: 'Something in your basket is no longer available.', payments_not_configured: 'Payments are not set up yet, so we cannot take orders right now.', payment_provider_error: 'The payment service did not answer. Nothing was charged. Try again in a minute.', invalid_postal_code: 'That postal code does not look right.', email_required: 'Enter your email so we can send your receipt.' };
interface Placed { orderId: string; token: string; totalCents: number; taxCents: number; shippingCents: number; itemsCents: number; expiresAt: string; payment: { simulated: boolean; ref: string } }

/** Checkout: address, a clear total with GST, then payment. Stock is held for the reservation time; the order is only paid when the payment provider confirms. */
export function CheckoutPage() {
  const { cart, ready, refresh } = useCart(); const { user } = useSession(); const nav = useNavigate(); const guestOk = useFlag('guest_checkout');
  const [f, setF] = useState({ email: '', name: user?.fullName ?? '', line1: '', line2: '', city: '', region: 'AB', postal: '', phone: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [placed, setPlaced] = useState<Placed | null>(null);
  const key = useRef(crypto.randomUUID()); const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { if (user && !f.name) setF(x => ({ ...x, name: user.fullName })); }, [user]);          // eslint-disable-line react-hooks/exhaustive-deps
  if (ready && cart.count === 0 && !placed) return <div className="empty" style={{ paddingTop: 80 }}><h1 className="serif">Your basket is empty</h1><Link to="/" className="btn" style={{ marginTop: 16 }}>Browse the shop</Link></div>;
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); setBusy(true);
    try { const body = { ...(user ? {} : { email: f.email.trim() }), address: { name: f.name.trim(), line1: f.line1.trim(), ...(f.line2.trim() ? { line2: f.line2.trim() } : {}), city: f.city.trim(), region: f.region, postal: f.postal.trim(), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}) } };
      setPlaced(await api<Placed>('/api/checkout', { method: 'POST', body, headers: { 'idempotency-key': key.current } })); }
    catch (x) { setErr(x instanceof ApiError ? MESSAGES[x.code] ?? (x.status === 400 ? 'Please check the highlighted details and try again.' : x.status === 422 ? 'Please check your address and try again.' : 'Something went wrong. Try again.') : 'Something went wrong. Try again.'); } finally { setBusy(false); } };
  if (placed) return <Pay placed={placed} onPaid={async () => { await refresh(); nav(`/orders/${placed.token}`, { replace: true }); }} onBack={() => setPlaced(null)} />;
  if (!guestOk && !user) return <div className="screen pad" style={{ paddingTop: 10 }}><div className="co"><Link to="/basket" className="crumbs">‹ Basket</Link><h1 className="serif" style={{ marginTop: 6 }}>Checkout</h1><p className="muted">Please sign in or create an account to check out.</p><Link to="/account" className="btn" style={{ marginTop: 14 }}>Sign in</Link></div></div>;
  const gst = null as null;
  return <div className="screen pad" style={{ paddingTop: 10 }}><div className="co"><Link to="/basket" className="crumbs">‹ Basket</Link><h1 className="serif" style={{ marginTop: 6 }}>Checkout</h1>
    <form onSubmit={submit} noValidate>
      {!user && <div className="card sec"><b>Contact</b><label className="label" htmlFor="co-email">Email</label><input id="co-email" className="field" type="email" autoComplete="email" value={f.email} onChange={set('email')} required /><p className="muted" style={{ fontSize: 12, marginTop: 6 }}>For your receipt and shipping updates. <Link to="/account?next=/checkout" style={{ textDecoration: 'underline' }}>Have an account? Sign in</Link></p></div>}
      <div className="card sec"><b>Ship to</b>
        <label className="label" htmlFor="co-name">Full name</label><input id="co-name" className="field" autoComplete="name" value={f.name} onChange={set('name')} required />
        <label className="label" htmlFor="co-l1">Address</label><input id="co-l1" className="field" autoComplete="address-line1" value={f.line1} onChange={set('line1')} required />
        <label className="label" htmlFor="co-l2">Apartment, suite (optional)</label><input id="co-l2" className="field" autoComplete="address-line2" value={f.line2} onChange={set('line2')} />
        <div className="two"><div><label className="label" htmlFor="co-city">City</label><input id="co-city" className="field" autoComplete="address-level2" value={f.city} onChange={set('city')} required /></div><div><label className="label" htmlFor="co-prov">Province</label><select id="co-prov" className="field" autoComplete="address-level1" value={f.region} onChange={set('region')}>{PROVINCES.map(p => <option key={p}>{p}</option>)}</select></div></div>
        <div className="two"><div><label className="label" htmlFor="co-post">Postal code</label><input id="co-post" className="field" autoComplete="postal-code" placeholder="T2N 1N4" value={f.postal} onChange={set('postal')} required /></div><div><label className="label" htmlFor="co-ph">Phone (optional)</label><input id="co-ph" className="field" autoComplete="tel" value={f.phone} onChange={set('phone')} /></div></div></div>
      <div className="card sec tot"><b>Your order</b>{cart.sellers.map(s => <div key={s.sellerId} style={{ marginTop: 10, fontSize: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><b style={{ fontWeight: 600 }}>{s.shop.name}</b><span className="muted" style={{ fontSize: 12 }}>Arrives {dateRange(s.eta.min, s.eta.max)}</span></div>{s.lines.map(l => <div key={l.id} className="r"><span>{l.title}{l.variant ? ` · ${l.variant}` : ''} × {l.quantity}</span><b style={{ fontWeight: 500 }}>{money(l.lineCents)}</b></div>)}</div>)}
        <div className="r" style={{ marginTop: 14 }}><span>Items</span><b>{money(cart.itemsCents)}</b></div><div className="r"><span>Shipping</span><b>{money(cart.shippingCents)}</b></div><div className="r"><span>GST (5%)</span><span>Added when you pay</span></div>{gst}</div>
      {err && <div className="err" role="alert">{err}</div>}
      <Button type="submit" block style={{ marginTop: 18 }} disabled={busy || cart.blocked}>{busy ? 'Placing your order…' : 'Continue to payment'}</Button>
      <p className="muted" style={{ fontSize: 12, marginTop: 10, textAlign: 'center' }}>We hold your pieces for a few minutes while you pay.</p></form></div></div>;
}

function Pay({ placed, onPaid, onBack }: { placed: Placed; onPaid: () => void; onBack: () => void }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [left, setLeft] = useState(() => Math.max(0, new Date(placed.expiresAt).getTime() - Date.now()));
  useEffect(() => { const t = setInterval(() => setLeft(Math.max(0, new Date(placed.expiresAt).getTime() - Date.now())), 1000); return () => clearInterval(t); }, [placed.expiresAt]);
  const pay = async (outcome: 'succeeded' | 'failed') => { setBusy(true); setErr(''); try { await api(`/api/dev/payments/${placed.payment.ref}/simulate`, { method: 'POST', body: { outcome } }); if (outcome === 'succeeded') onPaid(); else setErr('The test payment was declined. Your pieces were released.'); } catch { setErr('The payment could not be completed.'); } finally { setBusy(false); } };
  const mm = Math.floor(left / 60000), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  return <div className="screen pad" style={{ paddingTop: 10 }}><div className="co"><h1 className="serif">Payment</h1>
    <div className="card sec tot"><div className="r"><span>Items</span><b>{money(placed.itemsCents)}</b></div><div className="r"><span>Shipping</span><b>{money(placed.shippingCents)}</b></div><div className="r"><span>GST</span><b>{money(placed.taxCents)}</b></div><div className="r big"><span style={{ color: 'var(--ink)' }}>Total</span><b>{money(placed.totalCents)}</b></div></div>
    <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>{left > 0 ? `Your pieces are held for ${mm}:${ss}.` : 'The hold has run out. Go back and place the order again.'}</p>
    {placed.payment.simulated ? <div className="card sec"><b>Test mode</b><p className="muted" style={{ fontSize: 13, marginTop: 6 }}>No card is charged. This only simulates the payment provider so the whole order flow can be tried.</p>
      <Button block style={{ marginTop: 14 }} disabled={busy || left === 0} onClick={() => pay('succeeded')}>{busy ? 'Paying…' : `Pay ${money(placed.totalCents)} (test)`}</Button><Button block variant="ghost" style={{ marginTop: 10 }} disabled={busy} onClick={() => pay('failed')}>Simulate a declined card</Button></div>
      : <div className="card sec"><p>Card payment is not connected yet, so this order cannot be paid. (A real payment adapter is a later step.)</p></div>}
    {err && <div className="err" role="alert">{err}</div>}<button className="muted" style={{ display: 'block', margin: '16px auto 0', fontSize: 13, textDecoration: 'underline' }} onClick={onBack}>Back to your details</button></div></div>;
}

/** Order chat with one maker, through the private order link (guests can use it too). */
function OrderChat({ token, sellerOrderId, shop }: { token: string; sellerOrderId: string; shop: string }) {
  const [open, setOpen] = useState(false); const { data, reload } = useApi<{ messages: Msg[] }>(open ? `/api/orders/by-token/${token}/messages/${sellerOrderId}` : null);
  return <div style={{ marginTop: 12 }}><Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide messages' : `Message ${shop}`}</Button>
    {open && <div className="rv-form"><Conversation messages={data?.messages ?? []} me="buyer" placeholder={`Ask ${shop} about this order`} onSend={async body => { await api(`/api/orders/by-token/${token}/messages/${sellerOrderId}`, { method: 'POST', body: { body } }); reload(); }} /></div>}</div>;
}
function LineReview({ token, line, delivered, onDone }: { token: string; line: any; delivered: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false); if (!line.productId) return null;
  if (line.review) return <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Your review: <RatingStars n={line.review.rating} size={12} /></div>;
  if (!delivered) return null;
  return open ? <ReviewForm token={token} productId={line.productId} title={line.title} onDone={() => { setOpen(false); onDone(); }} /> : <button type="button" style={{ fontSize: 13, textDecoration: 'underline', marginTop: 4 }} onClick={() => setOpen(true)}>Write a review</button>;
}
const STEPS = ['Order placed', 'Accepted by the maker', 'Shipped', 'Delivered'];
const rank = (s: string) => ({ new: 0, accepted: 1, shipped: 2, delivered: 3 } as Record<string, number>)[s] ?? -1;
/** Order status. Guests reach it by the private link in their email. */
export function OrderPage() {
  const { token = '' } = useParams(); const { data: o, error, reload } = useApi<any>(`/api/orders/by-token/${token}`); const { data: mode } = useApi<{ testMode: boolean; email: string }>('/api/mode');
  useEffect(() => { if (o && o.paymentStatus === 'pending') { const t = setInterval(reload, 3000); return () => clearInterval(t); } }, [o, reload]);
  if (error) return <div className="empty" style={{ paddingTop: 80 }}><h1 className="serif">We could not find that order</h1><p>Check the link in your confirmation email.</p></div>;
  if (!o) return <div className="pad" style={{ paddingTop: 40 }}><div className="skeleton" style={{ height: 160 }} /></div>;
  const paid = o.paymentStatus !== 'pending' && o.paymentStatus !== 'failed';
  return <div className="screen pad" style={{ paddingTop: 24 }}><div className="co">
    <div style={{ textAlign: 'center' }}><div className="ok-mark"><Icon name="check" size={28} /></div><h1 className="serif" style={{ marginTop: 14 }}>{paid ? 'Thank you' : o.paymentStatus === 'failed' ? 'Payment did not go through' : 'Waiting for payment'}</h1><p className="muted" style={{ marginTop: 6 }}>Order #{o.number}{paid ? ` · ${mode?.email === 'sent' ? 'confirmation sent to' : 'confirmation for'} ${o.email}` : ''}</p>{paid && mode?.testMode && <p role="note" className="muted" style={{ marginTop: 8, fontSize: 14 }}>Test mode: no card was charged{mode.email === 'sent' ? '' : ' and no email was sent (emails are switched off here)'}.</p>}</div>
    {o.sellers.map((s: any) => <div key={s.id} className="card sec"><div style={{ display: 'flex', justifyContent: 'space-between' }}><Link to={`/shop/${s.shop.slug}`}><b>{s.shop.name}</b></Link>{s.eta?.min && <span className="muted" style={{ fontSize: 12 }}>Arrives {dateRange(s.eta.min, s.eta.max)}</span>}</div>
      {s.lines.map((l: any, i: number) => <div key={i} style={{ marginTop: 8 }}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>{l.title}{l.variant ? ` · ${l.variant}` : ''} × {l.quantity}</span><b style={{ fontWeight: 500 }}>{money(l.unitCents * l.quantity)}</b></div><LineReview token={token} line={l} delivered={s.status === 'delivered'} onDone={reload} /></div>)}
      {paid && <ul className="timeline">{STEPS.map((t, i) => <li key={t} className={i <= rank(s.status) ? 'on' : ''}><i />{t}</li>)}</ul>}
      {s.tracking && <p style={{ fontSize: 13, marginTop: 8 }}>Tracking: {s.tracking.url ? <a href={s.tracking.url} style={{ textDecoration: 'underline' }}>{s.tracking.number}</a> : s.tracking.number}</p>}
      {s.refundedCents > 0 && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Refunded {money(s.refundedCents)}</p>}{paid && <OrderChat token={token} sellerOrderId={s.id} shop={s.shop.name} />}</div>)}
    <div className="card sec tot"><div className="r"><span>Items</span><b>{money(o.itemsCents)}</b></div><div className="r"><span>Shipping</span><b>{money(o.shippingCents)}</b></div><div className="r"><span>GST</span><b>{money(o.taxCents)}</b></div><div className="r big"><span style={{ color: 'var(--ink)' }}>Total</span><b>{money(o.totalCents)}</b></div></div>
    <Link to="/" className="btn ghost" style={{ display: 'flex', marginTop: 18 }}>Keep browsing</Link></div></div>;
}
