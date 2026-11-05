import { useState, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { BUYER_TABS, TabBar, Wordmark } from './ui';
import { useCart } from '../cart';
import { useDesktop } from '../hooks';
import { useApi } from '../api';

/** The search field is a real form: Enter goes to /search?q=. */
export function SearchBox({ large, initial = '' }: { large?: boolean; initial?: string }) {
  const nav = useNavigate(); const [q, setQ] = useState(initial);
  const submit = (e: FormEvent) => { e.preventDefault(); const t = q.trim(); if (t) nav(`/search?q=${encodeURIComponent(t)}`); };
  return <form className={`card search${large ? ' lg' : ''}`} role="search" onSubmit={submit}><span className="muted"><Icon name="search" /></span><input aria-label="Search" value={q} onChange={e => setQ(e.target.value)} placeholder={large ? 'Search for pottery, art, perfume, hair, toys…' : 'Search pottery, art, perfume…'} /></form>;
}
export function BasketLink() { const { cart } = useCart(); return <Link to="/basket" className="icon-link" aria-label={`Basket, ${cart.count} items`}><Icon name="bag" />{cart.count > 0 && <span className="badge">{cart.count}</span>}</Link>; }
export const PhoneTop = () => <div className="pad home-top"><Link to="/"><Wordmark /></Link><span style={{ flex: 1 }} /><Link to="/saved" aria-label="Saved"><Icon name="heart" /></Link><BasketLink /></div>;

function DesktopChrome() {
  const { data } = useApi<{ promoBar: string; categories: { slug: string; label: string }[] }>('/api/home');
  return <>
    {data?.promoBar && <div className="promo">{data.promoBar}</div>}
    <div className="dhead"><Link to="/"><Wordmark large /></Link><SearchBox large /><span className="right"><Link to="/studio">Sell on eazystores</Link><Link to="/saved" aria-label="Saved"><Icon name="heart" /></Link><Link to="/account" aria-label="Account"><Icon name="user" /></Link><BasketLink /></span></div>
    <nav className="dnav" aria-label="Categories">{(data?.categories ?? []).map(c => <Link key={c.slug} to={`/c/${c.slug}`}>{c.label === 'Art & prints' ? 'Art & prints' : c.label}</Link>)}<Link to="/guides">Gift guides</Link></nav></>;
}
const TAB_FOR = (p: string) => (p === '/' ? 0 : p.startsWith('/c/') || p.startsWith('/search') ? 1 : p.startsWith('/saved') ? 2 : p.startsWith('/account') || p.startsWith('/orders') ? 4 : null);

/** Desktop: promo bar, header and category nav. Phone: the glass tab bar (hidden on pages with their own bottom bar). */
export function BuyerLayout() {
  const desktop = useDesktop(); const { pathname } = useLocation(); const tab = TAB_FOR(pathname);
  return <>
    {desktop && <DesktopChrome />}
    <div className={desktop ? 'dmain' : undefined}><Outlet /></div>
    {!desktop && tab !== null && <TabBar items={BUYER_TABS} active={tab} />}
  </>;
}
