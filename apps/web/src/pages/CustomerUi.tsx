import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorText, money } from '../api';
import { useCart } from '../cart';
import { Alert } from '../ui';

/* ---------- delivery wording from the seller's rules ---------- */
export function deliveryLines(store: any): string[] {
  const out: string[] = []; const cur = store.currency;
  if (store.fulfilment.pickup) out.push('Pickup: free');
  if (store.fulfilment.delivery) {
    const rules: any[] = store.deliveryRules ?? [];
    if (!rules.length) out.push(`Delivery: ${store.deliveryFeeCents ? money(store.deliveryFeeCents, cur) : 'free'}`);
    else for (const r of rules) out.push(`Delivery ${r.regions.length ? `to ${r.regions.join(', ')}` : 'anywhere in Canada'}: ${r.priceCents === 0 ? 'free' : money(r.priceCents, cur)}${r.minSubtotalCents > 0 ? ` on orders over ${money(r.minSubtotalCents, cur)}` : ''}${r.maxSubtotalCents != null ? ` up to ${money(r.maxSubtotalCents, cur)}` : ''}`);
  }
  return out;
}
export const freeDelivery = (store: any): { min: number; where: string } | null => {
  const r = (store.deliveryRules ?? []).find((x: any) => x.priceCents === 0 && x.minSubtotalCents > 0); return r ? { min: r.minSubtotalCents, where: r.regions.length ? r.regions.join(', ') : 'Canada' } : null;
};

/* ---------- shared favourites ---------- */
let wish: { ids: Set<string>; signedIn: boolean; loaded: boolean } = { ids: new Set(), signedIn: false, loaded: false }; const wl = new Set<() => void>(); const wemit = () => wl.forEach(f => f());
/** Forget what we know about favourites (call after logging in or out) so the hearts reload for the right person. */
export function resetWish() { wish = { ids: new Set(), signedIn: false, loaded: false }; wemit(); }
function loadWish() { if (wish.loaded) return; wish = { ...wish, loaded: true }; api('/api/account/wishlist/ids').then((ids: string[]) => { wish = { ids: new Set(ids), signedIn: true, loaded: true }; wemit(); }).catch(() => { wemit(); }); }
export function useWish() {
  useEffect(loadWish); useSyncExternalStore(f => { wl.add(f); return () => { wl.delete(f); }; }, () => wish);
  const nav = useNavigate();
  const toggle = useCallback(async (productId: string) => {
    if (!wish.signedIn) { nav(`/account/signup?next=${encodeURIComponent(location.pathname)}`); return; }
    const on = wish.ids.has(productId); const next = new Set(wish.ids); on ? next.delete(productId) : next.add(productId); wish = { ...wish, ids: next }; wemit();     // instant, then confirm
    try { await api(`/api/account/wishlist/${productId}`, { method: on ? 'DELETE' : 'PUT' }); } catch { const back = new Set(wish.ids); on ? back.add(productId) : back.delete(productId); wish = { ...wish, ids: back }; wemit(); }
  }, [nav]);
  return { has: (id: string) => wish.ids.has(id), toggle };
}
export function Heart({ productId, className = '' }: { productId: string; className?: string }) {
  const { has, toggle } = useWish(); const on = has(productId);
  return <button type="button" className={`heart sm-heart${on ? ' on' : ''} ${className}`} aria-pressed={on} aria-label={on ? 'Remove from favourites' : 'Save to favourites'} onClick={e => { e.preventDefault(); e.stopPropagation(); toggle(productId); }}>{on ? '♥' : '♡'}</button>;
}

/* ---------- follow a maker ---------- */
export function FollowButton({ slug, dark }: { slug: string; dark?: boolean }) {
  const nav = useNavigate(); const [s, setS] = useState<{ following: boolean; signedIn: boolean } | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/api/public/stores/${slug}/following`).then(setS).catch(() => setS(null)); }, [slug]);
  if (!s) return null;
  async function click() {
    if (!s!.signedIn) { nav(`/account/signup?next=${encodeURIComponent(location.pathname)}`); return; }
    setBusy(true); try { await api(`/api/account/follows/${slug}`, { method: s!.following ? 'DELETE' : 'PUT' }); setS({ ...s!, following: !s!.following }); } finally { setBusy(false); }
  }
  return <button type="button" className={`followbtn${s.following ? ' on' : ''}${dark ? ' dark' : ''}`} disabled={busy} aria-pressed={s.following} onClick={click} title="Get an email when this maker releases something new">{s.following ? '✓ Following' : '+ Follow'}</button>;
}

/* ---------- notify me (sold out or a drop that has not started) ---------- */
export function NotifyForm({ slug, productId, kind }: { slug: string; productId: string; kind: 'restock' | 'drop' }) {
  const [email, setEmail] = useState(''); const [done, setDone] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [signedIn, setSignedIn] = useState(false);
  useEffect(() => { api('/api/me').then(m => { setSignedIn(true); setEmail(m.email); }).catch(() => {}); }, []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api(`/api/public/stores/${slug}/products/${productId}/waitlist`, { body: signedIn ? {} : { email } }); setDone(r.already ? 'You are already on the list.' : kind === 'drop' ? 'Done. We will email you the moment it goes live.' : 'Done. We will email you when it is back.'); }
    catch (x) { setErr(errorText(x).replace('(available_now)', '— it is available now, so you can buy it.')); } finally { setBusy(false); }
  }
  if (done) return <Alert kind="ok">{done}</Alert>;
  return <form className="notify" onSubmit={submit}><b>{kind === 'drop' ? 'Be first to know' : 'Get told when it is back'}</b>
    {err && <Alert kind="err">{err}</Alert>}
    <div className="row">{!signedIn && <input type="email" required aria-label="Your email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} style={{ flex: 1 }} />}
      <button disabled={busy}>{kind === 'drop' ? 'Remind me' : 'Notify me'}{signedIn ? ` (${email})` : ''}</button></div></form>;
}

/* ---------- store header and cart drawer ---------- */
export function StoreHeader({ store, slug, back }: { store: any; slug: string; back?: ReactNode }) {
  const cart = useCart(slug);
  return <header className="ptop"><div className="wrap pbar"><Link to="/" className="plogo" aria-label="Back to the marketplace">Eazy<i>Stores</i></Link>
    <Link to={`/store/${slug}`} className="pstore">{store.name}</Link>
    <div className="pright">{back}<Link className="plink" to="/account">Account</Link>
      <button type="button" className="cartbtn" onClick={() => cart.setOpen(true)} aria-label={`Open cart, ${cart.count} item${cart.count === 1 ? '' : 's'}`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 8h14l-1.2 11H6.2L5 8z" /><path d="M9 8V6a3 3 0 016 0v2" /></svg>
        {cart.count > 0 && <span className="cbadge">{cart.count}</span>}</button></div></div></header>;
}

export function CartDrawer({ store, slug }: { store: any; slug: string }) {
  const cart = useCart(slug); const ref = useRef<HTMLDivElement>(null); const free = freeDelivery(store);
  useEffect(() => {
    if (!cart.open) return; const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; ref.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') cart.setOpen(false); }; window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', esc); };
  }, [cart.open]); // eslint-disable-line
  if (!cart.open) return null;
  const cur = store.currency;
  return <div className="drawer-wrap"><div className="scrim" onClick={() => cart.setOpen(false)} />
    <aside className="drawer" role="dialog" aria-modal="true" aria-label="Your cart" tabIndex={-1} ref={ref}>
      <div className="dhead"><h2>Your cart{cart.count > 0 && <span className="muted"> · {cart.count}</span>}</h2><button className="ghost" onClick={() => cart.setOpen(false)} aria-label="Close cart">✕</button></div>
      {!cart.lines.length ? <div className="dempty"><p>Your cart is empty.</p><button className="secondary" onClick={() => cart.setOpen(false)}>Keep shopping</button></div> : <>
        {free && cart.subtotal < free.min && <div className="freebar"><span>You are <b>{money(free.min - cart.subtotal, cur)}</b> away from free delivery ({free.where})</span><i><b style={{ width: `${Math.min(100, (cart.subtotal / free.min) * 100)}%` }} /></i></div>}
        {free && cart.subtotal >= free.min && <div className="freebar done">🎉 You qualify for free delivery ({free.where})</div>}
        <ul className="dlines">{cart.lines.map(l => <li key={l.key}>
          <div className="dimg">{l.image ? <img src={l.image} alt="" /> : <span aria-hidden>{l.name.slice(0, 1)}</span>}</div>
          <div className="dinfo"><b>{l.name}</b>{l.title !== 'Default' && <span className="muted small">{l.title}</span>}
            {l.customView?.map(v => <span key={v.label} className="muted small">{v.label}: {v.type === 'image' ? 'photo attached' : v.value}</span>)}
            <div className="qty"><button className="secondary" aria-label={`Decrease ${l.name}`} onClick={() => cart.setQty(l.key, l.qty - 1)}>−</button><span aria-live="polite">{l.qty}</span><button className="secondary" aria-label={`Increase ${l.name}`} onClick={() => cart.setQty(l.key, l.qty + 1)}>+</button>
              <button className="ghost sm" onClick={() => cart.setQty(l.key, 0)}>Remove</button></div></div>
          <div className="dprice">{money(l.priceCents * l.qty, cur)}</div></li>)}</ul>
        <div className="dfoot"><div className="row spread"><span>Subtotal</span><b>{money(cart.subtotal, cur)}</b></div><p className="muted small">Delivery and tax are worked out at checkout.</p>
          <Link className="btn" to={`/store/${slug}/checkout`} onClick={() => cart.setOpen(false)}>Checkout · {money(cart.subtotal, cur)}</Link>
          <button className="ghost" onClick={() => cart.setOpen(false)}>Continue shopping</button></div></>}
    </aside></div>;
}

export function Qty({ value, onChange, max = 20 }: { value: number; onChange: (n: number) => void; max?: number }) {
  return <div className="qty big"><button type="button" className="secondary" aria-label="Decrease quantity" onClick={() => onChange(Math.max(1, value - 1))}>−</button><span aria-live="polite" aria-label={`Quantity ${value}`}>{value}</span><button type="button" className="secondary" aria-label="Increase quantity" onClick={() => onChange(Math.min(max, value + 1))}>+</button></div>;
}

/* ---------- order timeline ---------- */
export function Timeline({ status, fulfilment }: { status: string; fulfilment: string }) {
  const steps = [['paid', 'Order placed'], ['processing', 'Being prepared'], [fulfilment === 'delivery' ? 'shipped' : 'ready', fulfilment === 'delivery' ? 'On its way' : 'Ready for pickup'], ['completed', 'Complete']];
  const order = ['awaiting_payment', 'paid', 'processing', fulfilment === 'delivery' ? 'shipped' : 'ready', 'completed']; const at = status === 'ready' || status === 'shipped' ? 3 : order.indexOf(status);
  if (['cancelled', 'refunded'].includes(status)) return <p className="tl-note">This order was {status}.</p>;
  return <ol className="timeline" aria-label="Order progress">{steps.map(([k, l], i) => <li key={k} className={i + 1 <= at ? 'done' : i + 1 === at + 1 ? 'next' : ''}><i aria-hidden>{i + 1 <= at ? '✓' : i + 1}</i><span>{l}</span></li>)}</ol>;
}
