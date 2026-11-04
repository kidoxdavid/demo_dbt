import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { Empty } from '../ui';
import { useCart, useStore } from './Store';

const accentOf = (t: any) => (t?.accent && /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : '#0b0b0c');

export function MarketHeader({ q, onSearch }: { q?: string; onSearch?: (q: string) => void }) {
  const [v, setV] = useState(q ?? ''); const nav = useNavigate();
  const submit = (e: FormEvent) => { e.preventDefault(); onSearch ? onSearch(v) : nav(`/?q=${encodeURIComponent(v)}`); };
  useEffect(() => setV(q ?? ''), [q]);
  return <header className="top"><div className="wrap mkt-bar">
    <Link to="/" className="logo">Eazy<b>Stores</b></Link>
    <form className="search" role="search" onSubmit={submit}>
      <input type="search" aria-label="Search products and stores" placeholder="Search products, brands and stores" value={v} onChange={e => setV(e.target.value)} />
    </form>
    <Link className="btn ghost sm sell-link" to="/sell">Sell on EazyStores</Link>
  </div></header>;
}

export function ProductCard({ p, showStore = true }: { p: any; showStore?: boolean }) {
  const price = p.priceTo && p.priceTo !== p.priceFrom ? `From ${money(p.priceFrom, p.currency)}` : money(p.priceFrom, p.currency);
  return <Link className="pcard link" to={`/store/${p.storeSlug}/p/${p.id}`} aria-label={`${p.name}, ${price}${p.available ? '' : ', sold out'}`}>
    <div className="pmedia">
      {p.image ? <img src={p.image} alt="" loading="lazy" /> : <div className="ph" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</div>}
      {!p.available ? <span className="sold">Sold out</span> : p.madeToOrder ? <span className="sold">Made to order</span> : null}
    </div>
    {showStore && <div className="brand">{p.storeName}</div>}
    <h3>{p.name}</h3>
    <div className="price">{price}</div>
  </Link>;
}

export function StoreCard({ s }: { s: any }) {
  const accent = accentOf(s.theme);
  return <Link to={`/store/${s.slug}`} className="scard" aria-label={`${s.name}, ${s.productCount} products`}>
    <div className="mosaic" style={{ ['--a' as any]: accent }}>
      {[0, 1, 2].map(i => s.covers[i] ? <img key={i} src={s.covers[i]} alt="" loading="lazy" /> : <div key={i} className="blank" />)}
    </div>
    <div className="sinfo"><div><b>{s.name}</b><div className="muted small">{[s.category, s.city].filter(Boolean).join(' · ')}</div></div><span className="dot" style={{ background: accent }} aria-hidden /></div>
  </Link>;
}

export function Marketplace() {
  const [sp, setSp] = useSearchParams(); const q = sp.get('q') ?? ''; const category = sp.get('category') ?? ''; const sort = sp.get('sort') ?? 'new';
  const [data, setData] = useState<any>(null); const [items, setItems] = useState<any[]>([]); const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);
  const qs = (offset: number) => new URLSearchParams({ ...(q && { q }), ...(category && { category }), sort, limit: '24', offset: String(offset) }).toString();
  useEffect(() => { setLoading(true); setFailed(false);
    api(`/api/public/marketplace?${qs(0)}`).then(d => { setData(d); setItems(d.products); }).catch(() => setFailed(true)).finally(() => setLoading(false)); }, [q, category, sort]); // eslint-disable-line
  const more = useCallback(async () => { const d = await api(`/api/public/marketplace?${qs(items.length)}`); setItems(i => [...i, ...d.products]); }, [items.length, q, category, sort]); // eslint-disable-line
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const browsing = !q && !category;
  return <>
    <MarketHeader q={q} onSearch={v => set('q', v)} />
    {browsing && <section className="mkt-hero"><div className="wrap"><h1>Discover independent brands.</h1><p>Shop products from small businesses near you and around the world.</p></div></section>}
    <main className="wrap" style={{ paddingTop: browsing ? 0 : 24 }}>
      <div className="catrow" role="tablist" aria-label="Categories">
        <button role="tab" aria-selected={!category} className={`cat${!category ? ' on' : ''}`} onClick={() => set('category', '')}>All</button>
        {data?.categories.map((c: any) => <button role="tab" aria-selected={category === c.name} key={c.name} className={`cat${category === c.name ? ' on' : ''}`} onClick={() => set('category', c.name)}>{c.name}</button>)}
      </div>
      {failed && <p className="alert err" role="alert">We couldn't load the marketplace. Please try again.</p>}
      {data?.stores.length > 0 && <>
        <div className="section-title"><h2>{browsing ? 'Featured stores' : 'Stores'}</h2></div>
        <div className="srow">{data.stores.map((s: any) => <StoreCard key={s.slug} s={s} />)}</div></>}
      <div className="section-title"><h2>{q ? `Results for “${q}”` : category ? category : 'Fresh arrivals'}</h2>
        <label className="sortsel"><span className="sr-only">Sort</span><select value={sort} onChange={e => set('sort', e.target.value === 'new' ? '' : e.target.value)}>
          <option value="new">Newest</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option></select></label></div>
      {!loading && data && !items.length && <Empty title="No products found">{q ? 'Check the spelling or try a broader search.' : 'Nothing here yet.'}</Empty>}
      <div className="products mkt">{items.map(p => <ProductCard key={p.id} p={p} />)}</div>
      {data && items.length < data.total && <p style={{ textAlign: 'center', paddingBottom: 100 }}><button className="secondary" onClick={more}>Show more ({data.total - items.length} left)</button></p>}
    </main>
    <footer className="footer"><div className="wrap row spread"><span>© EazyStores · Development build: payments are simulated.</span><Link to="/sell">Open your own store</Link></div></footer>
  </>;
}

export function ProductPage() {
  const { slug = '', id = '' } = useParams(); const { store, missing } = useStore(slug); const cart = useCart(slug);
  const [p, setP] = useState<any>(null); const [gone, setGone] = useState(false); const [vid, setVid] = useState(''); const [img, setImg] = useState(0); const [added, setAdded] = useState(false);
  useEffect(() => { api(`/api/public/stores/${slug}/products/${id}`).then(d => { setP(d); setVid(d.variants[0].id); }).catch(() => setGone(true)); }, [slug, id]);
  if (missing || gone) return <><MarketHeader /><div className="wrap"><div className="empty"><h3>Product not found</h3><p>It may have been removed. <Link to="/">Back to the marketplace</Link></p></div></div></>;
  if (!p || !store) return <><MarketHeader /><div className="wrap"><p className="muted">Loading…</p></div></>;
  const v = p.variants.find((x: any) => x.id === vid) ?? p.variants[0];
  const attrs = Object.entries(p.attributes ?? {});
  const accent = accentOf(store.theme);
  const add = () => { cart.add({ variantId: v.id, name: p.name, title: v.title, priceCents: v.priceCents }); setAdded(true); setTimeout(() => setAdded(false), 2500); };
  return <div className="shop" style={{ ['--btn' as any]: accent }}>
    <MarketHeader />
    <main className="wrap pdp">
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/">Marketplace</Link> / <Link to={`/store/${slug}`}>{store.name}</Link></nav>
      <div className="pdp-grid">
        <div className="gallery">
          <div className="pmedia big">{p.images[img] ? <img src={p.images[img]} alt={`${p.name}, photo ${img + 1}`} /> : <div className="ph" aria-hidden>{p.name.slice(0, 1)}</div>}</div>
          {p.images.length > 1 && <div className="gthumbs">{p.images.map((u: string, i: number) => <button key={u} className={`gt${i === img ? ' on' : ''}`} aria-label={`Show photo ${i + 1}`} onClick={() => setImg(i)}><img src={u} alt="" /></button>)}</div>}
        </div>
        <div className="pinfo">
          <Link className="brand" to={`/store/${slug}`}>{p.brand ? `${p.brand} · ` : ''}{store.name}</Link>
          <h1>{p.name}</h1>
          <div className="price lg">{money(v.priceCents, store.currency)}</div>
          {p.madeToOrder && <p className="note">Made to order. The seller makes this item after you order, so allow extra time.</p>}
          {p.variants.length > 1 && <fieldset className="opts"><legend>Option</legend>
            {p.variants.map((x: any) => <button key={x.id} type="button" disabled={!x.available} aria-pressed={x.id === vid} className={`opt${x.id === vid ? ' on' : ''}`} onClick={() => setVid(x.id)}>{x.title}{!x.available && ' · sold out'}</button>)}</fieldset>}
          <button className="buy" disabled={!v.available} onClick={add}>{v.available ? 'Add to cart' : 'Sold out'}</button>
          {added && <p className="added" role="status">Added. <Link to={`/store/${slug}/checkout`}>View cart and check out</Link></p>}
          <ul className="assure"><li>{store.fulfilment.pickup && store.fulfilment.delivery ? 'Pickup or delivery' : store.fulfilment.delivery ? 'Delivery' : 'Pickup'}{store.fulfilment.delivery && store.deliveryFeeCents ? ` · ${money(store.deliveryFeeCents, store.currency)} delivery` : ''}</li><li>Sold by {store.name}{store.city ? `, ${store.city}` : ''}</li></ul>
          {p.description && <section className="block"><h2>About this product</h2><p>{p.description}</p></section>}
          {attrs.length > 0 && <section className="block"><h2>Details</h2><dl className="attrs">{attrs.map(([k, val]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val)}</dd></div>)}</dl></section>}
        </div>
      </div>
    </main>
    {cart.count > 0 && <div className="cartbar"><div className="wrap row spread"><span>{cart.count} item{cart.count > 1 ? 's' : ''} · <b>{money(cart.subtotal, store.currency)}</b></span><Link className="btn sm" to={`/store/${slug}/checkout`}>Checkout</Link></div></div>}
  </div>;
}
