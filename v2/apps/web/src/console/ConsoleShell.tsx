import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { Button, Wordmark } from '../components/ui';

export type ConsoleArea = 'admin' | 'support' | 'finance' | 'marketing';
export interface Staff { id: string; email: string; fullName: string; roles: { role: string }[] }
interface Ctx { area: ConsoleArea; user: Staff | null; ready: boolean; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void> }
const C = createContext<Ctx | null>(null);
export const useConsole = () => { const c = useContext(C); if (!c) throw new Error('ConsoleProvider missing'); return c; };
export const useArea = () => useConsole().area;
/** Path of an API route inside this console's window (the server picks the sign-in from the path). */
export const useApiPath = () => { const a = useArea(); return (p: string) => `/api/${a}${p}`; };

export const NAV: Record<ConsoleArea, { to: string; label: string; icon: IconName; end?: boolean }[]> = {
  admin: [{ to: '', label: 'Overview', icon: 'home', end: true }, { to: '/users', label: 'People', icon: 'user' }, { to: '/sellers', label: 'Sellers', icon: 'store' }, { to: '/moderation', label: 'Review queue', icon: 'shield' }, { to: '/promotions', label: 'Store promotions', icon: 'chart' }, { to: '/settings', label: 'Settings', icon: 'tag' }, { to: '/audit', label: 'Audit log', icon: 'chart' }],
  support: [{ to: '', label: 'Orders', icon: 'box', end: true }, { to: '/users', label: 'People', icon: 'user' }, { to: '/audit', label: 'Audit log', icon: 'chart' }],
  finance: [{ to: '', label: 'Overview', icon: 'home', end: true }, { to: '/sellers', label: 'Seller balances', icon: 'wallet' }, { to: '/orders', label: 'Orders and refunds', icon: 'box' }, { to: '/reports', label: 'GST and exports', icon: 'chart' }, { to: '/audit', label: 'Audit log', icon: 'shield' }],
  marketing: [{ to: '', label: 'Home page', icon: 'home', end: true }, { to: '/ads', label: 'Ads', icon: 'chart' }, { to: '/promotions', label: 'Store promotions', icon: 'tag' }, { to: '/synonyms', label: 'Search words', icon: 'search' }],
};
const WORD: Record<ConsoleArea, string> = { admin: 'admin', support: 'support', finance: 'finance', marketing: 'marketing' };

export function ConsoleProvider({ area }: { area: ConsoleArea }) {
  const [user, setUser] = useState<Staff | null>(null); const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => { try { const me = await api<Staff>(`/api/${area}/me`); setUser(me); } catch (e) { if (!(e instanceof ApiError && [401, 403].includes(e.status))) throw e; setUser(null); } finally { setReady(true); } }, [area]);
  useEffect(() => { void refresh(); }, [refresh]);
  const v = useMemo<Ctx>(() => ({ area, user, ready, login: async (email, password) => { await api('/api/auth/login', { method: 'POST', body: { email, password }, headers: { 'x-area': area } }); await refresh(); }, logout: async () => { await api('/api/auth/logout', { method: 'POST', headers: { 'x-area': area } }); await refresh(); } }), [area, user, ready, refresh]);
  return <C.Provider value={v}><Outlet /></C.Provider>;
}

export function ConsoleLogin() {
  const { area, user, ready, login } = useConsole(); const nav = useNavigate(); const loc = useLocation(); const [f, setF] = useState({ email: '', password: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (ready && user) return <Navigate to={(loc.state as any)?.from ?? `/${area}`} replace />;
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); setBusy(true); try { await login(f.email.trim(), f.password); nav((loc.state as any)?.from ?? `/${area}`, { replace: true }); }
    catch (x) { setErr(x instanceof ApiError && x.code === 'invalid_credentials' ? 'That email and password do not match.' : x instanceof ApiError && x.code === 'account_locked' ? 'Too many tries. Wait a few minutes and try again.' : x instanceof ApiError && x.status === 403 ? 'Your account does not have access to this console.' : 'Something went wrong. Try again.'); } finally { setBusy(false); } };
  return <div role="main" className="screen pad" style={{ paddingTop: 60 }}><div className="co"><div style={{ textAlign: 'center' }}><Wordmark large word={WORD[area]} /><h1 className="serif" style={{ marginTop: 16, fontSize: 26 }}>Staff sign-in</h1><p className="muted" style={{ fontSize: 13, marginTop: 6 }}>This window is separate from the shop and the studio. Being signed in elsewhere does not sign you in here.</p></div>
    <form onSubmit={submit} noValidate><label className="label" htmlFor="cl-email">Email</label><input id="cl-email" className="field" type="email" autoComplete="username" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required />
      <label className="label" htmlFor="cl-pw">Password</label><input id="cl-pw" className="field" type="password" autoComplete="current-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required />
      {err && <div className="err" role="alert">{err}</div>}<Button type="submit" block style={{ marginTop: 18 }} disabled={busy}>{busy ? 'One moment…' : 'Sign in'}</Button></form></div></div>;
}

/** Sidebar on a wide screen, a scrolling tab row on a narrow one. */
export function ConsoleLayout() {
  const { area, user, ready, logout } = useConsole(); const { pathname } = useLocation();
  if (!ready) return <div className="pad" style={{ paddingTop: 40 }}><div className="skeleton" style={{ height: 240 }} /></div>;
  if (!user) return <Navigate to={`/${area}/login`} replace state={{ from: pathname }} />;
  const base = `/${area}`; const on = (n: { to: string; end?: boolean }) => (n.end ? pathname === base + n.to || pathname === base + n.to + '/' : pathname.startsWith(base + n.to));
  return <div className="sd cons"><aside className="sd-side"><Link to={base}><Wordmark word={WORD[area]} /></Link>
    <nav aria-label={`${area} sections`} className="cons-nav">{NAV[area].map(n => <Link key={n.label} to={base + n.to} className={`sd-nav${on(n) ? ' on' : ''}`} aria-current={on(n) ? 'page' : undefined}><Icon name={n.icon} />{n.label}</Link>)}</nav>
    <div className="card sd-shopcard"><b>{user.fullName}</b><div className="u">{user.email}</div><button type="button" className="muted" style={{ fontSize: 12, marginTop: 8, textDecoration: 'underline' }} onClick={() => logout()}>Sign out</button></div></aside>
    <main className="sd-main"><Outlet /></main></div>;
}
