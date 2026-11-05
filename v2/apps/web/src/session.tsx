import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from './api';
import type { CardData } from './components/ui';
import type { ArtKind, Tone } from './art/tones';
import { moneyShort } from './format';

export interface User { id: string; email: string; fullName: string }
export interface ApiCard { id: string; title: string; seller: { name: string; slug: string }; priceCents: number; wasCents: number | null; chip: string | null; photo: string | null; art: { kind: string; tone: string } | null; available: boolean }
interface Ctx {
  user: User | null; ready: boolean; savedProducts: Set<string>; followedShops: Set<string>; toast: string | null;
  signIn: (email: string, password: string) => Promise<void>; signUp: (email: string, password: string, fullName: string) => Promise<void>; signOut: () => Promise<void>;
  toggleSaved: (productId: string) => Promise<void>; toggleFollow: (slug: string) => Promise<void>; say: (msg: string) => void; card: (c: ApiCard, tone?: Tone) => CardData;
}
const S = createContext<Ctx | null>(null);
export const useSession = () => { const c = useContext(S); if (!c) throw new Error('SessionProvider missing'); return c; };

/** Who is signed in (the shop window) and what they have saved. Guests can browse and buy; saving and following ask them to sign in first. */
export function SessionProvider({ children, onChange }: { children: ReactNode; onChange?: () => void }) {
  const nav = useNavigate(); const loc = useLocation();
  const [user, setUser] = useState<User | null>(null); const [ready, setReady] = useState(false); const [products, setProducts] = useState<Set<string>>(new Set()); const [shops, setShops] = useState<Set<string>>(new Set()); const [toast, setToast] = useState<string | null>(null);
  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); }, []);
  const load = useCallback(async () => {
    try { const me = await api<{ id: string; email: string; fullName: string }>('/api/me'); setUser({ id: me.id, email: me.email, fullName: me.fullName });
      const s = await api<{ products: string[]; shops: string[] }>('/api/me/saved/ids'); setProducts(new Set(s.products)); setShops(new Set(s.shops));
    } catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e; setUser(null); setProducts(new Set()); setShops(new Set()); } finally { setReady(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const needSignIn = useCallback((why: string) => { say(why); nav(`/account?next=${encodeURIComponent(loc.pathname + loc.search)}`); }, [nav, loc, say]);
  const v = useMemo<Ctx>(() => ({ user, ready, savedProducts: products, followedShops: shops, toast, say,
    signIn: async (email, password) => { await api('/api/auth/login', { method: 'POST', body: { email, password }, headers: { 'x-area': 'shop' } }); await load(); onChange?.(); },
    signUp: async (email, password, fullName) => { await api('/api/auth/signup', { method: 'POST', body: { email, password, fullName } }); await load(); onChange?.(); },
    signOut: async () => { await api('/api/auth/logout', { method: 'POST' }); await load(); onChange?.(); },
    toggleSaved: async id => { if (!user) return needSignIn('Sign in to save pieces'); const on = products.has(id); const next = new Set(products); on ? next.delete(id) : next.add(id); setProducts(next);
      try { await api(`/api/me/saved/${id}`, { method: on ? 'DELETE' : 'PUT' }); } catch { setProducts(products); say('Could not save. Try again.'); } },
    toggleFollow: async slug => { if (!user) return needSignIn('Sign in to follow shops'); const on = shops.has(slug); const next = new Set(shops); on ? next.delete(slug) : next.add(slug); setShops(next);
      try { await api(`/api/shops/${slug}/follow`, { method: on ? 'DELETE' : 'PUT' }); } catch { setShops(shops); say('Could not follow. Try again.'); } },
    card: (c, tone) => ({ id: c.id, title: c.title, seller: c.seller.name, price: moneyShort(c.priceCents), was: c.wasCents ? moneyShort(c.wasCents) : undefined, chip: c.chip ?? undefined, photo: c.photo ?? undefined, soldOut: !c.available,
      art: c.art ? { kind: c.art.kind as ArtKind, tone: (tone ?? c.art.tone) as Tone } : undefined, href: `/p/${c.id}`, heart: { on: products.has(c.id), toggle: () => { void v.toggleSaved(c.id); } } }) }), [user, ready, products, shops, toast, say, load, needSignIn, onChange]);
  return <S.Provider value={v}>{children}{toast && <div className="toast" role="status">{toast}</div>}</S.Provider>;
}
