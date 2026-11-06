import { Link } from 'react-router-dom';
import { useApi } from '../api';
import { ProductArt } from '../art/ProductArt';
import { RatingStars } from '../components/Engagement';

interface Maker { name: string; slug: string; tagline: string | null; city: string | null; region: string | null; logo: string | null; productCount: number; rating: { avg: number; count: number } | null }
/** Every maker with pieces for sale. */
export function MakersPage() {
  const { data, error } = useApi<{ items: Maker[] }>('/api/makers');
  return <div className="screen pad" style={{ paddingTop: 10 }}><h1 className="serif">Meet the makers</h1><p className="muted">The people behind the pieces. Open a shop to see their story and everything they make.</p>
    {error && <div className="err" role="alert">Could not load the makers. Try again in a moment.</div>}
    {!data ? <div className="skeleton" style={{ height: 200, marginTop: 16 }} /> : data.items.length === 0 ? <div className="empty"><h2 className="serif">No shops open yet</h2><p>Makers will appear here as soon as they list their first piece.</p><Link to="/" className="btn" style={{ marginTop: 16 }}>Back to the shop</Link></div>
      : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginTop: 16 }}>{data.items.map(m => <Link key={m.slug} to={`/shop/${m.slug}`} className="card" style={{ padding: 14, display: 'flex', gap: 12, alignItems: 'center', minHeight: 72 }}>
        <span className="shoplogo" style={{ flex: 'none' }}>{m.logo ? <img src={m.logo} alt="" /> : <ProductArt kind="pottery" tone="blush" />}</span>
        <span style={{ minWidth: 0 }}><b style={{ display: 'block' }}>{m.name}</b>{m.tagline && <span className="muted" style={{ display: 'block', fontSize: 14 }}>{m.tagline}</span>}<span className="muted" style={{ fontSize: 13 }}>{[m.city, m.region].filter(Boolean).join(', ')}{m.city ? ' · ' : ''}{m.productCount} piece{m.productCount === 1 ? '' : 's'}</span>{m.rating && <span style={{ display: 'block' }}><RatingStars n={m.rating.avg} /> <span className="muted" style={{ fontSize: 13 }}>({m.rating.count})</span></span>}</span></Link>)}</div>}</div>;
}

const GUIDES: { title: string; blurb: string; to: string }[] = [
  { title: 'Gifts under $25', blurb: 'Small, thoughtful and easy to post.', to: '/search?maxPrice=2500&sort=popular' },
  { title: 'Gifts under $50', blurb: 'A little more special.', to: '/search?maxPrice=5000&sort=popular' },
  { title: 'Gifts under $100', blurb: 'Something to keep for years.', to: '/search?maxPrice=10000&sort=popular' },
  { title: 'One of a kind', blurb: 'Only one exists, and it could be yours.', to: '/search?oneOfAKind=true' },
  { title: 'Made by hand', blurb: 'Everything here is handmade.', to: '/search?handmade=true' },
  { title: 'Free shipping', blurb: 'Nothing extra to pay to send it.', to: '/search?freeShipping=true' },
  { title: 'Ready to ship', blurb: 'In stock now, so it arrives sooner.', to: '/search?inStock=true&sort=new' },
  { title: 'New from makers', blurb: 'The latest pieces to go on sale.', to: '/search?sort=new' },
];
/** Gift ideas that are real searches, so they always match what is for sale. */
export function GuidesPage() {
  return <div className="screen pad" style={{ paddingTop: 10 }}><h1 className="serif">Gift guides</h1><p className="muted">Find a gift by budget or by the kind of piece. Each guide is a live search of what is for sale right now.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, marginTop: 16 }}>{GUIDES.map(g => <Link key={g.title} to={g.to} className="card" style={{ padding: 16, minHeight: 88, display: 'block' }}><b className="serif" style={{ fontSize: 19 }}>{g.title}</b><span className="muted" style={{ display: 'block', marginTop: 4 }}>{g.blurb}</span></Link>)}</div></div>;
}
