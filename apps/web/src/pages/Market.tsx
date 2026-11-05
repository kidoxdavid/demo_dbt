import { Stars, ReviewsSection } from './Customer';
import { Heart, StoreHeader, CartDrawer, FollowButton, NotifyForm, Qty, deliveryLines } from './CustomerUi';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorText, money } from '../api';
import { Empty } from '../ui';
import { useCart, useStore, usePub, rememberSource } from './Store';

/** Grids ask for the small thumbnail the server makes; full-size images are for the product page and hero. */
const thumb = (u: string) => (u.startsWith('/media/') ? `${u}?w=480` : u);
export const accentOf = (t: any) => (t?.accent && /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : '#141414');

/** Quiet header: wordmark, categories as plain text links, search that opens on demand. No giant search bar. */
export function PubHeader({ q, categories = [], onSearch }: { q?: string; categories?: { name: string }[]; onSearch?: (q: string) => void }) {
  const [open, setOpen] = useState(!!q); const [v, setV] = useState(q ?? ''); const nav = useNavigate(); const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setV(q ?? ''); if (q) setOpen(true); }, [q]);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  const submit = (e: FormEvent) => { e.preventDefault(); onSearch ? onSearch(v.trim()) : nav(`/?q=${encodeURIComponent(v.trim())}`); };
  return <header className="ptop">
    <div className="wrap pbar">
      <Link to="/" className="plogo">Eazy<i>Stores</i></Link>
      <nav className="pnav" aria-label="Categories">{categories.slice(0, 5).map(c => <Link key={c.name} to={`/?category=${encodeURIComponent(c.name)}`}>{c.name}</Link>)}</nav>
      <div className="pright">
        <button className="iconbtn" aria-label={open ? 'Close search' : 'Search'} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg></button>
        <Link className="plink" to="/account">Account</Link>
        <Link className="plink" to="/sell">Sell</Link>
      </div>
    </div>
    {open && <form className="psearch" role="search" onSubmit={submit} onKeyDown={e => e.key === 'Escape' && setOpen(false)}>
      <div className="wrap"><input ref={ref} type="search" aria-label="Search products and stores" placeholder="Search products, makers, categories" value={v} onChange={e => setV(e.target.value)} /></div></form>}
  </header>;
}

export function PCard({ p, quick }: { p: any; quick?: () => void }) {
  const price = p.priceTo && p.priceTo !== p.priceFrom ? `From ${money(p.priceFrom, p.currency)}` : money(p.priceFrom, p.currency);
  const drop = p.comingSoon && p.availableFrom ? new Date(p.availableFrom).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : null;
  return <div className="pcw"><Link className="pc" to={`/store/${p.storeSlug}/p/${p.id}`} aria-label={`${p.name}, ${price}${drop ? `, drops ${drop}` : p.available ? '' : ', sold out'}`}>
    <div className="pc-img">
      {p.image ? <img className="a" src={thumb(p.image)} alt="" loading="lazy" /> : <div className="ph" aria-hidden>{p.name.slice(0, 1)}</div>}
      {p.image2 && <img className="b" src={thumb(p.image2)} alt="" loading="lazy" />}
      {drop ? <span className="tag drop">Drops {drop}</span> : !p.available ? <span className="tag">Sold out</span> : p.low ? <span className="tag low">Only {p.low} left</span> : p.madeToOrder ? <span className="tag">Made to order</span> : null}
    </div>
    <div className="pc-meta"><span className="pc-store">{p.storeName}</span><span className="pc-name">{p.name}</span>{p.rating?.count > 0 && <Stars avg={p.rating.avg} count={p.rating.count} />}<span className="pc-price">{price}</span></div>
  </Link><Heart productId={p.id} />{quick && <button type="button" className="quickadd" onClick={quick} aria-label={`Add ${p.name} to cart`}>+</button>}</div>;
}

function Home({ data, items, onAll }: { data: any; items: any[]; onAll: () => void }) {
  const feature = data.stores[0];
  const perStore = useMemo(() => { const seen = new Set<string>(); return items.filter(p => p.available && !seen.has(p.storeSlug) && seen.add(p.storeSlug)).slice(0, 12); }, [items]);
  const tiles = data.categories.map((c: any) => ({ ...c, store: data.stores.find((s: any) => s.category === c.name) })).filter((t: any) => t.store?.covers?.[0]);
  return <>
    {feature && <section className="fhero" style={{ ['--a' as any]: accentOf(feature.theme) }}>
      <div className="wrap feature-grid">
        <div className="feature-text">
          <span className="kicker">Featured maker</span>
          <h1>{feature.name}</h1>
          <p>{feature.tagline}</p>
          <p className="meta">{[feature.category, feature.city].filter(Boolean).join(' · ')}</p>
          <Link className="cta-link" to={`/store/${feature.slug}`}>Visit the store <span aria-hidden>→</span></Link>
        </div>
        <Link to={`/store/${feature.slug}`} className="feature-img" aria-label={`Visit ${feature.name}`}>{feature.covers[0] ? <img src={feature.covers[0]} alt="" /> : null}</Link>
      </div>
    </section>}
    <div className="wrap">
      <section className="band2" aria-labelledby="cats"><div className="band2-head"><h2 id="cats">Shop by category</h2></div>
        <div className="tiles">{tiles.map((t: any) => <Link key={t.name} className="tile2" to={`/?category=${encodeURIComponent(t.name)}`}>
          <img src={thumb(t.store.covers[0])} alt="" loading="lazy" /><span className="tile2-label"><b>{t.name}</b><small>{t.stores} {t.stores === 1 ? 'maker' : 'makers'}</small></span></Link>)}</div></section>
      {perStore.length > 0 && <section className="band2" aria-labelledby="new"><div className="band2-head"><h2 id="new">New this week</h2><button className="textbtn" onClick={onAll}>View all products →</button></div>
        <div className="pgrid four">{perStore.map(p => <PCard key={p.id} p={p} />)}</div></section>}
      <section className="band2" aria-labelledby="makers"><div className="band2-head"><h2 id="makers">The makers</h2><span className="muted small">{data.stores.length} independent {data.stores.length === 1 ? 'brand' : 'brands'}</span></div>
        <ul className="makers">{data.stores.map((s: any) => <li key={s.slug}><Link to={`/store/${s.slug}`} className="maker">
          <span className="maker-name"><i className="dot" style={{ background: accentOf(s.theme) }} aria-hidden />{s.name}{s.verified && <span className="vtick" title="Verified seller: EazyStores staff reviewed their registration details">✓ Verified</span>}</span>
          <span className="maker-meta">{[s.category, s.city].filter(Boolean).join(' · ')}</span>
          <span className="maker-imgs" aria-hidden>{s.covers.slice(0, 3).map((u: string) => <img key={u} src={thumb(u)} alt="" loading="lazy" />)}</span></Link></li>)}</ul></section>
    </div>
  </>;
}

export function Marketplace() {
  usePub();
  const [sp, setSp] = useSearchParams(); const q = sp.get('q') ?? ''; const category = sp.get('category') ?? ''; const sort = sp.get('sort') ?? 'new'; const all = sp.get('view') === 'all';
  const [data, setData] = useState<any>(null); const [items, setItems] = useState<any[]>([]); const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);
  const qs = (offset: number) => new URLSearchParams({ ...(q && { q }), ...(category && { category }), sort, limit: '24', offset: String(offset) }).toString();
  useEffect(() => { setLoading(true); setFailed(false);
    api(`/api/public/marketplace?${qs(0)}`).then(d => { setData(d); setItems(d.products); }).catch(() => setFailed(true)).finally(() => setLoading(false)); }, [q, category, sort]); // eslint-disable-line
  const more = async () => { const d = await api(`/api/public/marketplace?${qs(items.length)}`); setItems(i => [...i, ...d.products]); };
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const browsing = !q && !category && !all;
  return <>
    <PubHeader q={q} categories={data?.categories} onSearch={v => set('q', v)} />
    {failed && <div className="wrap"><p className="alert err" role="alert">We couldn't load the marketplace. Please try again.</p></div>}
    {browsing && data && <Home data={data} items={items} onAll={() => set('view', 'all')} />}
    {!browsing && <main className="wrap results">
      <div className="results-head"><div><span className="kicker">{q ? 'Search' : category ? 'Category' : 'Everything'}</span><h1>{q ? `“${q}”` : category || 'All products'}</h1>
        {data && <span className="muted small">{data.total} {data.total === 1 ? 'item' : 'items'}</span>}</div>
        <label className="sortsel"><span className="sr-only">Sort</span><select value={sort} onChange={e => set('sort', e.target.value === 'new' ? '' : e.target.value)}>
          <option value="new">Newest</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option></select></label></div>
      <div className="filters" role="tablist" aria-label="Categories">
        <button role="tab" aria-selected={!category} className={!category ? 'on' : ''} onClick={() => set('category', '')}>All</button>
        {data?.categories.map((c: any) => <button role="tab" aria-selected={category === c.name} key={c.name} className={category === c.name ? 'on' : ''} onClick={() => set('category', c.name)}>{c.name}</button>)}</div>
      {!loading && data && !items.length && <Empty title="Nothing found">{q ? 'Check the spelling or try a broader search.' : 'Nothing here yet.'}</Empty>}
      <div className="pgrid">{items.map(p => <PCard key={p.id} p={p} />)}</div>
      {data && items.length < data.total && <p style={{ textAlign: 'center', padding: '24px 0 80px' }}><button className="secondary" onClick={more}>Show more</button></p>}
    </main>}
    <footer className="pfoot"><div className="wrap pfoot-grid"><div><div className="plogo">Eazy<i>Stores</i></div><p className="muted small">A home for independent brands.</p></div>
      <div className="small"><b>Sellers</b><br /><Link to="/sell">Open your store</Link><br /><Link to="/login">Log in</Link></div>
      <div className="small"><b>Policies</b><br /><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link> · <Link to="/rules">Prohibited items</Link></div>
      </div></footer>
  </>;
}

export function ProductPage() {
  usePub();
  const { slug = '', id = '' } = useParams(); const { store, missing } = useStore(slug); const cart = useCart(slug);
  const [sp] = useSearchParams(); useEffect(() => rememberSource(slug, sp.get('src')), [slug, sp]);
  const [custom, setCustom] = useState<Record<string, string>>({}); const [fileNames, setFileNames] = useState<Record<string, string>>({}); const [cerr, setCerr] = useState(''); const [uploading, setUploading] = useState(false);
  const [qty, setQty] = useState(1); const [more, setMore] = useState<any[]>([]);
  const [p, setP] = useState<any>(null); const [gone, setGone] = useState(false); const [vid, setVid] = useState(''); const [img, setImg] = useState(0); const [added, setAdded] = useState(false);
  useEffect(() => { setQty(1); setImg(0); api(`/api/public/stores/${slug}/products/${id}`).then(d => { setP(d); setVid((d.variants.find((x: any) => x.available) ?? d.variants[0]).id); }).catch(() => setGone(true)); }, [slug, id]);
  useEffect(() => { api(`/api/public/stores/${slug}/products?limit=12`).then(r => setMore(r.filter((x: any) => x.id !== id).slice(0, 6))).catch(() => {}); }, [slug, id]);
  if (missing || gone) return <><PubHeader /><div className="wrap"><Empty title="Product not found">It may have been removed. <Link to="/">Back to the marketplace</Link></Empty></div></>;
  if (!p || !store) return <><PubHeader /><div className="wrap"><p className="muted">Loading…</p></div></>;
  const v = p.variants.find((x: any) => x.id === vid) ?? p.variants[0];
  const attrs = Object.entries(p.attributes ?? {}); const accent = accentOf(store.theme);
  const fields: any[] = p.customFields ?? [];
  const setField = (k: string, val: string) => { setCustom(c => ({ ...c, [k]: val })); setCerr(''); };
  async function pickImage(f: any, file: File | undefined) {
    if (!file) return; setCerr('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setCerr('Please choose a JPG, PNG or WebP image.'); return; }
    if (file.size > 5 * 1024 * 1024) { setCerr('That photo is over 5 MB. Please choose a smaller one.'); return; }
    setUploading(true);
    try {
      const res = await fetch(`/api/public/stores/${slug}/custom-upload`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setCerr(errorText(new ApiError(res.status, d.error ?? 'upload_failed'))); return; }
      setField(f.key, d.id); setFileNames(n => ({ ...n, [f.key]: file.name }));
    } finally { setUploading(false); }
  }
  const add = () => {
    for (const f of fields) if (f.required && !(custom[f.key] ?? '').trim()) { setCerr(`Please fill in “${f.label}”.`); return; }
    const answers = Object.fromEntries(Object.entries(custom).filter(([, val]) => val.trim() !== ''));
    const view = fields.filter(f => answers[f.key]).map(f => ({ label: f.label, type: f.type, value: f.type === 'image' ? (fileNames[f.key] ?? 'photo') : answers[f.key] }));
    cart.add({ variantId: v.id, name: p.name, title: v.title, priceCents: v.priceCents, image: p.images[0] ? `${p.images[0]}?w=480` : undefined, ...(fields.length ? { custom: answers, customView: view } : {}) }, qty);
  };
  return <div style={{ ['--btn' as any]: accent }}>
    <StoreHeader store={store} slug={slug} />
    <CartDrawer store={store} slug={slug} />
    <main className="wrap pdp2">
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/">Marketplace</Link><span aria-hidden> / </span><Link to={`/store/${slug}`}>{store.name}</Link></nav>
      <div className="pdp2-grid">
        <div className={`gal${p.images.length > 1 ? ' has-thumbs' : ''}`}>
          {p.images.length > 1 && <div className="gal-thumbs">{p.images.map((u: string, i: number) => <button key={u} className={i === img ? 'on' : ''} aria-label={`Show photo ${i + 1}`} onClick={() => setImg(i)}><img src={u} alt="" /></button>)}</div>}
          <div className="gal-main">{p.images[img] ? <img src={p.images[img]} alt={`${p.name}, photo ${img + 1}`} /> : <div className="ph" aria-hidden>{p.name.slice(0, 1)}</div>}</div>
        </div>
        <div className="pinfo2">
          <Link className="kicker" to={`/store/${slug}`}>{p.brand && p.brand !== store.name ? `${p.brand} · ` : ''}{store.name}</Link>
          <div className="row spread"><h1 style={{ margin: 0 }}>{p.name}</h1><Heart productId={p.id} className="big-heart" /></div>
          {p.rating?.count > 0 && <a href="#rv-h" style={{ textDecoration: 'none' }}><Stars avg={p.rating.avg} count={p.rating.count} /></a>}
          <div className="pprice">{money(v.priceCents, store.currency)}</div>
          {p.madeToOrder && <p className="note2">Made to order. Allow extra time for the maker to prepare your piece.</p>}
          {p.variants.length > 1 && <fieldset className="opts2"><legend>Option · <b>{v.title}</b></legend>
            {p.variants.map((x: any) => <button key={x.id} type="button" disabled={!x.available} aria-pressed={x.id === vid} className={x.id === vid ? 'on' : ''} onClick={() => setVid(x.id)}>{x.title}</button>)}</fieldset>}
          {fields.length > 0 && <fieldset className="custom"><legend>Make it yours</legend>
            {fields.map((f: any) => <div key={f.key}>
              <label htmlFor={`cf-${f.key}`}>{f.label}{f.required ? ' *' : ' (optional)'}</label>
              {f.type === 'text' && <input id={`cf-${f.key}`} maxLength={f.maxLength ?? 100} value={custom[f.key] ?? ''} onChange={e => setField(f.key, e.target.value)} />}
              {f.type === 'textarea' && <textarea id={`cf-${f.key}`} maxLength={f.maxLength ?? 1000} value={custom[f.key] ?? ''} onChange={e => setField(f.key, e.target.value)} />}
              {f.type === 'select' && <select id={`cf-${f.key}`} value={custom[f.key] ?? ''} onChange={e => setField(f.key, e.target.value)}><option value="">Choose…</option>{f.options.map((o: string) => <option key={o}>{o}</option>)}</select>}
              {f.type === 'image' && <div><input id={`cf-${f.key}`} type="file" accept="image/jpeg,image/png,image/webp" onChange={e => pickImage(f, e.target.files?.[0])} />
                {fileNames[f.key] && <p className="muted small" role="status">Attached: {fileNames[f.key]}</p>}</div>}
            </div>)}
            {cerr && <p className="alert err" role="alert">{cerr}</p>}
          </fieldset>}
          {p.comingSoon
            ? <div className="dropbox"><b>Drops {new Date(p.availableFrom).toLocaleString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</b><p className="muted small" style={{ margin: '4px 0 0' }}>You can see it now, but it cannot be bought until then.</p></div>
            : v.left ? <p className="stockline" role="status">Only {v.left} left</p> : null}
          {p.comingSoon ? <NotifyForm slug={slug} productId={p.id} kind="drop" />
            : !v.available && !p.variants.some((x: any) => x.available) ? <><button className="buy2" disabled>Sold out</button><NotifyForm slug={slug} productId={p.id} kind="restock" /></>
            : <div className="buyrow">{v.available && <Qty value={qty} onChange={setQty} max={v.left ?? 20} />}<button className="buy2" disabled={!v.available || uploading} onClick={add}>{uploading ? 'Uploading photo…' : v.available ? `Add to cart · ${money(v.priceCents * qty, store.currency)}` : 'This option is sold out'}</button></div>}
          <ul className="delinfo" aria-label="Delivery">{deliveryLines(store).map((l: string) => <li key={l}>{l}</li>)}</ul>
          <div className="acc">
            {p.description && <details open><summary>Description</summary><p>{p.description}</p></details>}
            {attrs.length > 0 && <details open><summary>Details</summary><dl className="attrs2">{attrs.map(([k, val]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val)}</dd></div>)}</dl></details>}
            <details hidden><summary>Delivery and pickup</summary><p>{[store.fulfilment.pickup && 'Pickup available', store.fulfilment.delivery && `Delivery ${store.deliveryFeeCents ? money(store.deliveryFeeCents, store.currency) : 'free'}`].filter(Boolean).join(' · ')}. Sold and fulfilled by {store.name}{store.city ? `, ${store.city}` : ''}.</p></details>
          </div>
        </div>
      </div>
      <ReviewsSection slug={slug} productId={p.id} />
    </main>
    {more.length > 0 && <section className="wrap morefrom"><h2>More from {store.name}</h2><div className="pgrid four">{more.map((x: any) => <PCard key={x.id} p={{ id: x.id, name: x.name, storeSlug: slug, storeName: x.brand || store.name, currency: store.currency, priceFrom: Math.min(...x.variants.map((y: any) => y.priceCents)), priceTo: Math.max(...x.variants.map((y: any) => y.priceCents)), image: x.images?.[0], image2: x.images?.[1], available: x.variants.some((y: any) => y.available), comingSoon: x.comingSoon, availableFrom: x.availableFrom, madeToOrder: x.madeToOrder, rating: x.rating }} />)}</div></section>}
    {!p.comingSoon && v.available && <div className="stickybuy"><b>{money(v.priceCents * qty, store.currency)}</b><button onClick={add} disabled={uploading} aria-label="Add selected option">Add</button></div>}
  </div>;
}
