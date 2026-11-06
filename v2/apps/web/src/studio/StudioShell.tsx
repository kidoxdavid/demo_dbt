import { useApplyLook, useBrand } from '../branding';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { STUDIO_TABS, TabBar, Wordmark } from '../components/ui';
import { useDesktop } from '../hooks';
import { useUnread } from '../components/Notifications';

export interface StudioUser { id: string; email: string; fullName: string }
export interface StudioShop { id: string; slug: string; name: string; tagline: string | null; story: string | null; city: string | null; region: string | null; look: string; status: string; vacation: boolean; processing: { minDays: number; maxDays: number };
  logo: string | null; banner: string | null; policies: any; badges: string[]; categories: { slug: string; name: string; tile: string; sellerTips: string; photoGuide: string; restricted: boolean }[]; products: { total: number; published: number }; policyTemplates: Record<string, string> }
export interface Acting { sellerId: string; shop: string | null; reason: string }
interface Ctx { user: StudioUser | null; shop: StudioShop | null; acting: Acting | null; ready: boolean; toShip: number; refresh: () => Promise<void>; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void> }
const C = createContext<Ctx | null>(null);
export const useStudio = () => { const c = useContext(C); if (!c) throw new Error('StudioProvider missing'); return c; };

/** The studio is its own sign-in window (cookie es_studio): a person can be a buyer and a seller with separate sessions. */
export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<StudioUser | null>(null); const [shop, setShop] = useState<StudioShop | null>(null); const [ready, setReady] = useState(false); const [toShip, setToShip] = useState(0); const [acting, setActing] = useState<Acting | null>(null);
  const refresh = useCallback(async () => {
    try { const me = await api<any>('/api/studio/me'); const [s, o] = await Promise.all([api<StudioShop>('/api/studio/shop'), api<{ toShip: number }>('/api/studio/orders?limit=1')]); setUser({ id: me.id, email: me.email, fullName: me.fullName }); setActing(me.acting ?? null); setShop(s); setToShip(o.toShip); }
    catch (e) { if (!(e instanceof ApiError && [401, 403].includes(e.status))) throw e; setUser(null); setActing(null); setShop(null); setToShip(0); } finally { setReady(true); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const v = useMemo<Ctx>(() => ({ user, shop, acting, ready, toShip, refresh, login: async (email, password) => { await api('/api/auth/login', { method: 'POST', body: { email, password }, headers: { 'x-area': 'studio' } }); await refresh(); }, logout: async () => { await api('/api/auth/logout', { method: 'POST', headers: { 'x-area': 'studio' } }); await refresh(); } }), [user, shop, ready, toShip, refresh]);
  return <C.Provider value={v}>{children}</C.Provider>;
}

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [{ to: '/studio', label: 'Home', icon: 'home', end: true }, { to: '/studio/orders', label: 'Orders', icon: 'box' }, { to: '/studio/products', label: 'Products', icon: 'tag' }, { to: '/studio/messages', label: 'Messages', icon: 'msg' }, { to: '/studio/reviews', label: 'Reviews', icon: 'msg' }, { to: '/studio/notifications', label: 'Notifications', icon: 'msg' },
  { to: '/studio/ads', label: 'Ads', icon: 'chart' }, { to: '/studio/promotions', label: 'Promotions', icon: 'tag' }, { to: '/studio/shop', label: 'Shop page', icon: 'store' }, { to: '/studio/shipping', label: 'Shipping', icon: 'truck' }, { to: '/studio/insights', label: 'Insights', icon: 'chart' }, { to: '/studio/payouts', label: 'Payouts', icon: 'wallet' }];
const PHONE_TAB = (p: string) => (p === '/studio' ? 0 : p.startsWith('/studio/orders') ? 1 : p.startsWith('/studio/products') ? 2 : p.startsWith('/studio/messages') ? 3 : p.startsWith('/studio/insights') ? 4 : -1);

/** Signed-in studio chrome: sidebar on desktop, glass tab bar on a phone. Signed-out visitors are sent to the studio sign-in. */
/** Shown the whole time an admin is working inside a maker's studio. */
function ActingBanner({ acting }: { acting: Acting }) {
  const leave = async () => { try { const r = await api<{ back: string }>('/api/studio/acting/end', { method: 'POST' }); window.location.href = r.back; } catch { window.location.href = '/admin'; } };
  return <div role="status" style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--ink)', color: 'var(--bg)', padding: '10px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}><span style={{ flex: 1, minWidth: 200 }}><b>Working as admin inside {acting.shop ?? 'this maker'}</b> · everything you change is logged · reason: {acting.reason}</span><button type="button" onClick={leave} style={{ textDecoration: 'underline', color: 'inherit', fontWeight: 600 }}>Leave</button></div>;
}
/** Every studio section, one tap away on a phone. */
function StudioDrawer({ open, onClose, shopSlug }: { open: boolean; onClose: () => void; shopSlug: string }) {
  const { logout } = useStudio(); const first = useRef<HTMLAnchorElement>(null);
  useEffect(() => { if (!open) return; first.current?.focus(); const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', esc); document.body.style.overflow = 'hidden'; return () => { window.removeEventListener('keydown', esc); document.body.style.overflow = ''; }; }, [open, onClose]);
  if (!open) return null;
  return <><div className="cons-scrim" onClick={onClose} /><aside className="cons-drawer" role="dialog" aria-label="Menu"><div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}><Wordmark studio /><button type="button" className="cons-menu" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close menu">Close</button></div>
    <nav aria-label="Studio sections" className="cons-nav">{NAV.map((n, i) => <Link key={n.label} ref={i === 0 ? first : undefined} to={n.to} className="sd-nav" onClick={onClose}><Icon name={n.icon} />{n.label}</Link>)}<Link to={`/shop/${shopSlug}`} className="sd-nav" onClick={onClose}><Icon name="store" />View my shop</Link><Link to="/" className="sd-nav" onClick={onClose}><Icon name="home" />Back to eazystores</Link></nav>
    <div className="card sd-shopcard"><button type="button" className="muted" style={{ fontSize: 14, textDecoration: 'underline', minHeight: 44 }} onClick={() => { void logout(); }}>Sign out</button></div></aside></>;
}
export function StudioLayout() {
  const { user, shop, acting, ready, toShip } = useStudio(); const brand = useBrand('studio'); useApplyLook(brand.look); const [menu, setMenu] = useState(false);
  useEffect(() => { const h = () => setMenu(true); window.addEventListener('studio-menu', h); return () => window.removeEventListener('studio-menu', h); }, []); const [unread] = useUnread('studio', !!user); const desktop = useDesktop(); const { pathname } = useLocation();
  useEffect(() => { setMenu(false); }, [pathname]);
  if (!ready) return <div className="pad" style={{ paddingTop: 40 }}><div className="skeleton" style={{ height: 240 }} /></div>;
  if (!user || !shop) return <Navigate to="/studio/login" replace state={{ from: pathname }} />;
  const url = `eazystores.ca/shop/${shop.slug}`; const tab = PHONE_TAB(pathname);
  if (!desktop) return <>{acting && <ActingBanner acting={acting} />}{pathname !== '/studio' && <header className="cons-top"><Link to="/studio" aria-label="Studio home"><Wordmark word={brand.word} /></Link><button type="button" className="cons-menu" aria-haspopup="dialog" onClick={() => setMenu(true)}><span aria-hidden="true">☰</span> Menu</button></header>}<div className="sd-phone-pad"><Outlet /></div><StudioDrawer open={menu} onClose={() => setMenu(false)} shopSlug={shop.slug} />{tab !== null && <TabBar items={STUDIO_TABS} active={tab} />}</>;
  return <>{acting && <ActingBanner acting={acting} />}<div className="sd"><aside className="sd-side"><Link to="/studio"><Wordmark word={brand.word} /></Link>
    {NAV.map(n => <Link key={n.label} to={n.to} className={`sd-nav${(n.end ? pathname === n.to : pathname.startsWith(n.to)) ? ' on' : ''}`}><Icon name={n.icon} />{n.label}{n.label === 'Orders' && toShip > 0 && <span className="sd-badge">{toShip}</span>}{n.label === 'Notifications' && unread > 0 && <span className="sd-badge">{unread}</span>}</Link>)}
    <div className="card sd-shopcard"><b>{shop.name}</b><div className="u">{url}</div></div></aside><main className="sd-main"><Outlet /></main></div></>;
}
