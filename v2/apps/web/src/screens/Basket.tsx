import { useState } from 'react';
import { useFlag } from '../flags';
import { Link } from 'react-router-dom';
import { ProductArt } from '../art/ProductArt';
import type { ArtKind, Tone } from '../art/tones';
import { useCart, type CartLine, type CartSeller } from '../cart';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
import { dateRange, money } from '../format';
import { useDesktop } from '../hooks';
import { useSession } from '../session';

const ISSUES: Record<string, string> = { unavailable: 'No longer available', vacation: 'Shop is on vacation', out_of_stock: 'Not enough in stock' };
function Line({ l }: { l: CartLine }) {
  const { setQty, remove } = useCart(); const [err, setErr] = useState('');
  const max = l.oneOfAKind ? 1 : Math.min(20, l.available ?? 20);
  const change = async (v: string) => { setErr(''); try { v === '0' ? await remove(l.id) : await setQty(l.id, Number(v)); } catch { setErr('Could not update that.'); } };
  return <div className="bline"><Link to={`/p/${l.productId}`} className="im">{l.image ? <img src={l.image} alt="" /> : l.art ? <ProductArt kind={l.art.kind as ArtKind} tone={l.art.tone as Tone} /> : null}</Link>
    <div className="tx"><b>{l.title}</b>{l.variant && <div className="v">{l.variant}</div>}
      <select className="qty" aria-label={`Quantity for ${l.title}`} value={l.quantity} onChange={e => change(e.target.value)}>{Array.from({ length: Math.max(max, l.quantity) }, (_, i) => <option key={i + 1} value={i + 1}>Qty {i + 1}</option>)}<option value="0">Remove</option></select>
      {l.issue && <div className="warn" role="alert">{ISSUES[l.issue] ?? l.issue}{l.issue === 'out_of_stock' && l.available != null ? ` (${l.available} left)` : ''}</div>}{err && <div className="warn">{err}</div>}</div>
    <b>{money(l.lineCents)}</b></div>;
}
function Group({ s }: { s: CartSeller }) {
  return <div className="card group"><div className="gh"><span className="lg">{s.shop.logo ? <img src={s.shop.logo} alt="" /> : <ProductArt kind="pottery" tone="warm" />}</span><Link to={`/shop/${s.shop.slug}`}><b>{s.shop.name}</b></Link><span className="eta">{dateRange(s.eta.min, s.eta.max)}</span></div>
    {s.lines.map(l => <Line key={l.id} l={l} />)}
    <div className="shiprow"><span><Icon name="truck" /> Shipping</span><span>{s.shippingCents === 0 ? 'Free' : money(s.shippingCents)}</span></div></div>;
}
const GiftIfOn = () => (useFlag('gift_options') ? <Gift /> : null);
/** One "This is a gift" card for the whole basket (as in the mockup); it is saved per maker, so every maker gets the same note. */
function Gift() {
  const { cart, setGift } = useCart(); const [open, setOpen] = useState(false); const on = cart.sellers.length > 0 && cart.sellers.every(s => s.gift?.isGift); const [msg, setMsg] = useState(cart.sellers[0]?.gift?.message ?? '');
  const all = async (isGift: boolean, message: string) => { for (const s of cart.sellers) await setGift(s.sellerId, isGift, message); };
  return <div className="card" style={{ marginTop: 14, padding: '14px 16px' }}><button className="giftcard" style={{ margin: 0, padding: 0 }} aria-expanded={open} onClick={() => on ? setOpen(!open) : all(true, '').then(() => setOpen(true))}><span>🎁 This is a gift</span><span>{on && cart.sellers[0]?.gift?.message ? 'Edit message' : 'Add a message'}</span></button>
    {on && open && <div style={{ marginTop: 10 }}><label className="label" style={{ marginTop: 0 }} htmlFor="gift-msg">Message to include</label><textarea id="gift-msg" className="field" rows={3} maxLength={300} value={msg} onChange={e => setMsg(e.target.value)} />
      <div className="sheet row" style={{ padding: 0 }}><Button variant="ghost" size="sm" onClick={() => all(false, '').then(() => setOpen(false))}>Not a gift</Button><Button size="sm" onClick={() => all(true, msg).then(() => setOpen(false))}>Save message</Button></div></div>}</div>;
}

/** Basket. Matches reference buyer-basket.png (phone). One card per maker: each ships separately with its own delivery window. */
export function BasketPage() {
  const { cart, ready } = useCart(); const desktop = useDesktop(); const { user } = useSession(); void user;
  if (ready && cart.count === 0) return <div className={desktop ? 'dpad' : 'screen'}><div className="empty" style={{ paddingTop: 80 }}><h1 className="serif" style={{ fontSize: 30, color: 'var(--ink)' }}>Your basket is empty</h1><p style={{ marginTop: 8 }}>Pieces you add will wait here.</p><Link to="/" className="btn" style={{ marginTop: 18 }}>Browse the shop</Link></div></div>;
  const makers = cart.sellers.length; const total = cart.totalCents;
  const head = <div className="bk-head"><h1 className="serif" style={{ fontSize: 30 }}>Your basket</h1><p>{makers} maker{makers === 1 ? '' : 's'}{makers > 1 ? ' · ships separately' : ''} · <Link to="/" className="tl" style={{ textDecoration: 'underline' }}>Continue shopping</Link></p></div>;
  const groups = <>{cart.sellers.map(s => <Group key={s.sellerId} s={s} />)}<GiftIfOn /></>;
  const checkout = <Button to={cart.blocked ? undefined : '/checkout'} disabled={cart.blocked} aria-disabled={cart.blocked}>{cart.blocked ? 'Fix the items above' : `Checkout · ${money(total)} incl. GST`}</Button>;
  if (desktop) return <div className="dpad"><div className="bk-desktop"><div>{head}{groups}</div><div className="card sum"><b>Order summary</b><div className="r"><span>Subtotal · {cart.count} item{cart.count === 1 ? '' : 's'}</span><b>{money(cart.itemsCents)}</b></div><div className="r"><span>Shipping</span><b>{money(cart.shippingCents)}</b></div><div className="r"><span>GST</span><b>{money(cart.taxCents)}</b></div>{checkout}</div></div></div>;
  return <div className="screen" style={{ paddingBottom: 190 }}><div className="pad" style={{ paddingTop: 4 }}>{head}{groups}</div>
    <div className="summarybar"><div className="r"><span>Subtotal · {cart.count} item{cart.count === 1 ? '' : 's'}</span><b>{money(cart.itemsCents)}</b></div><div className="r"><span>Shipping</span><b>{money(cart.shippingCents)}</b></div>{checkout}</div></div>;
}
