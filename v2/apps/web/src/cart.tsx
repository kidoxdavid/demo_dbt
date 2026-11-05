import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export interface CartLine { id: string; variantId: string; productId: string; title: string; variant: string | null; quantity: number; unitCents: number; compareAtCents: number | null; lineCents: number; image: string | null; art: { kind: string; tone: string } | null; issue: string | null; available: number | null; oneOfAKind: boolean }
export interface CartSeller { sellerId: string; shop: { name: string; slug: string; logo: string | null }; itemsCents: number; shippingCents: number; freeShipping: boolean; eta: { min: string; max: string; shipBy: string }; gift: { isGift: boolean; message: string } | null; lines: CartLine[] }
export interface CartView { count: number; itemsCents: number; shippingCents: number; totalCents: number; taxNote: string; blocked: boolean; sellers: CartSeller[] }
const EMPTY: CartView = { count: 0, itemsCents: 0, shippingCents: 0, totalCents: 0, taxNote: '', blocked: false, sellers: [] };
interface Ctx { cart: CartView; ready: boolean; refresh: () => Promise<void>; add: (variantId: string, quantity?: number) => Promise<void>; setQty: (id: string, quantity: number) => Promise<void>; remove: (id: string) => Promise<void>; setGift: (sellerId: string, isGift: boolean, message: string) => Promise<void> }
const C = createContext<Ctx | null>(null);
export const useCart = () => { const c = useContext(C); if (!c) throw new Error('CartProvider missing'); return c; };

/** The basket lives on the server (guest cookie or account); the browser only mirrors what the server priced. */
export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, set] = useState<CartView>(EMPTY); const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => { try { set(await api<CartView>('/api/cart')); } finally { setReady(true); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const v = useMemo<Ctx>(() => ({ cart, ready, refresh,
    add: async (variantId, quantity = 1) => set(await api<CartView>('/api/cart/items', { method: 'POST', body: { variantId, quantity } })),
    setQty: async (id, quantity) => set(await api<CartView>(`/api/cart/items/${id}`, { method: 'PATCH', body: { quantity } })),
    remove: async id => set(await api<CartView>(`/api/cart/items/${id}`, { method: 'DELETE' })),
    setGift: async (sellerId, isGift, message) => set(await api<CartView>(`/api/cart/gift/${sellerId}`, { method: 'PUT', body: { isGift, message } })) }), [cart, ready, refresh]);
  return <C.Provider value={v}>{children}</C.Provider>;
}
