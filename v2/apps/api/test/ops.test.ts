import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { checkProductionConfig } from '../src/lib/prod-check.js';
import { redact, safePath } from '../src/lib/log.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });

const GOOD = { DATABASE_URL: 'postgres://app:longpassword@db.internal:5432/eazystores', ALLOWED_ORIGINS: 'https://eazystores.ca', PUBLIC_URL: 'https://eazystores.ca', AD_SECRET: 'a'.repeat(40), NOTIFY_SECRET: 'b'.repeat(40), SMTP_URL: 'smtps://u:p@smtp.example.com:465', EMAIL_FROM: 'eazystores <hello@eazystores.ca>', TRUST_PROXY: 'true', PAYMENT_PROVIDER: 'stripe', VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'y', UPLOAD_DIR: '/data/uploads' };

describe('production configuration check', () => {
  it('a complete configuration passes without warnings', () => { expect(checkProductionConfig(GOOD)).toEqual({ errors: [], warnings: [] }); });
  it('names every missing or unsafe setting in plain words', () => {
    const e = checkProductionConfig({}).errors.join('\n'); for (const k of ['DATABASE_URL', 'ALLOWED_ORIGINS', 'PUBLIC_URL', 'AD_SECRET', 'NOTIFY_SECRET', 'SMTP_URL', 'EMAIL_FROM']) expect(e).toContain(k);
    expect(checkProductionConfig({ ...GOOD, DATABASE_URL: 'postgres://es2:es2_pw@localhost:5432/eazystores2' }).errors.join()).toContain('development database');
    expect(checkProductionConfig({ ...GOOD, ALLOWED_ORIGINS: 'http://eazystores.ca' }).errors.join()).toContain('https');
    expect(checkProductionConfig({ ...GOOD, PUBLIC_URL: 'http://eazystores.ca' }).errors.join()).toContain('PUBLIC_URL');
    expect(checkProductionConfig({ ...GOOD, AD_SECRET: 'short' }).errors.join()).toContain('at least 32');
    expect(checkProductionConfig({ ...GOOD, NOTIFY_SECRET: 'dev-only-notify-secret-dev-only-notify-secret' }).errors.join()).toContain('placeholder');
    expect(checkProductionConfig({ ...GOOD, PAYMENT_PROVIDER: 'mock' }).errors.join()).toContain('never be used in production');
  });
  it('warns, without stopping, about things that quietly weaken or disable features', () => {
    const w = checkProductionConfig({ ...GOOD, TRUST_PROXY: undefined, PAYMENT_PROVIDER: undefined, VAPID_PUBLIC_KEY: undefined, UPLOAD_DIR: undefined }); expect(w.errors).toEqual([]); expect(w.warnings.join('\n')).toMatch(/TRUST_PROXY[\s\S]*payment provider[\s\S]*VAPID[\s\S]*UPLOAD_DIR/);
  });
});

describe('logging', () => {
  it('secrets never reach the log, and order links and ids in paths are shortened', () => {
    expect(redact({ password: 'hunter2', token: 't', cookie: 'es_shop=abc', Authorization: 'Bearer x', apiKey: 'k', nested: { smtpPassword: 'p', ok: 'fine' }, list: [{ secret: 's' }] })).toEqual({ password: '[redacted]', token: '[redacted]', cookie: '[redacted]', Authorization: '[redacted]', apiKey: '[redacted]', nested: { smtpPassword: '[redacted]', ok: 'fine' }, list: [{ secret: '[redacted]' }] });
    expect(safePath('/api/orders/by-token/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789?x=1')).toBe('/api/orders/by-token/:token'); expect(safePath('/api/studio/orders/123e4567-e89b-42d3-a456-426614174000/ship')).toBe('/api/studio/orders/:id/ship'); expect(safePath('/api/products?q=secret+stuff')).toBe('/api/products');
    expect(safePath(`/api/unsubscribe/${'a'.repeat(120)}.${'b'.repeat(43)}`)).toBe('/api/unsubscribe/:token');
  });
  it('every response has a request id; a good one from a caller is kept, a hostile one is replaced', async () => {
    const a = await app.inject({ method: 'GET', url: '/healthz' }); expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'trace-abc12345' } })).headers['x-request-id']).toBe('trace-abc12345');
    const evil = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'bad id\r\nSet-Cookie: x=1' } }); expect(String(evil.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('a real server process', () => {
  it('starts, answers readiness, and on SIGTERM finishes cleanly with exit code 0 and a log trail (no secrets)', async () => {
    const port = 3300 + Math.floor(Math.random() * 400); const out: string[] = []; const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PORT: String(port), NODE_ENV: 'development', LOG_IN_TEST: 'true' } });
    child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
    const until = async (re: RegExp, ms = 30_000) => { const t0 = Date.now(); while (!re.test(out.join('')) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 100)); expect(out.join('')).toMatch(re); };
    await until(/EAZYstores API on/); const ready = await fetch(`http://127.0.0.1:${port}/readyz`); expect(await ready.json()).toEqual({ ok: true }); expect(ready.headers.get('x-request-id')).toBeTruthy();
    const code = new Promise<number | null>(r => child.on('exit', c => r(c))); child.kill('SIGTERM'); expect(await code).toBe(0); const all = out.join(''); expect(all).toContain('SIGTERM: shutting down'); expect(all).toContain('shutdown complete'); expect(all).not.toMatch(/password|es2_pw/i);
    for (const line of all.split('\n').filter(l => l.startsWith('{'))) expect(() => JSON.parse(line)).not.toThrow();                              // every log line is one valid JSON object
  }, 60_000);
});
