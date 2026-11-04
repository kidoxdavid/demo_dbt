import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorText, money } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';
import { PCard } from './Market';

/** Marks customer-facing pages so the refined public theme applies (body.pub). */
export function usePub() { useEffect(() => { document.body.classList.add('pub'); return () => document.body.classList.remove('pub'); }, []); }

export type CartLine = { key: string; variantId: string; name: string; title: string; priceCents: number; qty: number; custom?: Record<string, string>; customView?: { label: string; value: string; type: string }[] };
const key = (slug: string) => `eazy_cart_${slug}`;
const lineKey = (variantId: string, custom?: Record<string, string>) => variantId + JSON.stringify(Object.entries(custom ?? {}).sort());
/** Remember which share link brought the shopper (feeds the seller's sales-by-channel report). */
export function rememberSource(slug: string, src: string | null) { try { if (src && /^[a-z0-9_-]{1,40}$/.test(src)) sessionStorage.setItem(`eazy_src_${slug}`, src); } catch { /* storage unavailable */ } }
export function recalledSource(slug: string): string | undefined { try { return sessionStorage.getItem(`eazy_src_${slug}`) ?? undefined; } catch { return undefined; } }

export function useCart(slug: string) {
  const read = (): CartLine[] => { try { return (JSON.parse(localStorage.getItem(key(slug)) ?? '[]') as CartLine[]).map(l => ({ ...l, key: l.key ?? lineKey(l.variantId, l.custom) })); } catch { return []; } };
  const [lines, setLines] = useState<CartLine[]>(read);
  const save = (l: CartLine[]) => { setLines(l); try { localStorage.setItem(key(slug), JSON.stringify(l)); } catch { /* storage unavailable: cart lives in memory */ } };
  return {
    lines, subtotal: lines.reduce((n, l) => n + l.priceCents * l.qty, 0), count: lines.reduce((n, l) => n + l.qty, 0),
    add: (l: Omit<CartLine, 'qty' | 'key'>) => { const k = lineKey(l.variantId, l.custom); save(lines.some(x => x.key === k) ? lines.map(x => x.key === k ? { ...x, qty: Math.min(x.qty + 1, 100) } : x) : [...lines, { ...l, key: k, qty: 1 }]); },
    setQty: (k: string, q: number) => save(q <= 0 ? lines.filter(x => x.key !== k) : lines.map(x => x.key === k ? { ...x, qty: Math.min(q, 100) } : x)),
    clear: () => save([]),
  };
}

export function useStore(slug: string) {
  const [store, setStore] = useState<any>(null); const [missing, setMissing] = useState(false);
  useEffect(() => { api(`/api/public/stores/${slug}`).then(setStore).catch(e => { if (e instanceof ApiError && e.status === 404) setMissing(true); }); }, [slug]);
  return { store, missing };
}

export function Storefront() {
  usePub();
  const { slug = '' } = useParams(); const [sp] = useSearchParams(); useEffect(() => rememberSource(slug, sp.get('src')), [slug, sp]); const { store, missing } = useStore(slug); const cart = useCart(slug);
  const [products, setProducts] = useState<any[] | null>(null);
  useEffect(() => { if (store) api(`/api/public/stores/${slug}/products?limit=100`).then(setProducts); }, [store, slug]);
  if (missing) return <div className="wrap"><h1>Store not found</h1><p>This store doesn't exist or isn't open yet.</p></div>;
  if (!store) return <div className="wrap"><p className="muted">Loading…</p></div>;
  const accent = /^#[0-9a-f]{6}$/i.test(store.theme?.accent ?? '') ? store.theme.accent : '#141414';
  const dark = store.theme?.hero === 'dark'; const spacious = store.theme?.layout === 'spacious';
  const info = [store.fulfilment.pickup && 'Pickup', store.fulfilment.delivery && `Delivery ${store.deliveryFeeCents ? money(store.deliveryFeeCents, store.currency) : 'free'}`].filter(Boolean).join(' · ');
  return <div style={{ ['--btn' as any]: accent, ['--a' as any]: accent }}>
    <header className="ptop"><div className="wrap pbar"><Link to="/" className="plogo" aria-label="Back to the marketplace">Eazy<i>Stores</i></Link>
      <span className="pstore">{store.name}</span>
      <div className="pright"><Link className="plink" to={`/store/${slug}/checkout`}>Cart ({cart.count})</Link></div></div></header>
    <section className={`shero${dark ? ' dark' : ''}`}><div className="wrap">
      <span className="kicker">{[store.category, store.city].filter(Boolean).join(' · ')}</span>
      <h1>{store.name}</h1>{store.tagline && <p className="lede">{store.tagline}</p>}
      <p className="meta">{info}</p>
    </div></section>
    <main className="wrap">
      {products && !products.length && <Empty title="Nothing here yet">This store hasn't added products. Check back soon.</Empty>}
      {products && products.length > 0 && <div className="shead"><h2>Collection</h2><span className="muted small">{products.length} {products.length === 1 ? 'piece' : 'pieces'}</span></div>}
      <div className={`pgrid${spacious ? ' wide' : ''}`}>
        {products?.map(p => {
          const prices = p.variants.map((x: any) => x.priceCents); const lo = Math.min(...prices), hi = Math.max(...prices);
          return <PCard key={p.id} p={{ id: p.id, name: p.name, storeSlug: slug, storeName: p.brand || store.name, currency: store.currency, priceFrom: lo, priceTo: hi,
            image: p.images?.[0], image2: p.images?.[1], available: p.variants.some((x: any) => x.available), madeToOrder: p.madeToOrder }} />;
        })}
      </div>
    </main>
    {cart.count > 0 && <div className="cartbar"><div className="wrap row spread"><span>{cart.count} item{cart.count > 1 ? 's' : ''} · <b>{money(cart.subtotal, store.currency)}</b></span>
      <Link className="btn sm" to={`/store/${slug}/checkout`}>Checkout</Link></div></div>}
  </div>;
}

export function StoreCheckout() {
  usePub();
  const { slug = '' } = useParams(); const nav = useNavigate(); const { store, missing } = useStore(slug); const cart = useCart(slug);
  const [f, setF] = useState({ name: '', email: '', fulfilment: 'pickup', line1: '', city: '', region: '', postalCode: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [placed, setPlaced] = useState<any>(null);
  useEffect(() => { if (store && !store.fulfilment.pickup && store.fulfilment.delivery) setF(p => ({ ...p, fulfilment: 'delivery' })); }, [store]);
  if (missing) return <div className="wrap"><h1>Store not found</h1></div>;
  if (!store) return <div className="wrap"><p>Loading…</p></div>;
  const shipping = f.fulfilment === 'delivery' ? store.deliveryFeeCents : 0;

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const body: any = { items: cart.lines.map(l => ({ variantId: l.variantId, quantity: l.qty, ...(l.custom && Object.keys(l.custom).length ? { customizations: l.custom } : {}) })), email: f.email, name: f.name, fulfilment: f.fulfilment, ...(recalledSource(slug) ? { source: recalledSource(slug) } : {}) };
      if (f.fulfilment === 'delivery') body.address = { line1: f.line1, city: f.city, region: f.region, postalCode: f.postalCode, country: 'CA' };
      setPlaced(await api(`/api/public/stores/${slug}/checkout`, { body }));
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  async function simulate(outcome: 'succeeded' | 'failed') {
    setBusy(true); setErr('');
    try {
      await api(`/api/public/payments/${placed.paymentId}/simulate`, { body: { outcome } });
      if (outcome === 'succeeded') { cart.clear(); nav(`/order/${placed.orderToken}`); } else setErr('Payment failed. Your items were released. You can try again.');
      if (outcome === 'failed') setPlaced(null);
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }

  if (placed) return <>
    <header className="top"><div className="wrap"><span className="logo">{store.name}</span></div></header>
    <main className="wrap" style={{ maxWidth: 560 }}>
      <h1>Pay for order #{placed.orderNumber}</h1>
      {err && <Alert kind="err">{err}</Alert>}
      <p>Total: <b>{money(placed.totalCents, placed.currency)}</b>{placed.shippingCents ? ` (includes ${money(placed.shippingCents, placed.currency)} delivery)` : ''}</p>
      {placed.paymentProvider.status === 'simulated'
        ? <section className="card sim"><h2 style={{ marginTop: 0 }}>Test payment (simulated)</h2>
            <p>This is a development stand-in for a payment provider. <b>No real money moves and no card is needed.</b> Your items are held for a limited time.</p>
            <div className="row"><button disabled={busy} onClick={() => simulate('succeeded')}>Simulate successful payment</button>
              <button className="secondary" disabled={busy} onClick={() => simulate('failed')}>Simulate failed payment</button></div></section>
        : <Alert kind="warn">Online card payment is not available for this store yet.</Alert>}
    </main></>;

  return <>
    <header className="top"><div className="wrap"><Link to={`/store/${slug}`} className="logo">{store.name}</Link></div></header>
    <main className="wrap" style={{ maxWidth: 640 }}>
      <h1 style={{ marginTop: 32 }}>Your cart</h1>
      {!cart.lines.length ? <Empty title="Your cart is empty"><Link to={`/store/${slug}`}>Keep shopping</Link></Empty> : <>
        <section className="card"><ul className="list">{cart.lines.map(l => <li key={l.key} className="row spread">
          <span>{l.name}{l.title !== 'Default' ? ` (${l.title})` : ''}<br /><span className="muted small">{money(l.priceCents, store.currency)} each</span>
            {l.customView?.map(v => <span key={v.label} className="muted small" style={{ display: 'block' }}>{v.label}: {v.type === 'image' ? 'photo attached' : v.value}</span>)}</span>
          <span className="qty"><button className="secondary" aria-label={`Decrease ${l.name}`} onClick={() => cart.setQty(l.key, l.qty - 1)}>−</button>
            <span aria-live="polite">{l.qty}</span><button className="secondary" aria-label={`Increase ${l.name}`} onClick={() => cart.setQty(l.key, l.qty + 1)}>+</button></span></li>)}</ul>
          <div className="sumline"><span>Subtotal</span><span>{money(cart.subtotal, store.currency)}</span></div>
          <div className="sumline"><span>Delivery</span><span>{money(shipping, store.currency)}</span></div>
          <div className="sumline total"><span>Total</span><span>{money(cart.subtotal + shipping, store.currency)}</span></div>
          <p className="muted small">Final prices are confirmed by the store when you place the order. Taxes are not yet calculated.</p></section>
        <form className="card" onSubmit={submit}>
          {err && <Alert kind="err">{err}</Alert>}
          <Field label="Name">{id => <input id={id} required autoComplete="name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Email" hint="We'll send your order status here.">{id => <input id={id} type="email" required autoComplete="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label="How would you like to receive it?">{id => <select id={id} value={f.fulfilment} onChange={e => setF({ ...f, fulfilment: e.target.value })}>
            {store.fulfilment.pickup && <option value="pickup">Pickup</option>}{store.fulfilment.delivery && <option value="delivery">Delivery ({money(store.deliveryFeeCents, store.currency)})</option>}</select>}</Field>
          {f.fulfilment === 'delivery' && <>
            <Field label="Street address">{id => <input id={id} required autoComplete="address-line1" value={f.line1} onChange={e => setF({ ...f, line1: e.target.value })} />}</Field>
            <Field label="City">{id => <input id={id} required autoComplete="address-level2" value={f.city} onChange={e => setF({ ...f, city: e.target.value })} />}</Field>
            <Field label="Province">{id => <input id={id} required autoComplete="address-level1" value={f.region} onChange={e => setF({ ...f, region: e.target.value })} />}</Field>
            <Field label="Postal code">{id => <input id={id} required autoComplete="postal-code" value={f.postalCode} onChange={e => setF({ ...f, postalCode: e.target.value })} />}</Field></>}
          <p><button disabled={busy || (!store.fulfilment.pickup && !store.fulfilment.delivery)}>{busy ? 'Placing order…' : 'Continue to payment'}</button></p>
          {!store.fulfilment.pickup && !store.fulfilment.delivery && <Alert kind="warn">This store hasn't set up delivery or pickup yet.</Alert>}
        </form></>}
    </main></>;
}

export function OrderStatus() {
  usePub();
  const { token = '' } = useParams(); const [o, setO] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { api(`/api/public/orders/${token}`).then(setO).catch(e => setErr(errorText(e))); }, [token]);
  return <main className="wrap" style={{ maxWidth: 560 }}>
    {err && <Alert kind="err">Order not found.</Alert>}
    {o && <><h1>Order #{o.number}</h1>
      {o.status === 'paid' && <Alert kind="ok">Thank you! Your order is confirmed. (Simulated payment in this development build.)</Alert>}
      <section className="card"><div className="row spread"><b>Status</b><Badge s={o.status} /></div>
        <table><tbody>{o.items.map((i: any, n: number) => <tr key={n}><td>{i.name} × {i.quantity}</td><td>{money(i.unit_price_cents * i.quantity, o.currency)}</td></tr>)}
          <tr><td>Delivery</td><td>{money(o.shipping_cents, o.currency)}</td></tr><tr><td><b>Total</b></td><td><b>{money(o.total_cents, o.currency)}</b></td></tr>
          {o.refunded_cents > 0 && <tr><td>Refunded</td><td>−{money(o.refunded_cents, o.currency)}</td></tr>}</tbody></table>
        <p className="muted small">Bookmark this page to follow your order.</p></section></>}
  </main>;
}
