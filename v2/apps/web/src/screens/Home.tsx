import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button, Chip, Pills, ProductCard, SectionHead } from '../components/ui';
import { ProductArt } from '../art/ProductArt';
import type { ArtKind, Tone } from '../art/tones';
import { PhoneTop, SearchBox } from '../components/Layout';
import { useApi } from '../api';
import { useDesktop } from '../hooks';
import { useSession, type ApiCard } from '../session';

interface HomeData { categories: { slug: string; label: string; kind: ArtKind; tone: Tone }[]; phone: ApiCard[]; desktop: ApiCard[]; spotlight: { shop: { name: string; slug: string; city: string; tagline: string; logo: string | null }; quote: string; art: { kind: ArtKind; tone: Tone } | null } | null }
const Skeleton = () => <div className="pad" style={{ marginTop: 22 }}><div className="skeleton" style={{ height: 300 }} /></div>;

/** Home. Phone matches reference buyer-home.png, desktop matches buyer-home-desktop.png. Both read the same /api/home. */
export function Home() {
  const desktop = useDesktop(); const { data } = useApi<HomeData>('/api/home'); const { card } = useSession();
  if (!data) return <Skeleton />;
  return desktop ? <DesktopHome d={data} card={card} /> : <PhoneHome d={data} card={card} />;
}
type Card = ReturnType<typeof useSession>['card'];

function PhoneHome({ d, card }: { d: HomeData; card: Card }) {
  return <div className="screen">
    <PhoneTop />
    <div className="pad" style={{ marginTop: 12 }}><SearchBox /></div>
    <div className="pad" style={{ marginTop: 14 }}><Pills items={['All', ...d.categories.map(c => c.label)]} /></div>
    <div className="pad" style={{ marginTop: 16 }}>
      <div className="hero"><Chip variant="surf">New season</Chip>
        <h1 className="serif">Made by hand.<br />Chosen with care.</h1>
        <Button size="sm" style={{ marginTop: 16 }} to="/c/pottery-ceramics">Shop new arrivals</Button>
        <div className="tile" style={{ right: -18, bottom: -14, width: 170, height: 170, borderRadius: 20, transform: 'rotate(6deg)' }}><ProductArt kind="pottery" tone="blush" /></div>
        <div className="tile" style={{ right: 112, bottom: -30, width: 120, height: 120, borderRadius: 18, transform: 'rotate(-7deg)' }}><ProductArt kind="perfume" tone="butter" /></div></div></div>
    <div className="pad" style={{ marginTop: 22 }}>
      <SectionHead title="New from makers" action="See all" />
      <div className="grid2">{d.phone.map(c => <ProductCard key={c.id} p={card(c)} />)}</div>
      {d.spotlight && <div style={{ marginTop: 20 }}><Link to={`/shop/${d.spotlight.shop.slug}`} className="card spotlight"><div className="round64"><ProductArt kind={d.spotlight.art?.kind ?? 'pottery'} tone={d.spotlight.art?.tone ?? 'warm'} /></div>
        <div style={{ flex: 1 }}><div className="muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>Maker spotlight</div><div className="serif" style={{ fontSize: 18, marginTop: 2 }}>{d.spotlight.shop.name}</div><div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{d.spotlight.shop.tagline.replace(/ from .*/, '')}, {d.spotlight.shop.city}</div></div><Icon name="chev" /></Link></div>}</div>
  </div>;
}

function DesktopHome({ d, card }: { d: HomeData; card: Card }) {
  return <div>
    <div className="dhero"><div className="l"><Chip variant="surf">New season</Chip><h1 className="serif">Made by hand.<br />Chosen with care.</h1><p>Distinctive pieces from independent makers across Canada. Shipped straight from their studios.</p>
      <div className="btns"><Button to="/c/pottery-ceramics">Shop new arrivals</Button><Button variant="ghost" to="/makers" style={{ background: 'var(--surf)' }}>Meet the makers</Button></div></div>
      <div className="r"><div><ProductArt kind="pottery" tone="blush" /></div><div><ProductArt kind="perfume" tone="butter" /></div><div><ProductArt kind="candle" tone="sand" /></div></div></div>
    <div className="dsec"><h2 className="serif">Shop by category</h2><div className="dcats">{d.categories.map(c => <Link key={c.slug} to={`/c/${c.slug}`}><div className="c"><ProductArt kind={c.kind} tone={c.tone} /></div><span>{c.label}</span></Link>)}</div></div>
    <div className="dsec new"><div className="dnewhead"><h2 className="serif">New from makers</h2><Link to="/search?sort=new">See all</Link></div><div className="drow">{d.desktop.map(c => <ProductCard key={c.id} p={card(c)} />)}</div></div>
    {d.spotlight && <div className="dspot"><div className="art"><div><ProductArt kind={d.spotlight.art?.kind ?? 'pottery'} tone={d.spotlight.art?.tone ?? 'warm'} /></div></div><div className="t"><div className="k">Maker spotlight</div><h3 className="serif">{d.spotlight.shop.name}</h3><p>{d.spotlight.quote}</p><Button to={`/shop/${d.spotlight.shop.slug}`}>Visit the shop</Button></div></div>}
    <div className="dtrust">{[['shield', 'Buyer protection', 'If it does not arrive or is not as described, we make it right.'], ['store', 'Real makers', 'Every shop is run by an independent small business.'], ['truck', 'Shipped with care', 'Fragile pieces are packed to arrive in one piece.']].map(([i, h, s]) => <div key={h}><Icon name={i as 'shield'} /><div><b>{h}</b><p>{s}</p></div></div>)}</div>
  </div>;
}
