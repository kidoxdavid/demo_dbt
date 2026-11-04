import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorText, money } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';

type CartLine = { variantId: string; name: string; title: string; priceCents: number; qty: number };
const key = (slug: string) => `eazy_cart_${slug}`;
function useCart(slug: string) {
  const read = (): CartLine[] => { try { return JSON.parse(localStorage.getItem(key(slug)) ?? '[]'); } catch { return []; } };
  const [lines, setLines] = useState<CartLine[]>(read);
  const save = (l: CartLine[]) => { setLines(l); try { localStorage.setItem(key(slug), JSON.stringify(l)); } catch { /* storage unavailable: cart lives in memory */ } };
  return {
    lines, subtotal: lines.reduce((n, l) => n + l.priceCents * l.qty, 0), count: lines.reduce((n, l) => n + l.qty, 0),
    add: (l: Omit<CartLine, 'qty'>) => save(lines.some(x => x.variantId === l.variantId) ? lines.map(x => x.variantId === l.variantId ? { ...x, qty: Math.min(x.qty + 1, 100) } : x) : [...lines, { ...l, qty: 1 }]),
    setQty: (id: string, q: number) => save(q <= 0 ? lines.filter(x => x.variantId !== id) : lines.map(x => x.variantId === id ? { ...x, qty: Math.min(q, 100) } : x)),
    clear: () => save([]),
  };
}

function useStore(slug: string) {
  const [store, setStore] = useState<any>(null); const [missing, setMissing] = useState(false);
  useEffect(() => { api(`/api/public/stores/${slug}`).then(setStore).catch(e => { if (e instanceof ApiError && e.status === 404) setMissing(true); }); }, [slug]);
  return { store, missing };
}

export function Storefront() {
  const { slug = '' } = useParams(); const { store, missing } = useStore(slug); const cart = useCart(slug);
  const [products, setProducts] = useState<any[] | null>(null); const [sel, setSel] = useState<Record<string, string>>({});
  useEffect(() => { if (store) api(`/api/public/stores/${slug}/products?limit=100`).then(setProducts); }, [store, slug]);
  if (missing) return <div className="wrap"><h1>Store not found</h1><p>This store doesn't exist or isn't open yet.</p></div>;
  if (!store) return <div className="wrap"><p>Loading…</p></div>;
  return <>
    <header className="top"><div className="wrap"><span className="logo">{store.name}</span>
      <Link className="btn secondary" to={`/store/${slug}/checkout`}>Cart ({cart.count})</Link></div></header>
    <main className="wrap">
      <div className="store-head"><h1>{store.name}</h1>{store.tagline && <p className="muted">{store.tagline}</p>}
        <p className="muted small">{[store.fulfilment.pickup && 'Pickup available', store.fulfilment.delivery && `Delivery ${store.deliveryFeeCents ? money(store.deliveryFeeCents, store.currency) : 'free'}`].filter(Boolean).join(' · ')}</p></div>
      {products && !products.length && <Empty title="No products yet">This store hasn't added products. Check back soon.</Empty>}
      <div className="products">
        {products?.map(p => {
          const vid = sel[p.id] ?? p.variants[0].id; const v = p.variants.find((x: any) => x.id === vid);
          return <article className="card" key={p.id} style={{ margin: 0 }}>
            <div className="pimg" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</div>
            <h3>{p.name}</h3>{p.brand && <div className="muted small">{p.brand}</div>}
            {p.description && <p className="small muted">{p.description}</p>}
            {p.variants.length > 1 && <Field label="Option">{id => <select id={id} value={vid} onChange={e => setSel({ ...sel, [p.id]: e.target.value })}>
              {p.variants.map((x: any) => <option key={x.id} value={x.id}>{x.title} — {money(x.priceCents, store.currency)}{x.available ? '' : ' (sold out)'}</option>)}</select>}</Field>}
            <p><b>{money(v.priceCents, store.currency)}</b></p>
            <button disabled={!v.available} onClick={() => cart.add({ variantId: v.id, name: p.name, title: v.title, priceCents: v.priceCents })}>{v.available ? 'Add to cart' : 'Sold out'}</button>
          </article>;
        })}
      </div>
    </main>
    {cart.count > 0 && <div className="cartbar"><div className="wrap row spread"><span>{cart.count} item(s) · <b>{money(cart.subtotal, store.currency)}</b></span>
      <Link className="btn" to={`/store/${slug}/checkout`}>Checkout</Link></div></div>}
  </>;
}

export function StoreCheckout() {
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
      const body: any = { items: cart.lines.map(l => ({ variantId: l.variantId, quantity: l.qty })), email: f.email, name: f.name, fulfilment: f.fulfilment };
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
      <h1>Your cart</h1>
      {!cart.lines.length ? <Empty title="Your cart is empty"><Link to={`/store/${slug}`}>Keep shopping</Link></Empty> : <>
        <section className="card"><ul className="list">{cart.lines.map(l => <li key={l.variantId} className="row spread">
          <span>{l.name}{l.title !== 'Default' ? ` (${l.title})` : ''}<br /><span className="muted small">{money(l.priceCents, store.currency)} each</span></span>
          <span className="row"><button className="secondary" aria-label={`Decrease ${l.name}`} onClick={() => cart.setQty(l.variantId, l.qty - 1)}>−</button>
            <span aria-live="polite">{l.qty}</span><button className="secondary" aria-label={`Increase ${l.name}`} onClick={() => cart.setQty(l.variantId, l.qty + 1)}>+</button></span></li>)}</ul>
          <p>Subtotal: {money(cart.subtotal, store.currency)}<br />Delivery: {money(shipping, store.currency)}<br /><b>Total: {money(cart.subtotal + shipping, store.currency)}</b></p>
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
  const { token = '' } = useParams(); const [o, setO] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { api(`/api/public/orders/${token}`).then(setO).catch(e => setErr(errorText(e))); }, [token]);
  return <main className="wrap" style={{ maxWidth: 560 }}>
    {err && <Alert kind="err">Order not found.</Alert>}
    {o && <><h1>Order #{o.number}</h1>
      {o.status === 'paid' && <Alert kind="ok">Thank you! Your order is confirmed. (Simulated payment in this development build.)</Alert>}
      <section className="card"><div className="row spread"><b>Status</b><Badge s={o.status} /></div>
        <table><tbody>{o.items.map((i: any, n: number) => <tr key={n}><td>{i.name} × {i.quantity}</td><td>{money(i.unit_price_cents * i.quantity, o.currency)}</td></tr>)}
          <tr><td>Delivery</td><td>{money(o.shipping_cents, o.currency)}</td></tr><tr><td><b>Total</b></td><td><b>{money(o.total_cents, o.currency)}</b></td></tr></tbody></table>
        <p className="muted small">Bookmark this page to follow your order.</p></section></>}
  </main>;
}
