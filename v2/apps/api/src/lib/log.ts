/** One JSON object per line, to stdout: easy for any log tool to read. Secrets never get in: values under sensitive-looking keys are replaced, and long opaque path pieces (order links, tokens) are shortened. */
const SENSITIVE = /pass|secret|token|cookie|authorization|api[-_]?key|private|signature|card/i;
export const redact = (v: unknown, depth = 0): unknown => {
  if (depth > 4 || v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.slice(0, 20).map(x => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(x, depth + 1)]));
};
/** /api/orders/by-token/AbC...long -> /api/orders/by-token/:token ; query strings are dropped entirely. */
export const safePath = (url: string) => url.split('?')[0].split('/').map(seg => (/^[0-9a-f-]{36}$/i.test(seg) ? ':id' : seg.length > 24 && /^[\w.~%-]+$/.test(seg) ? ':token' : seg)).join('/');
export type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'test' && process.env.LOG_IN_TEST !== 'true') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields) as object) }); (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(line + '\n');
}
export const errorFields = (e: unknown) => (e instanceof Error ? { error: e.message, stack: e.stack?.split('\n').slice(0, 6).join(' | ') } : { error: String(e) });
