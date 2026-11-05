import { useSyncExternalStore, useCallback } from 'react';

export type CartLine = { key: string; variantId: string; name: string; title: string; priceCents: number; qty: number; image?: string; custom?: Record<string, string>; customView?: { label: string; value: string; type: string }[] };
const storeKey = (slug: string) => `eazy_cart_${slug}`;
export const lineKey = (variantId: string, custom?: Record<string, string>) => variantId + JSON.stringify(Object.entries(custom ?? {}).sort());

/** One shared cart per store: the header, the drawer, product cards and checkout all see the same lines at once. */
const cache = new Map<string, CartLine[]>(); const listeners = new Set<() => void>(); let drawer = false;
const emit = () => listeners.forEach(l => l());
const read = (slug: string): CartLine[] => {
  const hit = cache.get(slug); if (hit) return hit;
  let lines: CartLine[] = []; try { lines = (JSON.parse(localStorage.getItem(storeKey(slug)) ?? '[]') as CartLine[]).map(l => ({ ...l, key: l.key ?? lineKey(l.variantId, l.custom) })); } catch { /* storage unavailable */ }
  cache.set(slug, lines); return lines;
};
const write = (slug: string, lines: CartLine[]) => { cache.set(slug, lines); try { localStorage.setItem(storeKey(slug), JSON.stringify(lines)); } catch { /* cart lives in memory */ } emit(); };
if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key?.startsWith('eazy_cart_')) { cache.delete(e.key.slice('eazy_cart_'.length)); emit(); } });
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useCart(slug: string) {
  const lines = useSyncExternalStore(sub, () => read(slug), () => []);
  const open = useSyncExternalStore(sub, () => drawer, () => false);
  const add = useCallback((l: Omit<CartLine, 'qty' | 'key'>, qty = 1, openDrawer = true) => {
    const cur = read(slug); const k = lineKey(l.variantId, l.custom);
    write(slug, cur.some(x => x.key === k) ? cur.map(x => x.key === k ? { ...x, qty: Math.min(x.qty + qty, 100) } : x) : [...cur, { ...l, key: k, qty: Math.min(qty, 100) }]);
    if (openDrawer) { drawer = true; emit(); }
  }, [slug]);
  const setQty = useCallback((k: string, q: number) => { const cur = read(slug); write(slug, q <= 0 ? cur.filter(x => x.key !== k) : cur.map(x => x.key === k ? { ...x, qty: Math.min(q, 100) } : x)); }, [slug]);
  return {
    lines, open, subtotal: lines.reduce((n, l) => n + l.priceCents * l.qty, 0), count: lines.reduce((n, l) => n + l.qty, 0),
    add, setQty, clear: useCallback(() => write(slug, []), [slug]),
    setOpen: useCallback((v: boolean) => { drawer = v; emit(); }, []),
  };
}
