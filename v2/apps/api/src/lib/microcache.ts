import { config } from '../config.js';

interface Entry { at: number; value?: unknown; pending?: Promise<unknown> }
const store = new Map<string, Entry>(); const MAX = 500;
/**
 * A very short memory for answers that are the same for everyone (listings, search, the home page).
 * Many identical requests at once share ONE database query; the answer is reused for `listCacheMs` (10 seconds in production, off in tests), then looked up again.
 * Errors are never kept. Nothing personal goes through here: callers only use it for anonymous, public data.
 */
export async function microcache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ttl = config.listCacheMs; if (ttl <= 0) return fn();
  const now = Date.now(); const hit = store.get(key);
  if (hit) { if (hit.pending) return hit.pending as Promise<T>; if (now - hit.at < ttl) return hit.value as T; }
  const pending = fn().then(v => { store.set(key, { at: Date.now(), value: v }); return v; }, e => { store.delete(key); throw e; });
  store.set(key, { at: now, pending });
  if (store.size > MAX) { for (const [k, e] of store) { if (!e.pending && now - e.at >= ttl) store.delete(k); if (store.size <= MAX * 0.8) break; } if (store.size > MAX) store.delete(store.keys().next().value as string); }
  return pending;
}
export const clearMicrocache = () => store.clear();
