import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, useApi } from '../api';
import { ProductArt } from '../art/ProductArt';
import type { ArtKind, Tone } from '../art/tones';
import { useCart } from '../cart';
import { Icon } from '../components/Icon';
import { BasketLink } from '../components/Layout';
import { Conversation, RatingStars, ReviewList, apiMessage, type ReviewData } from '../components/Engagement';
import { Button, Chip, ProductCard, Stars } from '../components/ui';
import { dateRange, money, moneyShort } from '../format';
import { useDesktop } from '../hooks';
import { useSession, type ApiCard } from '../session';

interface Variant { id: string; options: Record<string, string>; priceCents: number; compareAtCents: number | null; available: boolean; left: number | null }
interface Media { id: string; kind: 'image' | 'video'; w640?: string; w1280?: string; src?: string; poster?: string }
interface Product {
  id: string; title: string; description: string; chip: string | null; oneOfAKind: boolean; onlyOne: boolean; madeToOrder: boolean; leadTimeDays: number | null; art: { kind: ArtKind; tone: Tone } | null;
  category: { slug: string; name: string; breadcrumbs: { slug: string; name: string }[] } | null; personalisation: { label: string; required: boolean; maxLength?: number }[];
  shop: { name: string; slug: string; city: string | null; region: string | null; logo: string | null; rating: { avg: number; count: number } | null; vacation: boolean }; processing: { minDays: number; maxDays: number }; returns: { text?: string } | null;
  options: { name: string; values: { value: string; swatch: string | null }[] }[]; defaultOptions: Record<string, string>; variants: Variant[]; media: Media[]; attributes: { key: string; label: string; display: string }[]; moreFromShop: ApiCard[]; similar: ApiCard[];
}
interface Ship { shippingCents: number; free: boolean; shipsInDays: { min: number; max: number }; arrives: { min: string; max: string }; freeOverCents: number | null }
const POSTAL_KEY = 'es_postal'; const store = { get: () => { try { return localStorage.getItem(POSTAL_KEY) ?? ''; } catch { return ''; } }, set: (v: string) => { try { localStorage.setItem(POSTAL_KEY, v); } catch { /* private mode */ } } };

function Hero({ p, variantImage }: { p: Product; variantImage?: string | null }) {
  const ref = useRef<HTMLDivElement>(null); const [i, setI] = useState(0); const n = Math.max(p.media.length, 1);
  useEffect(() => { const el = ref.current; if (!el) return; const f = () => setI(Math.round(el.scrollLeft / el.clientWidth)); el.addEventListener('scroll', f, { passive: true }); return () => el.removeEventListener('scroll', f); }, []);
  return <div className="pdp-hero"><div className="track" ref={ref} aria-label="Photos">
    {p.media.length ? p.media.map((m, k) => <div className="slide" key={m.id}>{m.kind === 'image' ? <img src={(k === 0 && variantImage) || m.w1280} alt={k === 0 ? p.title : ''} /> : <video src={m.src} poster={m.poster} controls playsInline preload="none" />}</div>)
      : <div className="slide">{p.art ? <ProductArt kind={p.art.kind} tone={p.art.tone} /> : <div className="skeleton" style={{ height: '100%' }} />}</div>}</div>
    {n > 1 && <div className="dots" aria-hidden="true">{Array.from({ length: n }, (_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>}</div>;
}

function ShipCard({ productId }: { productId: string }) {
  const [postal, setPostal] = useState(store.get()); const ok = /^[A-Za-z]\d[A-Za-z]/.test(postal.trim()); const { data, error } = useApi<Ship>(ok ? `/api/products/${productId}/shipping?postal=${encodeURIComponent(postal.trim())}` : null);
  return <div className="card shipcard"><span className="muted"><Icon name="truck" /></span>
    <div className="t">{data ? <><b>Ships in {data.shipsInDays.min === data.shipsInDays.max ? data.shipsInDays.min : `${data.shipsInDays.min}–${data.shipsInDays.max}`} days</b><div className="muted">Arrives {dateRange(data.arrives.min, data.arrives.max)} · {data.free ? 'Free shipping' : `${money(data.shippingCents)} to ${postal.trim().slice(0, 3).toUpperCase()}`}</div></>
      : <><b>Delivery estimate</b><div className="muted">{error ? 'That postal code does not look right.' : 'Enter your postal code'} <input aria-label="Postal code" value={postal} placeholder="T2N 1N4" maxLength={7} onChange={e => { setPostal(e.target.value); store.set(e.target.value); }} /></div></>}</div>
    {data && <button className="muted" style={{ marginLeft: 'auto', fontSize: 12 }} onClick={() => { setPostal(''); store.set(''); }}>Change</button>}</div>;
}

/** Arriving from a sponsored card carries a signed token: tell the server once (it charges the maker, or not), then tidy the address. */
function useAdClick() {
  useEffect(() => { const t = new URLSearchParams(location.search).get('ad'); if (!t) return; history.replaceState(null, '', location.pathname); api('/api/ads/click', { method: 'POST', body: { token: t } }).catch(() => {}); }, []);
}
function Reviews({ productId }: { productId: string }) {
  const [limit, setLimit] = useState(5); const { data, error } = useApi<ReviewData>(`/api/products/${productId}/reviews?limit=${limit}`);
  if (error || !data) return null;
  return <div className="pdp-section"><h2 className="serif">Reviews</h2><ReviewList data={data} more={data.items.length < data.count} onMore={() => setLimit(limit + 10)} /></div>;
}
/** "Ask the maker": a short question about this piece. Needs an account so the answer has somewhere to go. */
function AskMaker({ shop, productId, title }: { shop: string; productId: string; title: string }) {
  const { user, say } = useSession(); const nav = useNavigate(); const [open, setOpen] = useState(false); const [sent, setSent] = useState(false); const [err, setErr] = useState('');
  const send = async (body: string) => { try { await api(`/api/shops/${shop}/messages`, { method: 'POST', body: { productId, body } }); setSent(true); say('Message sent'); } catch (e) { setErr(apiMessage(e)); throw e; } };
  if (sent) return <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>Sent. Replies arrive in <Link to="/account/messages" style={{ textDecoration: 'underline' }}>your messages</Link> and by email.</p>;
  if (!open) return <Button variant="ghost" size="sm" style={{ marginTop: 12 }} onClick={() => (user ? setOpen(true) : nav(`/account?next=${encodeURIComponent(location.pathname)}`))}>{user ? 'Ask the maker a question' : 'Sign in to ask the maker a question'}</Button>;
  return <div className="rv-form"><b style={{ fontSize: 14 }}>About “{title}”</b><div style={{ marginTop: 10 }}><Conversation messages={[]} me="buyer" onSend={send} placeholder="Is it dishwasher safe? Can you make it in blue?" />{err && null}</div></div>;
}
export function ProductPage() {
  const { id = '' } = useParams(); useAdClick(); const nav = useNavigate(); const desktop = useDesktop(); const { data: p, error } = useApi<Product>(`/api/products/${id}`);
  const { add } = useCart(); const { savedProducts, toggleSaved, say, card } = useSession(); const [opts, setOpts] = useState<Record<string, string>>({}); const [pers, setPers] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  useEffect(() => { if (p) setOpts(p.defaultOptions); window.scrollTo(0, 0); }, [p?.id]);          // eslint-disable-line react-hooks/exhaustive-deps
  const variant = useMemo(() => p?.variants.find(v => Object.entries(opts).every(([k, x]) => v.options[k] === x)) ?? (p && !p.options.length ? p.variants[0] : undefined), [p, opts]);
  if (error) return <div className="empty"><h2 className="serif">We could not find that piece</h2><p>It may have sold out or been taken down.</p><Link to="/" className="btn" style={{ marginTop: 16 }}>Back to the shop</Link></div>;
  if (!p) return <div><div className="pdp-hero skeleton" style={{ borderRadius: 0 }} /><div className="pad" style={{ marginTop: 16 }}><div className="skeleton" style={{ height: 120 }} /></div></div>;
  const reachable = (name: string, value: string) => p.variants.some(v => v.available && v.options[name] === value && Object.entries(opts).every(([k, x]) => k === name || v.options[k] === x));
  const saved = savedProducts.has(p.id); const price = variant?.priceCents ?? Math.min(...p.variants.map(v => v.priceCents));
  const blocked = p.shop.vacation ? 'Shop is on vacation' : !variant ? 'Choose options' : !variant.available ? 'Sold out' : null;
  const addToBasket = async () => { setBusy(true); setMsg('');
    try { await add(variant!.id, 1); say('Added to basket'); } catch (e) { setMsg(e instanceof ApiError ? ({ out_of_stock: 'That one just sold out.', already_in_basket: 'This one-of-a-kind piece is already in your basket.', shop_on_vacation: 'This shop is on vacation.', personalisation_required: 'Please fill in the personalisation.' } as Record<string, string>)[e.code] ?? 'Could not add that. Try again.' : 'Could not add that. Try again.'); } finally { setBusy(false); } };
  const addWithPers = async () => { for (const f of p.personalisation) if (f.required && !pers[f.label]?.trim()) return setMsg(`Please fill in “${f.label}”.`); if (p.personalisation.length) await api('/api/cart/items', { method: 'POST', body: { variantId: variant!.id, quantity: 1, personalisation: pers } }).then(() => say('Added to basket'), () => setMsg('Could not add that.')); else await addToBasket(); };
  const info = <>
    <div className="pdp-body"><div>{p.chip && <Chip>{p.chip}</Chip>}</div>
      <h1 className="serif">{p.title}</h1>
      <div className="byline"><Link to={`/shop/${p.shop.slug}`} className="byline" style={{ marginTop: 0 }}><span className="lg">{p.shop.logo ? <img src={p.shop.logo} alt="" /> : <ProductArt kind="pottery" tone="warm" />}</span><b>{p.shop.name}</b></Link>
        {p.shop.rating && <span className="muted">· <Stars /> {p.shop.rating.avg.toFixed(1)} ({p.shop.rating.count})</span>}</div>
      <div className="price">{money(price)} {variant?.compareAtCents ? <s>{money(variant.compareAtCents)}</s> : null}<small> CAD · taxes added at checkout</small></div>
      {variant?.left != null && <div className="stockline">{p.onlyOne ? 'Only one available' : `Only ${variant.left} left`}</div>}
      {p.options.map(o => { const sw = o.values.every(v => v.swatch); return <div key={o.name}><div className={`optlabel${sw ? ' sw' : ''}`}>{o.name}</div>
        <div className={`optrow${sw ? ' sw' : ''}`} role="radiogroup" aria-label={o.name}>{o.values.map(v => { const on = opts[o.name] === v.value; return sw
          ? <button key={v.value} type="button" role="radio" aria-checked={on} aria-label={v.value} title={v.value} className={`swatch${on ? ' on' : ''}`} style={{ background: v.swatch! }} onClick={() => setOpts({ ...opts, [o.name]: v.value })} />
          : <button key={v.value} type="button" role="radio" aria-checked={on} className={`opt-pill${on ? ' on' : ''}`} disabled={!reachable(o.name, v.value) && !on} onClick={() => setOpts({ ...opts, [o.name]: v.value })}>{v.value}</button>; })}</div></div>; })}
      {p.personalisation.map(f => <label key={f.label} className="label">{f.label}{f.required ? '' : ' (optional)'}<input className="field" maxLength={f.maxLength} value={pers[f.label] ?? ''} onChange={e => setPers({ ...pers, [f.label]: e.target.value })} /></label>)}
      <ShipCard productId={p.id} />
      {desktop && <div style={{ display: 'flex', gap: 12, marginTop: 20 }}><Button block disabled={!!blocked || busy} onClick={addWithPers}>{blocked ?? 'Add to basket'}</Button><Button variant="ghost" aria-label="Save" onClick={() => toggleSaved(p.id)}><Icon name="heart" /></Button></div>}
      {p.madeToOrder && <div className="notice">Made to order{p.leadTimeDays ? `: allow about ${p.leadTimeDays} days before it ships.` : '.'}</div>}
      {msg && <div className="err" role="alert">{msg}</div>}
      {p.description && <div className="pdp-section"><h2 className="serif">About this piece</h2><p>{p.description}</p></div>}
      {p.attributes.length > 0 && <div className="pdp-section"><h2 className="serif">Details</h2><dl className="attrs">{p.attributes.map(a => <Fragment key={a.key}><dt>{a.label}</dt><dd>{a.display}</dd></Fragment>)}</dl></div>}
      {p.returns?.text && <div className="pdp-section"><h2 className="serif">Returns</h2><p>{p.returns.text}</p></div>}
      <Reviews productId={p.id} />
      <div className="pdp-section"><h2 className="serif">From {p.shop.name}{p.shop.city ? `, ${p.shop.city}` : ''}</h2><Link to={`/shop/${p.shop.slug}`} className="muted" style={{ fontSize: 14, textDecoration: 'underline' }}>Visit the shop</Link><div><AskMaker shop={p.shop.slug} productId={p.id} title={p.title} /></div></div>
      {p.moreFromShop.length > 0 && <div className="pdp-section"><h2 className="serif">More from {p.shop.name}</h2><div className="grid2">{p.moreFromShop.slice(0, 4).map(c => <ProductCard key={c.id} p={card(c)} />)}</div></div>}
      {p.similar.length > 0 && <div className="pdp-section" style={{ marginBottom: 130 }}><h2 className="serif">You may also like</h2><div className="grid2">{p.similar.slice(0, 4).map(c => <ProductCard key={c.id} p={card(c)} />)}</div></div>}
    </div></>;
  const bar = <div className="buybar"><div className="tot"><small>Total</small><b>{money(price)}</b></div>
    <Button disabled={!!blocked || busy} onClick={addWithPers}>{blocked ?? (busy ? 'Adding…' : 'Add to basket')}</Button>
    <Button variant="ghost" aria-label={saved ? 'Remove from saved' : 'Save'} aria-pressed={saved} onClick={() => toggleSaved(p.id)}><Icon name="heart" /></Button></div>;
  if (desktop) return <div className="dpad"><div className="crumbs" style={{ marginBottom: 18 }}><Link to="/">Home</Link>{p.category?.breadcrumbs.map(c => <span key={c.slug}> › <Link to={`/c/${c.slug}`}>{c.name}</Link></span>)}</div>
    <div className="pdp-desktop"><Hero p={p} /><div>{info}</div></div></div>;
  return <div className="screen" style={{ paddingBottom: 0 }}><button className="backbtn" aria-label="Back" onClick={() => (history.length > 1 ? nav(-1) : nav('/'))}><Icon name="chev" /></button><Hero p={p} /><div className="pad">{info}</div>{bar}</div>;
}
void BasketLink; void moneyShort;
