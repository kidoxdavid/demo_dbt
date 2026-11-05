import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

let app: FastifyInstance;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'es-web-')); mkdirSync(join(dir, 'assets')); mkdirSync(join(dir, 'fonts'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>shell</title><div id="root"></div>'); writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'sw.js'), '// sw'); writeFileSync(join(dir, 'fonts', 'x.woff2'), 'f');
  app = await buildApp({ webDir: dir });
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('the website is served by the same service', () => {
  it('serves the page for the home page and for app routes, with a page security policy and no caching', async () => {
    for (const url of ['/', '/c/pottery-ceramics', '/studio/login', '/p/123?x=1', '/orders/some-long-token']) {
      const r = await app.inject({ method: 'GET', url }); expect(r.statusCode, url).toBe(200); expect(r.body).toContain('id="root"');
      expect(r.headers['cache-control']).toBe('no-cache'); expect(String(r.headers['content-security-policy'])).toContain("script-src 'self'"); expect(String(r.headers['content-security-policy'])).not.toContain("script-src 'self' 'unsafe-inline'");
    }
  });
  it('caches hashed files for a year, fonts for a week, and never the service worker', async () => {
    expect((await app.inject({ method: 'GET', url: '/assets/app-abc123.js' })).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject({ method: 'GET', url: '/fonts/x.woff2' })).headers['cache-control']).toBe('public, max-age=604800');
    expect((await app.inject({ method: 'GET', url: '/sw.js' })).headers['cache-control']).toBe('no-cache');
  });
  it('keeps the API strict: JSON 404s, the data-only policy, and no page for a missing file or an unknown API path', async () => {
    const miss = await app.inject({ method: 'GET', url: '/api/nope' }); expect(miss.statusCode).toBe(404); expect(miss.json()).toEqual({ error: 'not_found' }); expect(String(miss.headers['content-security-policy'])).toContain("default-src 'none'");
    expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/c/anything', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200); expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ ok: true });
  });
});
