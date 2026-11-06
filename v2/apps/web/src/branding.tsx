import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type PortalKey = 'studio' | 'admin' | 'support' | 'finance' | 'marketing';
export interface Brand { word: string; look: string }
const DEFAULTS: Record<PortalKey, Brand> = { studio: { word: 'studio', look: 'atelier' }, admin: { word: 'admin', look: 'atelier' }, support: { word: 'support', look: 'atelier' }, finance: { word: 'finance', look: 'atelier' }, marketing: { word: 'marketing', look: 'atelier' } };
const Ctx = createContext<Record<PortalKey, Brand>>(DEFAULTS);

/** Each portal's name beside the logo and its colour look, as the admin set them. Falls back to the defaults while loading or if it cannot load. */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const [b, setB] = useState(DEFAULTS);
  useEffect(() => { let live = true; fetch('/api/settings/public', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : {})).then((j: any) => { if (live && j?.portal_branding) setB({ ...DEFAULTS, ...j.portal_branding }); }).catch(() => {}); return () => { live = false; }; }, []);
  return <Ctx.Provider value={b}>{children}</Ctx.Provider>;
}
export const useBrand = (p: PortalKey): Brand => useContext(Ctx)[p] ?? DEFAULTS[p];

/** Apply a portal's look to the whole page (the same place the shop's look and dark mode live), and put the old look back when leaving. */
export function useApplyLook(look: string) {
  useEffect(() => { const root = document.documentElement; const prev = root.getAttribute('data-theme'); root.setAttribute('data-theme', look); return () => { if (prev) root.setAttribute('data-theme', prev); else root.removeAttribute('data-theme'); }; }, [look]);
}
