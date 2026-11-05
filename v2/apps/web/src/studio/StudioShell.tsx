import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { STUDIO_TABS, TabBar, Wordmark } from '../components/ui';
import { useDesktop } from '../hooks';

export interface StudioUser { id: string; email: string; fullName: string }
export interface StudioShop { id: string; slug: string; name: string; tagline: string | null; story: string | null; city: string | null; region: string | null; look: string; status: string; vacation: boolean; processing: { minDays: number; maxDays: number };
  logo: string | null; banner: string | null; policies: any; badges: string[]; categories: { slug: string; name: string; tile: string; sellerTips: string; photoGuide: string; restricted: boolean }[]; products: { total: number; published: number }; policyTemplates: Record<string, string> }
interface Ctx { user: StudioUser | null; shop: StudioShop | null; ready: boolean; toShip: number; refresh: () => Promise<void>; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void> }
const C = createContext<Ctx | null>(null);
export const useStudio = () => { const c = useContext(C); if (!c) throw new Error('StudioProvider missing'); return c; };

/** The studio is its own sign-in window (cookie es_studio): a person can be a buyer and a seller with separate sessions. */
export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<StudioUser | null>(null); const [shop, setShop] = useState<StudioShop | null>(null); const [ready, setReady] = useState(false); const [toShip, setToShip] = useState(0);
  const refresh = useCallback(async () => {
    try { const me = await api<any>('/api/studio/me'); const [s, o] = await Promise.all([api<StudioShop>('/api/studio/shop'), api<{ toShip: number }>('/api/studio/orders?limit=1')]); setUser({ id: me.id, email: me.email, fullName: me.fullName }); setShop(s); setToShip(o.toShip); }
    catch (e) { if (!(e instanceof ApiError && [401, 403].includes(e.status))) throw e; setUser(null); setShop(null); setToShip(0); } finally { setReady(true); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const v = useMemo<Ctx>(() => ({ user, shop, ready, toShip, refresh, login: async (email, password) => { await api('/api/auth/login', { method: 'POST', body: { email, password }, headers: { 'x-area': 'studio' } }); await refresh(); }, logout: async () => { await api('/api/auth/logout', { method: 'POST', headers: { 'x-area': 'studio' } }); await refresh(); } }), [user, shop, ready, toShip, refresh]);
  return <C.Provider value={v}>{children}</C.Provider>;
}

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [{ to: '/studio', label: 'Home', icon: 'home', end: true }, { to: '/studio/orders', label: 'Orders', icon: 'box' }, { to: '/studio/products', label: 'Products', icon: 'tag' }, { to: '/studio/messages', label: 'Messages', icon: 'msg' }, { to: '/studio/reviews', label: 'Reviews', icon: 'msg' },
  { to: '/studio/promotions', label: 'Promotions', icon: 'tag' }, { to: '/studio/shop', label: 'Shop page', icon: 'store' }, { to: '/studio/insights', label: 'Insights', icon: 'chart' }, { to: '/studio/payouts', label: 'Payouts', icon: 'wallet' }];
const PHONE_TAB = (p: string) => (p === '/studio' ? 0 : p.startsWith('/studio/orders') ? 1 : p.startsWith('/studio/products') ? 2 : p.startsWith('/studio/messages') ? 3 : p.startsWith('/studio/insights') ? 4 : null);

/** Signed-in studio chrome: sidebar on desktop, glass tab bar on a phone. Signed-out visitors are sent to the studio sign-in. */
export function StudioLayout() {
  const { user, shop, ready, toShip } = useStudio(); const desktop = useDesktop(); const { pathname } = useLocation();
  if (!ready) return <div className="pad" style={{ paddingTop: 40 }}><div className="skeleton" style={{ height: 240 }} /></div>;
  if (!user || !shop) return <Navigate to="/studio/login" replace state={{ from: pathname }} />;
  const url = `eazystores.ca/shop/${shop.slug}`; const tab = PHONE_TAB(pathname);
  if (!desktop) return <><div className="sd-phone-pad"><Outlet /></div>{tab !== null && <TabBar items={STUDIO_TABS} active={tab} />}</>;
  return <div className="sd"><aside className="sd-side"><Link to="/studio"><Wordmark studio /></Link>
    {NAV.map(n => <Link key={n.label} to={n.to} className={`sd-nav${(n.end ? pathname === n.to : pathname.startsWith(n.to)) ? ' on' : ''}`}><Icon name={n.icon} />{n.label}{n.label === 'Orders' && toShip > 0 && <span className="sd-badge">{toShip}</span>}</Link>)}
    <div className="card sd-shopcard"><b>{shop.name}</b><div className="u">{url}</div></div></aside><main className="sd-main"><Outlet /></main></div>;
}
