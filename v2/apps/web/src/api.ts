import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error { constructor(public status: number, public code: string, public body: any) { super(code); } }
/** One place that talks to the API: same-origin, cookies included, JSON in and out, plain error codes. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const r = await fetch(path, { method: opts.method ?? 'GET', credentials: 'same-origin', headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await r.text(); const data = text ? JSON.parse(text) : null; if (!r.ok) throw new ApiError(r.status, data?.error ?? 'error', data); return data as T;
}
/** GET with loading and error state. Pass null to wait. Refetches when the path changes. */
export function useApi<T = any>(path: string | null) {
  const [state, set] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: path !== null });
  const [n, setN] = useState(0); const reload = useCallback(() => setN(x => x + 1), []);
  useEffect(() => { if (path === null) return; let live = true; set(s => ({ ...s, loading: true }));
    api<T>(path).then(data => live && set({ data, error: null, loading: false }), error => live && set({ data: null, error, loading: false })); return () => { live = false; }; }, [path, n]);
  return { ...state, reload };
}
