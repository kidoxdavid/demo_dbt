import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, useApi } from '../api';
import { ProductArt } from '../art/ProductArt';
import type { ArtKind, Tone } from '../art/tones';
import { useCart } from '../cart';
import { Icon } from '../components/Icon';
import { BasketLink } from '../components/Layout';
import { Button, Chip, ProductCard, Stars } from '../components/ui';
import { dateRange, money, moneyShort } from '../format';
import { useDesktop } from '../hooks';
import { useSession, type ApiCard } from '../session';

interface Variant { id: string; options: Record<string, string>; priceCents: number; compareAtCents: number | null; available: boolean; left: number | null }
interface Media { id: string; kind: 'image' | 'video'; w640?: string; w1280?: string; src?: string; poster?: string }
interface Product {
  id: string; title: string; description: string; chip: string | null; oneOfAKind: boolean; onlyOne: boolean; madeToOrder: boolean; leadTimeDays: number | null; art: { kind: ArtKind; tone: Tone } | null;
  category: { slug: string; name: string; breadcrumbs: { slug: string; name: string }[] } | null; personalisation: { label: string; required: boolean; maxLength?: number }[];
  shop: { name: string; slug: string; city: string; region: string; logo: string | null; rating: { avg: number; count: number } | null; vacation: boolean }; processing: { minDays: number; maxDays: number }; returns: { text?: string } | null;
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

export function ProductPage() {
  const { id = '' } = useParams(); const nav = useNavigate(); const desktop = useDesktop(); const { data: p, error } = useApi<Product>(`/api/products/${id}`);
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
      <div className="pdp-section"><h2 className="serif">From {p.shop.name}, {p.shop.city}</h2><Link to={`/shop/${p.shop.slug}`} className="muted" style={{ fontSize: 14, textDecoration: 'underline' }}>Visit the shop</Link></div>
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
