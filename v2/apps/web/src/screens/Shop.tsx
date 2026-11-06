import { useState } from 'react';
import { useFlag } from '../flags';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../api';
import { ReviewList, type ReviewData } from '../components/Engagement';
import { ProductArt } from '../art/ProductArt';
import type { ArtKind, Tone } from '../art/tones';
import { Icon } from '../components/Icon';
import { Button, Chip, ProductCard } from '../components/ui';
import { useDesktop } from '../hooks';
import { useSession, type ApiCard } from '../session';
import { ProductList } from './Listing';

interface Shop { name: string; slug: string; tagline: string | null; story: string | null; city: string | null; region: string | null; look: string; logo: string | null; banner: string | null; badges: string[]; verifiedMaker: boolean; rating: { avg: number; count: number } | null; vacation: boolean;
  policies: { returns?: { text?: string }; shipping?: { text?: string } } | null; processing: { minDays: number; maxDays: number }; productCount: number }
const BANNER_TONE: Record<string, Tone> = { atelier: 'blush', noir: 'ink', sage: 'sage', blush: 'blush', sky: 'sky' };
/** A promotion the maker is running on their own store page (only returned while it is approved, started and not over). */
function PromotionBanner({ slug }: { slug: string }) {
  const { data } = useApi<{ promotion: null | { headline: string; body: string; ctaLabel: string; product: ApiCard | null } }>(`/api/shops/${slug}/promotion`); const { card } = useSession(); const nav = useNavigate();
  const p = data?.promotion; if (!p) return null;
  const count = () => { void fetch(`/api/shops/${slug}/promotion/click`, { method: 'POST', credentials: 'same-origin' }).catch(() => {}); };
  return <section className="card" aria-label="Promotion from this maker" style={{ margin: '14px 0', padding: 16 }}>
    <span className="chip tag" style={{ position: 'static' }}>Promotion</span><h2 className="serif" style={{ fontSize: 22, margin: '8px 0 4px' }}>{p.headline}</h2>{p.body && <p className="muted" style={{ margin: 0 }}>{p.body}</p>}
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>{p.product && <div style={{ width: 150 }} onClickCapture={count}><ProductCard p={card(p.product)} /></div>}
      {p.product && <Button size="sm" onClick={() => { count(); nav(`/p/${p.product!.id}`); }}>{p.ctaLabel}</Button>}</div></section>;
}
const TABS = ['Shop', 'About', 'Reviews', 'Policies'] as const;
/** In development, ?look= previews a look everywhere (used by the visual tests); otherwise the shop's own look applies to its page. */
const lookOverride = () => import.meta.env.DEV && !!new URLSearchParams(location.search).get('look');

function ShopReviews({ slug, base }: { slug: string; base: { avg: number; count: number } | null }) {
  const [limit, setLimit] = useState(10); const { data } = useApi<ReviewData>(`/api/shops/${slug}/reviews?limit=${limit}`);
  return <div className="policy">{base && <p style={{ marginBottom: 10 }}><b>★ {base.avg.toFixed(1)}</b> overall from {base.count} ratings{data && data.count !== base.count ? `. ${data.count} written review${data.count === 1 ? '' : 's'} below.` : '.'}</p>}{data ? <ReviewList data={data} more={data.items.length < data.count} onMore={() => setLimit(limit + 10)} /> : <div className="skeleton" style={{ height: 80 }} />}</div>;
}
/** A shop page in the shop's chosen look. Matches reference shop-look-{atelier,noir,sage}.png (phone). */
export function ShopPage() {
  const { slug = '' } = useParams(); const nav = useNavigate(); const desktop = useDesktop(); const { data: s, error } = useApi<Shop>(`/api/shops/${slug}`);
  const first = useApi<{ items: ApiCard[] }>(s ? `/api/products?shop=${slug}&limit=1` : null).data?.items[0];
  const follows = useFlag('shop_follows'); const reviewsOn = useFlag('reviews'); const { followedShops, toggleFollow } = useSession(); const [tab, setTab] = useState<(typeof TABS)[number]>('Shop');
  if (error) return <div className="empty"><h2 className="serif">We could not find that shop</h2><Link to="/" className="btn" style={{ marginTop: 16 }}>Back to the shop</Link></div>;
  if (!s) return <div className="skeleton" style={{ height: 150, borderRadius: 0 }} />;
  const kind = (first?.art?.kind ?? 'pottery') as ArtKind; const following = followedShops.has(s.slug);
  const policies = s.policies ?? {};
  return <div role="main" data-theme={lookOverride() ? undefined : s.look} style={{ background: 'var(--bg)', color: 'var(--ink)', minHeight: '100vh' }}>
    <div className="shopbanner">{s.banner ? <img src={s.banner} alt="" /> : <ProductArt kind={kind} tone={BANNER_TONE[s.look] ?? 'blush'} />}
      {!desktop && <button className="backbtn" aria-label="Back" onClick={() => (history.length > 1 ? nav(-1) : nav('/'))}><Icon name="chev" /></button>}</div>
    <div className="pad" style={desktop ? { maxWidth: 1000, margin: '0 auto', width: '100%' } : undefined}><div className="shop-id"><div className="row"><div className="shoplogo">{s.logo ? <img src={s.logo} alt="" /> : <ProductArt kind={kind} tone="warm" />}</div>
      {follows && <Button size="sm" onClick={() => toggleFollow(s.slug)} aria-pressed={following}>{following ? 'Following' : 'Follow'}</Button>}</div>
      <h1 className="serif">{s.name}</h1><div className="sub">{[s.tagline?.replace(/ from .*/, ''), [s.city, s.region].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
      <div className="chips">{s.verifiedMaker && <Chip>Verified maker</Chip>}{s.rating && <Chip variant="outline">★ {s.rating.avg.toFixed(1)} · {s.rating.count} reviews</Chip>}{s.vacation && <Chip variant="outline">On vacation</Chip>}</div>
      {s.story && <div className="story">{s.story}</div>}
      <PromotionBanner slug={s.slug} />
      <div className="tabs" role="tablist">{TABS.filter(t => t !== 'Reviews' || reviewsOn).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === 'Shop' && <ProductList base={{ shop: s.slug }} bare />}
      {tab === 'About' && <div className="policy"><p>{s.story ?? s.tagline ?? 'This maker has not written their story yet.'}</p><p className="muted" style={{ marginTop: 10 }}>{s.city ? `Based in ${[s.city, s.region].filter(Boolean).join(', ')}. ` : ''}Orders ship in {s.processing.minDays === s.processing.maxDays ? s.processing.minDays : `${s.processing.minDays}–${s.processing.maxDays}`} days.</p></div>}
      {tab === 'Reviews' && <ShopReviews slug={s.slug} base={s.rating} />}
      {tab === 'Policies' && <div className="policy"><h3 className="serif">Returns</h3><p>{policies.returns?.text ?? 'Ask the maker about returns before you buy.'}</p>{policies.shipping?.text && <><h3 className="serif" style={{ marginTop: 14 }}>Shipping</h3><p>{policies.shipping.text}</p></>}</div>}
    </div></div>
    <div style={{ height: 40 }} />
  </div>;
}
void ProductCard;
