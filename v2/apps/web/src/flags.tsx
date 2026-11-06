import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** The admin's feature toggles, as the website sees them. Until they arrive (or if they cannot load) everything counts as ON, so a slow request never hides a feature. */
export type FlagKey = 'guest_checkout' | 'buyer_signups' | 'wishlists' | 'shop_follows' | 'gift_options' | 'reviews' | 'order_chat' | 'ads' | 'store_promotions' | 'maker_signups';
const Ctx = createContext<Partial<Record<FlagKey, boolean>>>({});

export function FlagsProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<Partial<Record<FlagKey, boolean>>>({});
  useEffect(() => { let live = true; fetch('/api/flags', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : {})).then(j => { if (live) setFlags(j); }).catch(() => {}); return () => { live = false; }; }, []);
  return <Ctx.Provider value={flags}>{children}</Ctx.Provider>;
}
export const useFlag = (key: FlagKey): boolean => useContext(Ctx)[key] !== false;
