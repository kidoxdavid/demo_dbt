import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { config } from '../src/config.js';
import { ck, jpeg, login, studioSeller, upload, PW } from './helpers.js';

let app: FastifyInstance; let routes: { method: string; url: string }[] = [];
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 1_000_000 }); await app.ready(); routes = (app as any).routeTable; });
afterAll(async () => { await app.close(); await pool.end(); });

const UUID = '00000000-0000-4000-8000-000000000000';
/** Fill a route's :params with plausible junk (ids as uuids, everything else as a harmless word). */
const fill = (url: string) => url.replace(/:(\w+)\??/g, (_m, n: string) => (/id$/i.test(n) ? UUID : n === 'token' ? 'x'.repeat(30) : n === 'label' ? 'w320' : n === 'ref' ? 'mock_pi_junk' : n === 'term' ? 'carafe' : 'x')).replace(/\*/g, 'x');
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
const area = (url: string) => (url.match(/^\/api\/(admin|studio|support|finance|marketing)\//)?.[1] ?? 'shop') as 'admin' | 'studio' | 'support' | 'finance' | 'marketing' | 'shop';
const GATED = /^\/api\/(admin|studio|support|finance|marketing|me)(\/|$)/; const OPEN = new Set(['POST /api/studio/signup', 'GET /api/me/saved/ids']);
const call = (method: string, url: string, opts: { payload?: unknown; headers?: Record<string, string>; cookies?: Record<string, string> } = {}) => app.inject({ method: method as any, url: fill(url), headers: { 'content-type': 'application/json', ...opts.headers }, ...(opts.payload !== undefined ? { payload: typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload) } : {}), ...(opts.cookies ? { cookies: opts.cookies } : {}) });

describe('route sweep', () => {
  it('finds a believable number of routes (the sweep is not silently empty)', () => { expect(routes.length).toBeGreaterThan(150); expect(routes.filter(r => GATED.test(r.url)).length).toBeGreaterThan(80); });

  it('every staff, studio and account route refuses a request with no session (401), whatever the body', async () => {
    const bad: string[] = [];
    for (const r of routes.filter(r => GATED.test(r.url) && !OPEN.has(`${r.method} ${r.url}`))) for (const payload of [undefined, {}, { junk: 1 }]) {
      const res = await call(r.method, r.url, { payload: MUTATING.includes(r.method) ? payload : undefined }); if (res.statusCode !== 401) { bad.push(`${r.method} ${r.url} -> ${res.statusCode}`); break; } }
    expect(bad).toEqual([]);
  });

  it('a signed-in session only works in its own window: a buyer cookie opens nothing under staff or studio paths, and no window\'s cookie opens another\'s', async () => {
    const buyer = await login(app, 'shop'); const seller = await studioSeller(app); const admin = await login(app, 'admin', { role: 'admin' }); const bad: string[] = [];
    const jars: Record<string, Record<string, string>> = { buyer: { es_shop: buyer.cookie }, seller: { es_studio: seller.cookie }, admin: { es_admin: admin.cookie } };
    for (const r of routes.filter(r => GATED.test(r.url) && !OPEN.has(`${r.method} ${r.url}`))) {
      const a = area(r.url); for (const [who, jar] of Object.entries(jars)) {
        const home = who === 'buyer' ? 'shop' : who === 'seller' ? 'studio' : 'admin'; if (a === home) continue;                  // that is their own window, covered elsewhere
        const res = await call(r.method, r.url, { payload: MUTATING.includes(r.method) ? {} : undefined, cookies: jar }); if (res.statusCode !== 401) bad.push(`${who} -> ${r.method} ${r.url} = ${res.statusCode}`); } }
    expect(bad).toEqual([]);
  });

  it('every state-changing route refuses a request that comes from another website (403), even with a valid cookie', async () => {
    const buyer = await login(app, 'shop'); const bad: string[] = [];
    for (const r of routes.filter(r => MUTATING.includes(r.method))) {
      for (const origin of ['https://evil.example', 'null']) { const res = await call(r.method, r.url, { payload: {}, headers: { origin }, cookies: { es_shop: buyer.cookie } }); if (res.statusCode !== 403) bad.push(`${r.method} ${r.url} origin=${origin} -> ${res.statusCode}`); } }
    expect(bad).toEqual([]);
  });

  it('no route answers 500 to missing, empty or junk input, signed in or not; errors never leak a stack trace', async () => {
    const buyer = await login(app, 'shop'); const seller = await studioSeller(app); const staff = { admin: await login(app, 'admin', { role: 'admin' }), support: await login(app, 'support', { role: 'support' }), finance: await login(app, 'finance', { role: 'finance' }), marketing: await login(app, 'marketing', { role: 'marketing' }) };
    const jar = { es_shop: buyer.cookie, es_studio: seller.cookie, es_admin: staff.admin.cookie, es_support: staff.support.cookie, es_finance: staff.finance.cookie, es_marketing: staff.marketing.cookie };
    const payloads: unknown[] = [undefined, {}, { a: 1 }, [], 'not json {', { id: UUID, body: 'x'.repeat(5000), email: 'a@b', quantity: -1, rating: 99, reason: '<script>', token: 'x', variantId: 'nope' }];
    const bad: string[] = [];
    for (const r of routes) {
      if (r.url === '/api/logout' || r.url === '/api/auth/logout') continue;
      for (const withCookies of [false, true]) for (const p of payloads) {
        if (!MUTATING.includes(r.method) && p !== undefined) continue;
        const res = await call(r.method, r.url, { payload: MUTATING.includes(r.method) ? p : undefined, cookies: withCookies ? jar : undefined });
        const notConfigured = res.statusCode === 503 && /"(push|payments)_not_configured"/.test(res.body);          // an honest "this is not set up", not a crash
        if (res.statusCode >= 500 && !notConfigured) bad.push(`${r.method} ${r.url} ${withCookies ? 'signed-in' : 'anon'} -> ${res.statusCode} ${res.body.slice(0, 80)}`);
        else if (/\bat [\w.<>]+ \(|node_modules|\.ts:\d+/.test(res.body)) bad.push(`${r.method} ${r.url} leaks internals: ${res.body.slice(0, 80)}`); }
    }
    expect(bad).toEqual([]);
  }, 180_000);
});

describe('transport and input limits', () => {
  it('malformed, oversized and wrongly typed bodies are refused cleanly', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email": ' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(2 * 1024 * 1024) }) })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'text/plain' }, payload: 'email=a' })).statusCode).toBeLessThan(500);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: ['a@b.test'], password: { $ne: 1 } }) })).statusCode).toBe(400);
    let deep: any = {}; for (let i = 0; i < 4000; i++) deep = { a: deep }; expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(deep).slice(0, 900_000) })).statusCode).toBeLessThan(500);
  });
  it('every response carries the safety headers; the API never says what it is built with', async () => {
    for (const url of ['/api/home', '/api/products', '/api/me', '/healthz', '/api/does-not-exist']) { const r = await app.inject({ method: 'GET', url }); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-powered-by']).toBeUndefined(); expect(r.headers['content-security-policy']).toContain("default-src 'none'"); expect(r.headers['x-frame-options']).toBeDefined(); }
  });
  it('health says up, readiness checks the database', async () => { expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true }); expect((await app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({ ok: true }); });
});

describe('SQL injection and odd characters in search and filters', () => {
  it('search, filters and sort treat quotes, comment markers and SQL as plain text; the data is intact afterwards', async () => {
    const sel = await studioSeller(app); const med = (await upload(app, sel.cookie, await jpeg())).json();          // two live pieces of our own, so the comparison below never depends on test order
    for (const title of ['Order 1 mug', 'Zebra vase']) { const p = (await app.inject({ method: 'POST', url: '/api/studio/products', payload: { title, categorySlug: 'pottery-ceramics', priceCents: 2000, stock: 3, attributes: {}, mediaIds: [med.id] }, ...ck('studio', sel.cookie) })).json(); await app.inject({ method: 'POST', url: `/api/studio/products/${p.id}/publish`, payload: { acknowledged: true }, ...ck('studio', sel.cookie) }); }
    const before = Number((await q('SELECT count(*) n FROM users')).rows[0].n); const bad: string[] = [];
    const evil = ["'; DROP TABLE users; --", "' OR '1'='1", '%', '_', '\\', '") OR 1=1 --', 'a\u0000b', '😀'.repeat(50), '{{7*7}}', '../../etc/passwd', 'x'.repeat(500)];
    for (const e of evil) for (const url of [`/api/products?q=${encodeURIComponent(e)}`, `/api/products?category=${encodeURIComponent(e)}`, `/api/products?shop=${encodeURIComponent(e)}&sort=${encodeURIComponent(e)}`, `/api/products?attr.material=${encodeURIComponent(e)}`, `/api/search/suggest?q=${encodeURIComponent(e)}`, `/api/shops/${encodeURIComponent(e)}`, `/api/ads?placement=search&q=${encodeURIComponent(e)}`, `/api/products?minPrice=${encodeURIComponent(e)}`]) {
      const r = await app.inject({ method: 'GET', url }); if (r.statusCode >= 500) bad.push(`${url.slice(0, 60)} -> ${r.statusCode}`); }
    expect(bad).toEqual([]); expect(Number((await q('SELECT count(*) n FROM users')).rows[0].n)).toBe(before);
    const inj = (await app.inject({ method: 'GET', url: `/api/products?q=${encodeURIComponent("' OR '1'='1")}` })).json().total; const plain = (await app.inject({ method: 'GET', url: `/api/products?q=${encodeURIComponent('or 1 1')}` })).json().total; const all = (await app.inject({ method: 'GET', url: '/api/products?limit=1' })).json().total;
    expect(inj).toBe(plain); expect(inj).toBeGreaterThan(0); expect(inj).toBeLessThan(all);          // an injection string is just words: it matches exactly what those words match, never everything
  });
});

describe('cookies and sessions', () => {
  it('session cookies are HttpOnly and SameSite, Secure in production, and a session cannot be reused after sign-out', async () => {
    const u = await login(app, 'shop'); const prev = config.secureCookies;
    try { config.secureCookies = true; const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-area': 'shop', 'content-type': 'application/json' }, payload: { email: u.email, password: PW } }); const c = r.cookies.find(x => x.name === 'es_shop')!; expect(c.httpOnly).toBe(true); expect(c.secure).toBe(true); expect(String(c.sameSite).toLowerCase()).toBe('lax'); expect(c.path).toBe('/'); }
    finally { config.secureCookies = prev; }
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', ...ck('shop', u.cookie) }); expect(out.statusCode).toBeLessThan(300); expect((await app.inject({ method: 'GET', url: '/api/me', ...ck('shop', u.cookie) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/me', ...ck('shop', 'x'.repeat(40)) })).statusCode).toBe(401);
  });
  it('the session token is stored hashed, never as the cookie value', async () => {
    const u = await login(app, 'shop'); expect(Number((await q(`SELECT count(*) n FROM sessions WHERE token_hash=$1`, [u.cookie])).rows[0].n)).toBe(0);
  });
});
