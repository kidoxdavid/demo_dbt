import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorText, money } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';
import { usePub } from './Store';
import { PubHeader } from './Market';

const safeNext = (n: string | null) => (n && /^\/[a-zA-Z0-9/_?=&.%-]*$/.test(n) && !n.startsWith('//') ? n : '/account');
export const Stars = ({ avg, count }: { avg: number | null; count: number }) => !count ? null :
  <span className="stars" aria-label={`${avg} out of 5 from ${count} review${count > 1 ? 's' : ''}`}>{'★'.repeat(Math.round(avg ?? 0))}<span className="muted">{'★'.repeat(5 - Math.round(avg ?? 0))}</span> <span className="muted small">{avg} ({count})</span></span>;

/** Signed-in state for customer-facing pages. */
export function useMe() {
  const [me, setMe] = useState<any>(undefined);
  useEffect(() => { api('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  return me as any | null | undefined;
}

export function CustomerSignup() {
  usePub(); const nav = useNavigate(); const [sp] = useSearchParams();
  const [f, setF] = useState({ fullName: '', email: '', password: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/api/auth/signup-customer', { body: f }); nav(safeNext(sp.get('next'))); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); } }
  return <><PubHeader /><main className="wrap" style={{ maxWidth: 520 }}>
    <span className="kicker" style={{ marginTop: 44 }}>Customers</span><h1 style={{ margin: '12px 0 8px' }}>Create an account</h1>
    <p className="muted">Keep your orders in one place, save favourites, and review what you bought. You can still check out as a guest.</p>
    <form className="card" onSubmit={submit}>{err && <Alert kind="err">{err}</Alert>}
      <Field label="Your name">{id => <input id={id} required autoComplete="name" value={f.fullName} onChange={e => setF({ ...f, fullName: e.target.value })} />}</Field>
      <Field label="Email">{id => <input id={id} type="email" required autoComplete="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} />}</Field>
      <Field label="Password" hint="At least 10 characters.">{id => <input id={id} type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} />}</Field>
      <p><button disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button></p>
      <p className="muted small">Already have one? <Link to={`/login?next=${encodeURIComponent(safeNext(sp.get('next')))}`}>Log in</Link>. Selling instead? <Link to="/signup">Open a store</Link>.</p></form></main></>;
}

export function WishHeart({ productId }: { productId: string }) {
  const nav = useNavigate(); const [on, setOn] = useState(false); const [ready, setReady] = useState(false); const [signedIn, setSignedIn] = useState(false);
  useEffect(() => { api('/api/account/wishlist/ids').then((ids: string[]) => { setOn(ids.includes(productId)); setSignedIn(true); }).catch(() => {}).finally(() => setReady(true)); }, [productId]);
  async function toggle() {
    if (!signedIn) { nav(`/account/signup?next=${encodeURIComponent(location.pathname)}`); return; }
    try { await api(`/api/account/wishlist/${productId}`, { method: on ? 'DELETE' : 'PUT' }); setOn(!on); } catch { /* leave as is */ }
  }
  if (!ready) return null;
  return <button className={`heart${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? 'Remove from favourites' : 'Save to favourites'} onClick={toggle}>{on ? '♥' : '♡'}</button>;
}

export function ReviewsSection({ slug, productId }: { slug: string; productId: string }) {
  const [d, setD] = useState<any>(null); const [rating, setRating] = useState(0); const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [err, setErr] = useState(''); const [saved, setSaved] = useState(false);
  const base = `/api/public/stores/${slug}/products/${productId}/reviews`;
  const load = useCallback(() => api(base).then(r => { setD(r); if (r.mine) { setRating(r.mine.rating); setTitle(r.mine.title ?? ''); setBody(r.mine.body ?? ''); } }).catch(() => setD(null)), [base]);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  async function submit(e: FormEvent) { e.preventDefault(); setErr(''); setSaved(false);
    try { await api(base, { method: 'PUT', body: { rating, title: title || undefined, body: body || undefined } }); setSaved(true); load(); }
    catch (x) { setErr(x instanceof ApiError && x.code === 'review_removed' ? 'This review was removed by a moderator and cannot be edited.' : errorText(x)); } }
  return <section className="reviews" aria-labelledby="rv-h"><h2 id="rv-h">Reviews</h2>
    {d.rating.count ? <p><Stars avg={d.rating.avg} count={d.rating.count} /></p> : <p className="muted">No reviews yet.</p>}
    {d.canReview && <form className="card" onSubmit={submit}><h3 style={{ marginTop: 0 }}>{d.mine ? 'Edit your review' : 'Review this product'}</h3>
      {err && <Alert kind="err">{err}</Alert>}{saved && <Alert kind="ok">Thank you. Your review is up.</Alert>}
      <fieldset className="rate"><legend>Your rating</legend>{[1, 2, 3, 4, 5].map(n => <button type="button" key={n} aria-pressed={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>★</button>)}</fieldset>
      <Field label="Headline (optional)">{id => <input id={id} maxLength={120} value={title} onChange={e => setTitle(e.target.value)} />}</Field>
      <Field label="Your review (optional)">{id => <textarea id={id} maxLength={2000} value={body} onChange={e => setBody(e.target.value)} />}</Field>
      <p><button disabled={!rating}>{d.mine ? 'Save changes' : 'Post review'}</button></p></form>}
    {!d.canReview && <p className="muted small">Only customers who bought this product can review it. <Link to={`/account/signup?next=${encodeURIComponent(location.pathname)}`}>Create an account</Link> or <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>log in</Link> to see if you can.</p>}
    <ul className="list">{d.reviews.map((r: any) => <li key={r.id} style={{ display: 'block' }}>
      <div className="row spread"><b>{r.name}</b><span className="stars" aria-label={`${r.rating} out of 5`}>{'★'.repeat(r.rating)}<span className="muted">{'★'.repeat(5 - r.rating)}</span></span></div>
      {r.title && <p style={{ margin: '4px 0 0' }}><b>{r.title}</b></p>}{r.body && <p style={{ margin: '4px 0' }}>{r.body}</p>}
      <p className="muted small">Verified purchase · {new Date(r.createdAt).toLocaleDateString('en-CA')}</p>
      {r.sellerReply && <blockquote className="reply">{r.sellerReply}<div className="muted small">Reply from the seller</div></blockquote>}</li>)}</ul></section>;
}

export function Account() {
  usePub(); const nav = useNavigate(); const me = useMe();
  const [orders, setOrders] = useState<any[] | null>(null); const [wish, setWish] = useState<any[] | null>(null); const [err, setErr] = useState('');
  const [closing, setClosing] = useState(false); const [pw, setPw] = useState(''); const [confirm, setConfirm] = useState('');
  const load = useCallback(() => { api('/api/account/orders').then(setOrders).catch(e => { if (e instanceof ApiError && e.status === 401) nav('/login?next=/account'); else setErr(errorText(e)); }); api('/api/account/wishlist').then(setWish).catch(() => {}); }, [nav]);
  useEffect(() => { load(); }, [load]);
  async function remove(id: string) { await api(`/api/account/wishlist/${id}`, { method: 'DELETE' }).catch(() => {}); load(); }
  async function close(e: FormEvent) { e.preventDefault(); setErr('');
    try { await api('/api/account/close', { body: { password: pw, confirm: 'CLOSE' } }); nav('/'); } catch (x) { setErr(errorText(x).replace('(seller_account)', '— this is a seller account. Close your business from its Settings.')); } }
  async function logout() { await api('/api/auth/logout', { method: 'POST', body: {} }); nav('/'); }
  return <><PubHeader /><main className="wrap" style={{ maxWidth: 820 }}>
    <span className="kicker" style={{ marginTop: 36 }}>Your account</span><h1 style={{ margin: '10px 0 4px' }}>{me?.fullName ?? 'Account'}</h1>
    <p className="muted">{me?.email} {me && !me.emailVerified && <Badge s="unverified" />} · <button className="textbtn" onClick={logout}>Log out</button></p>
    {me && !me.emailVerified && <Alert kind="warn">Confirm your email (we sent a link) so orders placed as a guest with this address show here and you can review them.</Alert>}
    {err && <Alert kind="err">{err}</Alert>}
    <h2>Orders</h2>
    {orders && !orders.length && <Empty title="No orders yet">Orders you place while signed in appear here. <Link to="/">Browse the marketplace</Link></Empty>}
    {orders?.map(o => <section className="card" key={o.token}><div className="row spread"><b>#{o.number} · {o.storeName}</b><Badge s={o.status} /></div>
      <p className="muted small">{new Date(o.createdAt).toLocaleDateString('en-CA')} · {money(o.totalCents, o.currency)}{o.channel === 'pos' ? ' · in store' : ''}</p>
      <ul className="list">{o.items.map((i: any, n: number) => <li key={n} className="row spread"><span>{i.quantity} × {i.name}</span>{i.productId && ['paid', 'processing', 'ready', 'shipped', 'completed'].includes(o.status) && <Link className="small" to={`/store/${o.storeSlug}/p/${i.productId}#rv-h`}>Review</Link>}</li>)}</ul>
      <Link className="small" to={`/order/${o.token}`}>View order</Link></section>)}
    <h2>Favourites</h2>
    {wish && !wish.length && <Empty title="Nothing saved yet">Tap the heart on a product to save it.</Empty>}
    <div className="wishgrid">{wish?.map(w => <div className="card" key={w.id}><Link to={`/store/${w.storeSlug}/p/${w.id}`}><b>{w.name}</b></Link><p className="muted small">{w.storeName} · from {money(w.priceFrom, w.currency)}{w.available ? '' : ' · sold out'}</p><button className="ghost sm" onClick={() => remove(w.id)}>Remove</button></div>)}</div>
    <h2>Close my account</h2>
    {!closing ? <button className="ghost" onClick={() => setClosing(true)}>Close my account…</button> : <form className="card" onSubmit={close}>
      <p className="muted small">This removes your favourites and signs you out for good. Your reviews stay but show “Former customer”. Order records are kept by the stores for accounting.</p>
      <Field label="Password">{id => <input id={id} type="password" required value={pw} onChange={e => setPw(e.target.value)} />}</Field>
      <Field label='Type CLOSE to confirm'>{id => <input id={id} value={confirm} onChange={e => setConfirm(e.target.value)} />}</Field>
      <p><button className="danger" disabled={confirm !== 'CLOSE' || !pw}>Close account</button></p></form>}
  </main></>;
}
