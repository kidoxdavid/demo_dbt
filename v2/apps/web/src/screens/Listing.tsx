import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, useApi } from '../api';
import { Button, ProductCard } from '../components/ui';
import { PhoneTop, SearchBox } from '../components/Layout';
import { useDesktop } from '../hooks';
import { useSession, type ApiCard } from '../session';
import { money } from '../format';

interface Facet { key: string; label: string; type: string; options: { value: string; label: string; count: number }[] }
interface Result { total: number; makers: number; fuzzy: boolean; items: ApiCard[]; facets?: Facet[] }
const SORTS: [string, string][] = [['featured', 'Featured'], ['new', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['popular', 'Most popular']];
const PAGE = 24; const QUICK = ['material', 'size'];

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return <div className="sheet-scrim" onClick={onClose}><div className="sheet" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}><h3 className="serif">{title}</h3>{children}</div></div>;
}

/** Filter pills, the product grid and "show more", shared by categories and search. The URL holds the filters, so they can be shared and the back button works. */
export function ProductList({ base, empty, bare }: { base: Record<string, string>; empty?: React.ReactNode; bare?: boolean }) {
  const [sp, setSp] = useSearchParams(); const desktop = useDesktop(); const { card } = useSession();
  const f: Record<string, string> = { ...base }; for (const [k, v] of sp) if (k !== 'q' || !base.q) f[k] = v;
  const key = JSON.stringify(f); const [res, setRes] = useState<Result | null>(null); const [items, setItems] = useState<ApiCard[]>([]); const [busy, setBusy] = useState(false); const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { let live = true; setRes(null); setItems([]); api<Result>(`/api/products?${new URLSearchParams({ ...f, limit: String(PAGE) })}`).then(r => { if (live) { setRes(r); setItems(r.items); } }); return () => { live = false; }; }, [key]);
  const more = async () => { setBusy(true); try { const r = await api<Result>(`/api/products?${new URLSearchParams({ ...f, limit: String(PAGE), offset: String(items.length) })}`); setItems(x => [...x, ...r.items]); } finally { setBusy(false); } };
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v === null ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); setOpen(null); };
  const facets = res?.facets ?? []; const quick = QUICK.map(k => facets.find(x => x.key === k)).filter(Boolean) as Facet[]; const rest = facets.filter(x => !QUICK.includes(x.key));
  const sel = (k: string) => (sp.get(`attr.${k}`) ?? '').split(',').filter(Boolean);
  const pill = (label: string, active: boolean, onClick: () => void) => <button key={label} type="button" className={`pill filter${active ? ' active' : ''}`} onClick={onClick}>{label} ⌄</button>;
  const toggle = (label: string, k: string) => <button key={label} type="button" className={`pill filter${sp.get(k) ? ' active' : ''}`} aria-pressed={!!sp.get(k)} onClick={() => set({ [k]: sp.get(k) ? null : 'true' })}>{label} ⌄</button>;
  const facetSheet = (x: Facet) => <Sheet title={x.label} onClose={() => setOpen(null)}>{x.options.map(o => { const on = sel(x.key).includes(o.value);
    return <button key={o.value} className={`opt${on ? ' on' : ''}`} onClick={() => { const cur = sel(x.key); const next = on ? cur.filter(v => v !== o.value) : [...cur, o.value]; set({ [`attr.${x.key}`]: next.length ? next.join(',') : null }); }}><span>{o.label}</span><span className="muted">{o.count}{on ? ' ✓' : ''}</span></button>; })}</Sheet>;
  return <>
    {!bare && <div className="filters"><div className="pills" style={{ overflowX: 'auto', scrollbarWidth: 'none' }}>
      {pill('Price', !!(sp.get('minPrice') || sp.get('maxPrice')), () => setOpen('price'))}
      {quick.map(x => pill(x.label, sel(x.key).length > 0, () => setOpen(x.key)))}
      {toggle('Handmade', 'handmade')}{toggle('Free shipping', 'freeShipping')}
      {rest.length > 0 && pill('More', rest.some(x => sel(x.key).length), () => setOpen('more'))}
      {pill(SORTS.find(s => s[0] === (sp.get('sort') ?? 'featured'))![1], false, () => setOpen('sort'))}</div></div>}
    {open === 'price' && <Sheet title="Price" onClose={() => setOpen(null)}><PriceForm sp={sp} onApply={set} /></Sheet>}
    {open === 'sort' && <Sheet title="Sort by" onClose={() => setOpen(null)}>{SORTS.map(([v, l]) => <button key={v} className={`opt${(sp.get('sort') ?? 'featured') === v ? ' on' : ''}`} onClick={() => set({ sort: v === 'featured' ? null : v })}>{l}</button>)}</Sheet>}
    {open === 'more' && <Sheet title="More filters" onClose={() => setOpen(null)}>{rest.map(x => <div key={x.key}><div className="muted" style={{ fontSize: 12, marginTop: 14 }}>{x.label}</div>{x.options.map(o => { const on = sel(x.key).includes(o.value);
      return <button key={o.value} className={`opt${on ? ' on' : ''}`} onClick={() => { const cur = sel(x.key); const next = on ? cur.filter(v => v !== o.value) : [...cur, o.value]; const n = new URLSearchParams(sp); next.length ? n.set(`attr.${x.key}`, next.join(',')) : n.delete(`attr.${x.key}`); setSp(n, { replace: true }); }}><span>{o.label}</span><span className="muted">{o.count}{on ? ' ✓' : ''}</span></button>; })}</div>)}<div className="row"><Button block onClick={() => setOpen(null)}>Show results</Button></div></Sheet>}
    {facets.map(x => open === x.key && facetSheet(x))}
    {res?.fuzzy && <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>No exact matches. Showing close ones.</p>}
    {!res ? <div className={desktop ? 'grid4' : 'grid2 list'} style={{ marginTop: 16 }}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: '1', borderRadius: 14 }} />)}</div>
      : items.length === 0 ? <div className="empty">{empty ?? <><h2 className="serif">Nothing here yet</h2><p>Try removing a filter.</p></>}</div>
      : <><div className={desktop ? 'grid4' : 'grid2 list'} style={{ marginTop: 16 }}>{items.map(c => <ProductCard key={c.id} p={card(c)} />)}</div>
        {items.length < res.total && <Button variant="ghost" className="more" onClick={more} disabled={busy}>{busy ? 'Loading…' : `Show more (${res.total - items.length} left)`}</Button>}</>}
    <ListMeta res={res} />
  </>;
}
function ListMeta({ res }: { res: Result | null }) { useEffect(() => { document.dispatchEvent(new CustomEvent('list-meta', { detail: res ? { total: res.total, makers: res.makers } : null })); }, [res]); return null; }
function useListMeta() { const [m, set] = useState<{ total: number; makers: number } | null>(null); useEffect(() => { const h = (e: Event) => set((e as CustomEvent).detail); document.addEventListener('list-meta', h); return () => document.removeEventListener('list-meta', h); }, []); return m; }
function PriceForm({ sp, onApply }: { sp: URLSearchParams; onApply: (p: Record<string, string | null>) => void }) {
  const [lo, setLo] = useState(sp.get('minPrice') ? String(Number(sp.get('minPrice')) / 100) : ''); const [hi, setHi] = useState(sp.get('maxPrice') ? String(Number(sp.get('maxPrice')) / 100) : '');
  const c = (v: string) => (v.trim() && !isNaN(Number(v)) && Number(v) >= 0 ? String(Math.round(Number(v) * 100)) : null);
  return <><label className="label">Lowest price ($)<input className="field" inputMode="decimal" value={lo} onChange={e => setLo(e.target.value)} /></label><label className="label">Highest price ($)<input className="field" inputMode="decimal" value={hi} onChange={e => setHi(e.target.value)} /></label>
    <div className="row"><Button variant="ghost" onClick={() => onApply({ minPrice: null, maxPrice: null })}>Clear</Button><Button block onClick={() => onApply({ minPrice: c(lo), maxPrice: c(hi) })}>Apply</Button></div></>;
}

/** Category page. Matches reference buyer-category.png (phone). */
export function CategoryPage() {
  const { slug = '' } = useParams(); const desktop = useDesktop(); const { data: cat, error } = useApi<{ name: string; breadcrumbs: { slug: string; name: string }[] }>(`/api/categories/${slug}`); const meta = useListMeta();
  if (error) return <div className="empty"><h2 className="serif">We could not find that category</h2><Link to="/" className="btn">Back to the shop</Link></div>;
  const crumbs = cat?.breadcrumbs ?? [];
  return <div className={desktop ? 'dpad' : 'screen'}><div className={desktop ? '' : 'pad cat-head'} style={desktop ? undefined : undefined}>
    <div className="crumbs"><Link to="/">Home</Link>{crumbs.map((c, i) => <span key={c.slug}> › {i === crumbs.length - 1 ? c.name : <Link to={`/c/${c.slug}`}>{c.name}</Link>}</span>)}</div>
    <h1 className="serif" style={desktop ? { fontSize: 38, marginTop: 6 } : { fontSize: 30, marginTop: 6 }}>{cat?.name ?? ' '}</h1>
    <div className="n" style={{ fontSize: 13, marginTop: 4, color: 'var(--mut)' }}>{meta ? `${meta.total} piece${meta.total === 1 ? '' : 's'} from ${meta.makers} maker${meta.makers === 1 ? '' : 's'}` : ' '}</div></div>
    <div className={desktop ? '' : 'pad'} style={desktop ? { marginTop: 14 } : undefined}>{cat && <ProductList key={slug} base={{ category: slug }} />}</div></div>;
}

export function SearchPage() {
  const [sp] = useSearchParams(); const q = sp.get('q') ?? ''; const desktop = useDesktop(); const meta = useListMeta(); const nav = useNavigate();
  return <div className={desktop ? 'dpad' : 'screen'}><div className={desktop ? '' : 'pad'} style={{ paddingTop: 6 }}>
    {!desktop && <><PhoneTop /><div style={{ marginTop: 12 }}><SearchBox initial={q} /></div></>}
    <h1 className="serif" style={{ fontSize: desktop ? 38 : 28, marginTop: desktop ? 0 : 18 }}>{q ? <>Results for “{q}”</> : 'All pieces'}</h1>
    <div style={{ fontSize: 13, marginTop: 4, color: 'var(--mut)' }}>{meta ? `${meta.total} piece${meta.total === 1 ? '' : 's'} from ${meta.makers} maker${meta.makers === 1 ? '' : 's'}` : ' '}</div>
    <ProductList key={q} base={q ? { q } : {}} empty={<><h2 className="serif">No pieces match “{q}”</h2><p>Check the spelling, or browse a category.</p><Button style={{ marginTop: 16 }} onClick={() => nav('/')}>Browse the shop</Button></>} /></div></div>;
}

export function SavedPage() {
  const { user, ready, card } = useSession(); const desktop = useDesktop(); const { data } = useApi<{ items: ApiCard[] }>(user ? '/api/me/saved' : null);
  return <div className={desktop ? 'dpad' : 'screen'}><div className={desktop ? '' : 'pad'} style={{ paddingTop: 6 }}><h1 className="serif" style={{ fontSize: desktop ? 38 : 30 }}>Saved</h1>
    {ready && !user ? <div className="empty"><h2 className="serif">Sign in to see what you saved</h2><p>Tap the heart on any piece to keep it here.</p><Link to="/account?next=/saved" className="btn" style={{ marginTop: 16 }}>Sign in</Link></div>
      : data && data.items.length === 0 ? <div className="empty"><h2 className="serif">Nothing saved yet</h2><p>Tap the heart on a piece you love.</p><Link to="/" className="btn" style={{ marginTop: 16 }}>Browse the shop</Link></div>
      : <div className={desktop ? 'grid4' : 'grid2 list'}>{(data?.items ?? []).map(c => <ProductCard key={c.id} p={card(c)} />)}</div>}</div></div>;
}
void money;
