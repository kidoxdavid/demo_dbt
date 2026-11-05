import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, apiWithTotal, ApiError, errorText, money, PROVINCES } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';
import { PCard } from './Market';
import { useCart } from '../cart';
import { StoreHeader, CartDrawer, FollowButton, Timeline, deliveryLines, Qty } from './CustomerUi';

/** Marks customer-facing pages so the refined public theme applies (body.pub). */
export function usePub() { useEffect(() => { document.body.classList.add('pub'); return () => document.body.classList.remove('pub'); }, []); }

export type { CartLine } from '../cart';
export { useCart } from '../cart';
/** Remember which share link brought the shopper (feeds the seller's sales-by-channel report). */
export function rememberSource(slug: string, src: string | null) { try { if (src && /^[a-z0-9_-]{1,40}$/.test(src)) sessionStorage.setItem(`eazy_src_${slug}`, src); } catch { /* storage unavailable */ } }
export function recalledSource(slug: string): string | undefined { try { return sessionStorage.getItem(`eazy_src_${slug}`) ?? undefined; } catch { return undefined; } }

export function useStore(slug: string) {
  const [store, setStore] = useState<any>(null); const [missing, setMissing] = useState(false);
  useEffect(() => { api(`/api/public/stores/${slug}`).then(setStore).catch(e => { if (e instanceof ApiError && e.status === 404) setMissing(true); }); }, [slug]);
  return { store, missing };
}

export function Storefront() {
  usePub();
  const { slug = '' } = useParams(); const [sp] = useSearchParams(); useEffect(() => rememberSource(slug, sp.get('src')), [slug, sp]); const { store, missing } = useStore(slug); const cart = useCart(slug);
  const [products, setProducts] = useState<any[] | null>(null); const [total, setTotal] = useState(0); const [q, setQ] = useState(''); const [sort, setSort] = useState('new'); const [everHad, setEverHad] = useState(false);
  const qs = (offset: number) => new URLSearchParams({ limit: '24', offset: String(offset), sort, ...(q.trim() && { q: q.trim() }) }).toString();
  useEffect(() => {
    if (!store) return; const t = setTimeout(() => apiWithTotal(`/api/public/stores/${slug}/products?${qs(0)}`).then(r => { setProducts(r.data); setTotal(r.total); if (r.total > 0) setEverHad(true); }), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [store, slug, q, sort]); // eslint-disable-line
  const more = async () => { const r = await apiWithTotal(`/api/public/stores/${slug}/products?${qs(products?.length ?? 0)}`); setProducts(p => [...(p ?? []), ...r.data]); };
  if (missing) return <div className="wrap"><h1>Store not found</h1><p>This store doesn't exist or isn't open yet.</p></div>;
  if (!store) return <div className="wrap"><p className="muted">Loading…</p></div>;
  const accent = /^#[0-9a-f]{6}$/i.test(store.theme?.accent ?? '') ? store.theme.accent : '#141414';
  const dark = store.theme?.hero === 'dark'; const spacious = store.theme?.layout === 'spacious';
  const info = [store.fulfilment.pickup && 'Pickup', store.fulfilment.delivery && ((store.deliveryRules ?? []).length ? `Delivery from ${money(Math.min(...store.deliveryRules.map((r: any) => r.priceCents)), store.currency)}` : `Delivery ${store.deliveryFeeCents ? money(store.deliveryFeeCents, store.currency) : 'free'}`)].filter(Boolean).join(' · ');
  return <div style={{ ['--btn' as any]: accent, ['--a' as any]: accent }}>
    <StoreHeader store={store} slug={slug} />
    <CartDrawer store={store} slug={slug} />
    <section className={`shero${dark ? ' dark' : ''}`}><div className="wrap">
      <span className="kicker">{[store.category, store.city].filter(Boolean).join(' · ')}</span>
      <h1>{store.name}</h1>{store.verified && <span className="vbadge" title="EazyStores staff reviewed this seller's registration details">✓ Verified seller</span>}{store.tagline && <p className="lede">{store.tagline}</p>}
      <p className="meta"><span>{info}</span><FollowButton slug={slug} dark={dark} /></p>
    </div></section>
    <main className="wrap">
      {products && !products.length && !everHad && <Empty title="Nothing here yet">This store hasn't added products. Check back soon.</Empty>}
      {(everHad || (products && products.length > 0)) && <div className="shead"><h2>Collection</h2><span className="muted small">{total} {total === 1 ? 'piece' : 'pieces'}</span></div>}
      {everHad && <div className="storetools"><input type="search" aria-label="Search this store" placeholder="Search this store" value={q} onChange={e => setQ(e.target.value)} />
        <select aria-label="Sort" value={sort} onChange={e => setSort(e.target.value)}><option value="new">Newest</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option></select></div>}
      {products && !products.length && everHad && <Empty title="No matches">Try a different word, or clear the search.</Empty>}
      <div className={`pgrid${spacious ? ' wide' : ''}`}>
        {products?.map(p => {
          const prices = p.variants.map((x: any) => x.priceCents); const lo = Math.min(...prices), hi = Math.max(...prices); const left = p.variants.filter((x: any) => x.left).map((x: any) => x.left);
          const one = p.variants.length === 1 && p.variants[0].available && !p.comingSoon && !(p.customFields ?? []).length;
          return <PCard key={p.id} p={{ id: p.id, name: p.name, storeSlug: slug, storeName: p.brand || store.name, currency: store.currency, priceFrom: lo, priceTo: hi, rating: p.rating, comingSoon: p.comingSoon, availableFrom: p.availableFrom,
            image: p.images?.[0], image2: p.images?.[1], available: p.variants.some((x: any) => x.available), madeToOrder: p.madeToOrder, low: left.length && p.variants.every((x: any) => !x.available || x.left) ? Math.min(...left) : undefined }}
            quick={one ? () => cart.add({ variantId: p.variants[0].id, name: p.name, title: p.variants[0].title, priceCents: p.variants[0].priceCents, image: p.images?.[0] ? `${p.images[0]}?w=480` : undefined }) : undefined} />;
        })}
      </div>
      {products && products.length < total && <p style={{ textAlign: 'center', padding: '0 0 90px' }}><button className="secondary" onClick={more}>Show more</button></p>}
    </main>
</div>;
}

function discountText(code: string) {
  const [, why, extra] = code.split(':');
  return ({ not_found: 'That code is not valid.', inactive: 'That code is no longer active.', not_started: 'That code is not active yet.', expired: 'That code has expired.', used_up: 'That code has been fully used.', used_by_you: 'You have already used that code the maximum number of times.',
    not_applicable: 'Free delivery only applies to delivery orders with a delivery fee.', min_subtotal: `That code needs an order of at least $${(Number(extra) / 100).toFixed(2)}.` } as Record<string, string>)[why] ?? 'That code cannot be used.';
}
export function StoreCheckout() {
  usePub();
  const { slug = '' } = useParams(); const nav = useNavigate(); const { store, missing } = useStore(slug); const cart = useCart(slug);
  const [f, setF] = useState({ name: '', email: '', fulfilment: 'pickup', line1: '', city: '', region: '', postalCode: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [placed, setPlaced] = useState<any>(null);
  const [code, setCode] = useState(''); const [appliedCode, setAppliedCode] = useState(''); const [me, setMe] = useState<any>(null);
  useEffect(() => { api('/api/me').then(m => { setMe(m); setF(p => ({ ...p, name: p.name || m.fullName, email: p.email || m.email })); }).catch(() => {}); }, []);   // signed-in customers are pre-filled
  useEffect(() => { if (store && !store.fulfilment.pickup && store.fulfilment.delivery) setF(p => ({ ...p, fulfilment: 'delivery' })); }, [store]);
  // The cart shows exactly what checkout will charge, including tax, by asking the same pricing code the server uses.
  const [quote, setQuote] = useState<any>(null); const [quoteErr, setQuoteErr] = useState('');
  const quoteKey = JSON.stringify([cart.lines.map(l => [l.variantId, l.qty]), f.fulfilment, f.region, appliedCode]);
  useEffect(() => {
    if (!store || !cart.lines.length) { setQuote(null); return; }
    const qty = new Map<string, number>(); for (const l of cart.lines) qty.set(l.variantId, (qty.get(l.variantId) ?? 0) + l.qty);
    let cancelled = false;
    api(`/api/public/stores/${slug}/quote`, { body: { items: [...qty].map(([variantId, quantity]) => ({ variantId, quantity })), fulfilment: f.fulfilment, ...(f.fulfilment === 'delivery' && f.region ? { region: f.region } : {}), ...(appliedCode ? { discountCode: appliedCode } : {}) } })
      .then(q => { if (!cancelled) { setQuote(q); setQuoteErr(''); } })
      .catch(e => { if (!cancelled) { setQuote(null); setQuoteErr(e instanceof ApiError && e.code === 'tax_region_unknown' ? 'Choose your province so we can work out tax.' : e instanceof ApiError && e.code === 'no_shipping_option' ? 'This seller does not deliver to that province or order size. Try pickup or another address.' : e instanceof ApiError && e.code.startsWith('discount_invalid') ? discountText(e.code) : errorText(e)); } });
    return () => { cancelled = true; };
  }, [quoteKey, store]); // eslint-disable-line
  if (missing) return <div className="wrap"><h1>Store not found</h1></div>;
  if (!store) return <div className="wrap"><p>Loading…</p></div>;
  const shipping = f.fulfilment === 'delivery' ? store.deliveryFeeCents : 0;

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const body: any = { items: cart.lines.map(l => ({ variantId: l.variantId, quantity: l.qty, ...(l.custom && Object.keys(l.custom).length ? { customizations: l.custom } : {}) })), email: f.email, name: f.name, fulfilment: f.fulfilment, ...(appliedCode ? { discountCode: appliedCode } : {}), ...(recalledSource(slug) ? { source: recalledSource(slug) } : {}) };
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

  const cur = store.currency; const accent = /^#[0-9a-f]{6}$/i.test(store.theme?.accent ?? '') ? store.theme.accent : '#141414';
  const rules = (store.deliveryRules ?? []).length > 0; const delPrice = f.fulfilment === 'delivery' && quote ? money(quote.shippingCents, cur) : rules ? 'Price depends on where you live' : store.deliveryFeeCents ? money(store.deliveryFeeCents, cur) : 'Free';
  const total = quote?.totalCents ?? cart.subtotal + shipping;
  return <div style={{ ['--btn' as any]: accent }}>
    <StoreHeader store={store} slug={slug} /><CartDrawer store={store} slug={slug} />
    <main className="wrap" style={{ maxWidth: 1100 }}>
      {!cart.lines.length ? <Empty title="Your cart is empty"><Link to={`/store/${slug}`}>Keep shopping at {store.name}</Link></Empty> :
      <form className="co" onSubmit={submit}>
        <div>
          <h1 style={{ fontSize: '1.5rem', margin: '4px 0 12px' }}>Checkout</h1>
          {err && <Alert kind="err">{err}</Alert>}
          {!me && <p className="loginhint">Have an account? <Link to={`/login?next=${encodeURIComponent(`/store/${slug}/checkout`)}`}>Log in</Link> to fill this in and track your orders. Or just check out as a guest.</p>}
          <fieldset className="costep" style={{ border: '1px solid var(--line)' }}><h2><i>1</i>Your details</h2>
            <Field label="Name">{id => <input id={id} required autoComplete="name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label="Email" hint="We send your order updates here.">{id => <input id={id} type="email" required autoComplete="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} />}</Field></fieldset>
          <fieldset className="costep" style={{ border: '1px solid var(--line)' }}><legend className="sr-only">How would you like to receive it?</legend><h2><i>2</i>How would you like it?</h2>
            <div className="optcards" role="radiogroup" aria-label="Delivery method">
              {store.fulfilment.pickup && <label className={`optcard${f.fulfilment === 'pickup' ? ' on' : ''}`}><input type="radio" name="ful" checked={f.fulfilment === 'pickup'} onChange={() => setF({ ...f, fulfilment: 'pickup' })} /><span>Pickup<small>Collect it from {store.name}{store.city ? ` in ${store.city}` : ''}. We will tell you when it is ready.</small></span><span className="p">Free</span></label>}
              {store.fulfilment.delivery && <label className={`optcard${f.fulfilment === 'delivery' ? ' on' : ''}`}><input type="radio" name="ful" checked={f.fulfilment === 'delivery'} onChange={() => setF({ ...f, fulfilment: 'delivery' })} /><span>Delivery<small>{quote?.shippingRule && f.fulfilment === 'delivery' ? quote.shippingRule : 'Sent to your address'}</small></span><span className="p">{delPrice}</span></label>}</div>
            {f.fulfilment === 'delivery' && <>
              <Field label="Street address">{id => <input id={id} required autoComplete="address-line1" value={f.line1} onChange={e => setF({ ...f, line1: e.target.value })} />}</Field>
              <div className="grid2"><Field label="City">{id => <input id={id} required autoComplete="address-level2" value={f.city} onChange={e => setF({ ...f, city: e.target.value })} />}</Field>
                <Field label="Province">{id => <select id={id} required autoComplete="address-level1" value={f.region} onChange={e => setF({ ...f, region: e.target.value })}><option value="">Choose…</option>{PROVINCES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>}</Field></div>
              <Field label="Postal code">{id => <input id={id} required autoComplete="postal-code" value={f.postalCode} onChange={e => setF({ ...f, postalCode: e.target.value })} />}</Field></>}
            {!store.fulfilment.pickup && !store.fulfilment.delivery && <Alert kind="warn">This store has not set up delivery or pickup yet.</Alert>}</fieldset>
          <fieldset className="costep" style={{ border: '1px solid var(--line)' }}><h2><i>3</i>Review and pay</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>Check the summary, add a discount code if you have one, then place your order. You will pay on the next screen.</p></fieldset>
        </div>
        <aside><div className="sumcard"><h2 style={{ fontSize: '1.05rem', margin: '0 0 8px' }}>Order summary</h2>
          <ul className="sumlines">{cart.lines.map(l => <li key={l.key}><div className="sumimg">{l.image ? <img src={l.image} alt="" /> : <span aria-hidden>{l.name.slice(0, 1)}</span>}</div>
            <div><b>{l.name}</b>{l.title !== 'Default' && <span className="muted small" style={{ display: 'block' }}>{l.title}</span>}{l.customView?.map(v => <span key={v.label} className="muted small" style={{ display: 'block' }}>{v.label}: {v.type === 'image' ? 'photo attached' : v.value}</span>)}
              <div className="qty"><button type="button" className="secondary" aria-label={`Decrease ${l.name}`} onClick={() => cart.setQty(l.key, l.qty - 1)}>−</button><span aria-live="polite">{l.qty}</span><button type="button" className="secondary" aria-label={`Increase ${l.name}`} onClick={() => cart.setQty(l.key, l.qty + 1)}>+</button></div></div>
            <span>{money(l.priceCents * l.qty, cur)}</span></li>)}</ul>
          <div className="row" style={{ margin: '4px 0 8px' }}>
            <input aria-label="Discount code" placeholder="Discount code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setAppliedCode(code.trim()); } }} style={{ flex: 1 }} maxLength={40} />
            <button type="button" className="secondary" onClick={() => setAppliedCode(code.trim())}>Apply</button>{appliedCode && <button type="button" className="ghost" onClick={() => { setAppliedCode(''); setCode(''); }}>Remove</button>}</div>
          <div className="sumline"><span>Subtotal</span><span>{money(quote?.subtotalCents ?? cart.subtotal, cur)}</span></div>
          {quote?.discountCents > 0 && <div className="sumline"><span>Discount ({quote.discountCode})</span><span>−{money(quote.discountCents, cur)}</span></div>}
          <div className="sumline"><span>Delivery{quote?.shippingRule ? ` (${quote.shippingRule})` : ''}</span><span>{money(quote?.shippingCents ?? shipping, cur)}</span></div>
          {quote?.taxLines?.map((t: any) => <div className="sumline" key={t.name}><span>{t.name}</span><span>{money(t.cents, cur)}</span></div>)}
          <div className="sumline total"><span>Total</span><span>{money(total, cur)}</span></div>
          {quoteErr && <p className="alert warn" role="status">{quoteErr}</p>}
          <button className="placebtn" disabled={busy || !!quoteErr || (!store.fulfilment.pickup && !store.fulfilment.delivery)}>{busy ? 'Placing order…' : `Place order · ${money(total, cur)}`}</button>
          <div className="trust"><span>🔒 Secure checkout</span><span>↩ Sold by {store.name}</span>{store.chargesTax && <span>Tax shown for your province</span>}</div></div></aside>
      </form>}
    </main></div>;
}

export function OrderStatus() {
  usePub();
  const { token = '' } = useParams(); const [o, setO] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { api(`/api/public/orders/${token}`).then(setO).catch(e => setErr(errorText(e))); }, [token]);
  return <main className="wrap" style={{ maxWidth: 560 }}>
    {err && <Alert kind="err">Order not found.</Alert>}
    {o && <><h1>Order #{o.number}</h1>
      {o.status === 'paid' && <Alert kind="ok">Thank you! Your order is confirmed. (Simulated payment in this development build.)</Alert>}
      <section className="card"><div className="row spread"><b>Status</b><Badge s={o.status} /></div><Timeline status={o.status} fulfilment={o.fulfilment} />
        <table><tbody>{o.items.map((i: any, n: number) => <tr key={n}><td>{i.name} × {i.quantity}</td><td>{money(i.unit_price_cents * i.quantity, o.currency)}</td></tr>)}
          <tr><td>Delivery</td><td>{money(o.shipping_cents, o.currency)}</td></tr>{o.tax_lines?.map((t: any) => <tr key={t.name}><td>{t.name}</td><td>{money(t.cents, o.currency)}</td></tr>)}<tr><td><b>Total</b></td><td><b>{money(o.total_cents, o.currency)}</b></td></tr>
          {o.refunded_cents > 0 && <tr><td>Refunded</td><td>−{money(o.refunded_cents, o.currency)}</td></tr>}</tbody></table>
        <p className="muted small">Bookmark this page to follow your order.</p></section></>}
  </main>;
}
