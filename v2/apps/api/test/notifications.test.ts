import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer as netServer, type Server as NetServer } from 'node:net';
import { createServer as httpsServer, type Server as HttpServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import { buildApp } from '../src/app.js';
import { pool, q, tx } from '../src/db.js';
import { closeMailer, enqueue, processOutbox } from '../src/lib/outbox.js';
import { unsubscribeToken } from '../src/lib/notify.js';
import { processPush } from '../src/lib/push.js';
import { ck, jpeg, login, studioSeller, upload } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
afterEach(() => { delete process.env.SMTP_URL; closeMailer(); delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; });
const as = (area: 'shop' | 'studio', cookie: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...(cookie ? ck(area, cookie) : {}) });

/** A tiny SMTP server that records what it is sent: the real wire protocol, no mail leaves the machine. */
function smtp() {
  const got: { raw: string; to: string[] }[] = []; const srv: NetServer = netServer(sock => {
    sock.write('220 test ESMTP\r\n'); let buf = ''; let inData = false; let cur = { raw: '', to: [] as string[] };
    sock.on('data', d => { buf += d.toString(); for (;;) {
      if (inData) { const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return; cur.raw = buf.slice(0, end); buf = buf.slice(end + 5); inData = false; got.push(cur); cur = { raw: '', to: [] }; sock.write('250 queued\r\n'); continue; }
      const i = buf.indexOf('\r\n'); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2); const u = line.toUpperCase();
      if (u.startsWith('EHLO') || u.startsWith('HELO')) sock.write('250-localhost\r\n250 OK\r\n'); else if (u.startsWith('RCPT TO')) { cur.to.push(line); sock.write('250 OK\r\n'); } else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); } else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 OK\r\n'); } });
  });
  return new Promise<{ got: typeof got; url: string; close: () => void }>(res => srv.listen(0, '127.0.0.1', () => res({ got, url: `smtp://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() })));
}
const qp = (s: string) => s.replace(/\r\n[ \t]+/g, ' ').replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
/** What a browser hands over when you allow notifications: an endpoint, a P-256 public key and a 16-byte secret. */
function browserSub(endpoint: string) { const k = createECDH('prime256v1'); k.generateKeys(); return { endpoint, keys: { p256dh: k.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; }
const vapid = () => { const k = webpush.generateVAPIDKeys(); process.env.VAPID_PUBLIC_KEY = k.publicKey; process.env.VAPID_PRIVATE_KEY = k.privateKey; return k; };
/** A seller with a live shop and a buyer who has an account: the two ends of a message. */
async function pair() {
  const s = await studioSeller(app); const m = (await upload(app, s.cookie, await jpeg())).json(); const p = (await app.inject({ method: 'POST', url: '/api/studio/products', payload: { title: 'Notify mug', categorySlug: 'pottery-ceramics', priceCents: 2000, stock: 5, attributes: {}, mediaIds: [m.id] }, ...ck('studio', s.cookie) })).json();
  await app.inject({ method: 'POST', url: `/api/studio/products/${p.id}/publish`, payload: { acknowledged: true }, ...ck('studio', s.cookie) }); const buyer = await login(app, 'shop'); return { s, buyer, productId: p.id as string };
}
const writeToMaker = (c: string, slug: string, body = 'Is this mug dishwasher safe?') => as('shop', c, 'POST', `/api/shops/${slug}/messages`, { body });

describe('real email delivery', () => {
  it('sends over SMTP with an HTML part, one-click unsubscribe headers on optional mail only, and escapes what people type', async () => {
    const server = await smtp(); process.env.SMTP_URL = server.url; closeMailer(); const { s, buyer } = await pair();
    await q(`DELETE FROM outbox_emails WHERE to_email=$1`, [s.email]); await writeToMaker(buyer.cookie, s.shop.slug, 'Hello <script>alert(1)</script> & thanks');
    await tx(c => enqueue(c, s.email, 'order_shipped', { number: 1, shop: 'Shop', carrier: 'canada post', trackingNumber: 'AB1', trackingUrl: null, url: 'http://x/y' }));
    const r = await processOutbox(undefined, 5000); expect(r.sent).toBeGreaterThanOrEqual(2); const mine = server.got.filter(m => m.to.some(t => t.includes(s.email))); expect(mine).toHaveLength(2);
    const msg = mine.find(m => /Subject: New message/.test(m.raw))!; expect(msg).toBeDefined(); const raw = qp(msg.raw);
    expect(raw).toMatch(/List-Unsubscribe: <http[^>]+\/api\/unsubscribe\//); expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click'); expect(raw).toContain('Content-Type: text/html'); expect(raw).toContain('Content-Type: text/plain'); expect(raw).toContain('Unsubscribe from these emails');
    expect(raw).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(raw).not.toMatch(/<script>alert\(1\)<\/script>(?!<)/.source.replace('(?!<)', '')); expect(raw.split('Content-Type: text/html')[1]).not.toContain('<script>');
    const shipped = mine.find(m => /Subject: Your order #1/.test(m.raw))!; expect(qp(shipped.raw)).not.toContain('List-Unsubscribe');                         // receipts and shipping notices have no opt-out
    expect((await q(`SELECT status FROM outbox_emails WHERE to_email=$1 AND template='new_message'`, [s.email])).rows[0].status).toBe('sent'); server.close();
  });
  it('a mail server that is down means retries with growing delays, then a clear failure; nothing is lost or sent twice', async () => {
    process.env.SMTP_URL = 'smtp://127.0.0.1:1'; closeMailer(); const to = `down${Date.now()}@t.test`; await tx(c => enqueue(c, to, 'order_cancelled', { number: 9 }));
    const attempt = async () => { await q(`UPDATE outbox_emails SET send_after=now() WHERE to_email=$1 AND status='pending'`, [to]); await processOutbox(undefined, 5000); return (await q(`SELECT status, attempts, error, send_after > now() AS later FROM outbox_emails WHERE to_email=$1`, [to])).rows[0]; };
    const first = await attempt(); expect(first).toMatchObject({ status: 'pending', attempts: 1, later: true }); expect(first.error).toBeTruthy(); for (let i = 0; i < 3; i++) await attempt(); expect((await attempt())).toMatchObject({ status: 'failed', attempts: 5 });
  });
});

describe('preferences and unsubscribing', () => {
  it('a signed unsubscribe link switches optional mail off without signing in; receipts cannot be switched off; forged links do nothing', async () => {
    const email = `guest${Date.now()}@t.test`; expect(await tx(c => enqueue(c, email, 'review_request', { number: 1, shop: 'S', url: 'http://x' }))).toBe(true);
    const token = unsubscribeToken(email, 'reviews'); expect((await as('shop', null, 'GET', `/api/unsubscribe/${encodeURIComponent(token)}`)).json()).toMatchObject({ category: 'reviews', label: 'Reviews' });
    expect((await as('shop', null, 'POST', '/api/unsubscribe', { token: token + 'x' })).statusCode).toBe(400); expect((await as('shop', null, 'POST', '/api/unsubscribe', { token: 'nonsense.token' })).statusCode).toBe(400); expect((await as('shop', null, 'POST', '/api/unsubscribe', { token: unsubscribeToken(email, 'orders') })).statusCode).toBe(400);
    expect((await as('shop', null, 'POST', `/api/unsubscribe/${encodeURIComponent(token)}`, undefined)).json()).toMatchObject({ unsubscribed: true });                        // the one-click form mail apps use
    expect(await tx(c => enqueue(c, email, 'review_request', { number: 2, shop: 'S', url: 'http://x' }))).toBe(false); expect(await tx(c => enqueue(c, email, 'new_review', { rating: 5, product: 'p', author: 'a', preview: 'x', url: 'http://x' }))).toBe(false);
    expect(await tx(c => enqueue(c, email, 'new_message', { from: 'a', preview: 'x', url: 'http://x' }))).toBe(true);                               // other kinds are untouched
    expect(await tx(c => enqueue(c, email, 'order_confirmation', { number: 3, name: 'n', totalCents: 1, taxCents: 0, url: 'u', sellers: [] }))).toBe(true);
    expect(Number((await q(`SELECT count(*) n FROM audit_log WHERE action='notifications.unsubscribe' AND entity_id NOT LIKE '%guest%'`)).rows[0].n)).toBeGreaterThan(0);
  });
  it('people see and change their own choices (the same for buyer and studio), receipts are locked on, and choices follow the email address', async () => {
    const u = await login(app, 'shop'); const get = async () => (await as('shop', u.cookie, 'GET', '/api/me/notification-prefs')).json(); const d = await get();
    expect(d.categories.map((c: any) => [c.key, c.email, c.push])).toEqual([['orders', true, true], ['messages', true, true], ['reviews', true, false]]); expect(d.push).toEqual({ configured: false, devices: 0 });
    expect((await as('shop', u.cookie, 'PUT', '/api/me/notification-prefs', { category: 'orders', email: false })).json().error).toBe('transactional_email_always_sent'); expect((await as('shop', u.cookie, 'PUT', '/api/me/notification-prefs', { category: 'nonsense', email: false })).statusCode).toBe(400);
    expect((await as('shop', u.cookie, 'PUT', '/api/me/notification-prefs', { category: 'messages', email: false })).statusCode).toBe(200); expect((await get()).categories.find((c: any) => c.key === 'messages')).toMatchObject({ email: false, push: true });
    expect(await tx(c => enqueue(c, u.email, 'new_message', { from: 'a', preview: 'x', url: 'u' }))).toBe(false); await as('shop', u.cookie, 'PUT', '/api/me/notification-prefs', { category: 'messages', email: true, push: false }); expect(await tx(c => enqueue(c, u.email, 'new_message', { from: 'a', preview: 'x', url: 'u' }))).toBe(true);
    const other = await login(app, 'shop'); expect((await as('shop', other.cookie, 'GET', '/api/me/notification-prefs')).json().categories[1]).toMatchObject({ email: true, push: true }); expect((await as('shop', null, 'GET', '/api/me/notification-prefs')).statusCode).toBe(401);
  });
});

describe('in-app inbox', () => {
  it('events land in the right person\'s inbox only; unread counts, mark-read and mark-all work; maker and buyer see their own', async () => {
    const { s, buyer } = await pair(); const other = await login(app, 'shop'); await writeToMaker(buyer.cookie, s.shop.slug, 'Can you make it in blue?');
    const inbox = (await as('studio', s.cookie, 'GET', '/api/studio/notifications')).json(); expect(inbox.unread).toBe(1); expect(inbox.items[0]).toMatchObject({ kind: 'message', category: 'messages', read: false }); expect(inbox.items[0].title).toContain('New message from'); expect(inbox.items[0].url).toMatch(/^\/studio\/messages\//);
    expect((await as('shop', buyer.cookie, 'GET', '/api/me/notifications')).json().unread).toBe(0); expect((await as('shop', other.cookie, 'GET', '/api/me/notifications')).json().items).toEqual([]);
    expect((await as('shop', buyer.cookie, 'POST', `/api/me/notifications/${inbox.items[0].id}/read`)).statusCode).toBe(404);                                  // someone else's
    const tid = inbox.items[0].url.split('/').pop(); await app.inject({ method: 'POST', url: `/api/studio/threads/${tid}/messages`, payload: { body: 'Yes, blue is possible.' }, ...ck('studio', s.cookie) });
    const mine = (await as('shop', buyer.cookie, 'GET', '/api/me/notifications')).json(); expect(mine.unread).toBe(1); expect(mine.items[0].url).toBe(`/account/messages/${tid}`);
    expect((await as('studio', s.cookie, 'POST', `/api/studio/notifications/${inbox.items[0].id}/read`)).statusCode).toBe(200); expect((await as('studio', s.cookie, 'GET', '/api/studio/notifications/unread-count')).json().unread).toBe(0);
    await writeToMaker(buyer.cookie, s.shop.slug, 'Another question'); await app.inject({ method: 'POST', url: `/api/me/threads/${tid}/messages`, payload: { body: 'And in green?' }, ...ck('shop', buyer.cookie) }); expect((await as('studio', s.cookie, 'GET', '/api/studio/notifications/unread-count')).json().unread).toBe(2);
    expect((await as('studio', s.cookie, 'POST', '/api/studio/notifications/read-all')).json().unread).toBe(0); expect((await as('studio', s.cookie, 'GET', '/api/studio/notifications')).json().unread).toBe(0);
  });
});

describe('web push', () => {
  it('only accepts real browser subscriptions, only when keys are configured, at most ten per person, and signed-in people only', async () => {
    const u = await login(app, 'shop'); const sub = browserSub('https://push.example.test/send/abc');
    expect((await as('shop', u.cookie, 'POST', '/api/me/push', sub)).json().error).toBe('push_not_configured'); expect((await as('shop', null, 'GET', '/api/push/key')).json()).toEqual({ publicKey: null });
    const k = vapid(); expect((await as('shop', null, 'GET', '/api/push/key')).json()).toEqual({ publicKey: k.publicKey }); expect((await as('shop', null, 'POST', '/api/me/push', sub)).statusCode).toBe(401);
    expect((await as('shop', u.cookie, 'POST', '/api/me/push', { ...sub, endpoint: 'http://evil.example.test/x' })).json().error).toBe('invalid_endpoint'); expect((await as('shop', u.cookie, 'POST', '/api/me/push', { ...sub, keys: { p256dh: 'AAAA', auth: sub.keys.auth } })).json().error).toBe('invalid_keys');
    expect((await as('shop', u.cookie, 'POST', '/api/me/push', { ...sub, keys: { ...sub.keys, auth: 'AAAA' } })).json().error).toBe('invalid_keys'); expect((await as('shop', u.cookie, 'POST', '/api/me/push', sub)).statusCode).toBe(201);
    expect((await as('shop', u.cookie, 'POST', '/api/me/push', sub)).json().devices).toBe(1); for (let i = 0; i < 12; i++) await as('shop', u.cookie, 'POST', '/api/me/push', browserSub(`https://push.example.test/send/${i}`)); expect((await as('shop', u.cookie, 'GET', '/api/me/notification-prefs')).json().push).toEqual({ configured: true, devices: 10 });
    expect((await as('shop', u.cookie, 'DELETE', '/api/me/push', { endpoint: 'https://push.example.test/send/3' })).json().devices).toBe(9);
  });
  it('queues a push only when keys exist, the person has a device and has push on for that kind; reviews are off by default', async () => {
    vapid(); const { s, buyer } = await pair(); const owner = await login(app, 'studio', { role: 'seller_owner', sellerId: s.sellerId }); const pushRows = async (uid: string) => Number((await q('SELECT count(*) n FROM push_outbox WHERE user_id=$1', [uid])).rows[0].n);
    await writeToMaker(buyer.cookie, s.shop.slug, 'before any device'); expect(await pushRows(owner.id)).toBe(0);
    await as('studio', owner.cookie, 'POST', '/api/studio/push', browserSub('https://push.example.test/owner')); await writeToMaker(buyer.cookie, s.shop.slug, 'after a device'); expect(await pushRows(owner.id)).toBe(1);
    await as('studio', owner.cookie, 'PUT', '/api/studio/notification-prefs', { category: 'messages', push: false }); await writeToMaker(buyer.cookie, s.shop.slug, 'push is off now'); expect(await pushRows(owner.id)).toBe(1);
    const row = (await q('SELECT payload FROM push_outbox WHERE user_id=$1', [owner.id])).rows[0].payload; expect(row).toMatchObject({ title: expect.stringContaining('New message from'), tag: 'message' }); expect(row.url).toMatch(/^\/studio\/messages\//); expect(row.body.length).toBeLessThanOrEqual(60);
    await tx(c => import('../src/lib/notify.js').then(m => m.notifyUsers(c, [owner.id], { category: 'reviews', kind: 'review', title: 'New 5-star review', url: '/studio/reviews' }))); expect(await pushRows(owner.id)).toBe(1);          // reviews: push off by default
  });
  it('sends through a transport, removes devices the browser forgot, retries other failures and gives up after five tries', async () => {
    vapid(); const u = await login(app, 'shop'); await as('shop', u.cookie, 'POST', '/api/me/push', browserSub('https://push.example.test/a')); await as('shop', u.cookie, 'POST', '/api/me/push', browserSub('https://push.example.test/b'));
    const enqueuePush = () => q(`INSERT INTO push_outbox(user_id,payload) VALUES ($1,$2) RETURNING id`, [u.id, JSON.stringify({ title: 'Hello', body: 'World', url: '/x', tag: 't' })]).then(r => r.rows[0].id);
    const seen: string[] = []; const id = await enqueuePush(); await processPush(async (sub, payload) => { seen.push(sub.endpoint); expect(JSON.parse(payload)).toMatchObject({ title: 'Hello', url: '/x' }); }, 5000); expect(seen.filter(e => /\/(a|b)$/.test(e)).sort()).toEqual(['https://push.example.test/a', 'https://push.example.test/b']); expect((await q('SELECT status FROM push_outbox WHERE id=$1', [id])).rows[0].status).toBe('sent');
    const id2 = await enqueuePush(); const gone = Object.assign(new Error('gone'), { statusCode: 410 }); await processPush(async sub => { if (sub.endpoint.endsWith('/a')) throw gone; }, 5000); expect((await q('SELECT endpoint FROM push_subscriptions WHERE user_id=$1', [u.id])).rows.map(r => r.endpoint)).toEqual(['https://push.example.test/b']); expect((await q('SELECT status FROM push_outbox WHERE id=$1', [id2])).rows[0].status).toBe('sent');
    const id3 = await enqueuePush(); const boom = async () => { throw Object.assign(new Error('push service down'), { statusCode: 503 }); }; const again = async () => { await q(`UPDATE push_outbox SET send_after=now() WHERE id=$1`, [id3]); await processPush(boom, 5000); return (await q('SELECT status, attempts FROM push_outbox WHERE id=$1', [id3])).rows[0]; };
    expect(await again()).toMatchObject({ status: 'pending', attempts: 1 }); for (let i = 0; i < 3; i++) await again(); expect(await again()).toMatchObject({ status: 'failed', attempts: 5 });
    const lone = await login(app, 'shop'); await q(`INSERT INTO push_outbox(user_id,payload) VALUES ($1,'{}')`, [lone.id]); await processPush(async () => { throw new Error('should not be called'); }, 5000); expect((await q(`SELECT status FROM push_outbox WHERE user_id=$1`, [lone.id])).rows[0].status).toBe('no_device');
  });
  it('the real web-push path: payloads are encrypted for the browser and signed with the server key (checked against a local stand-in for the push service)', async () => {
    const k = vapid(); const hits: { headers: Record<string, string | string[] | undefined>; body: Buffer; url: string }[] = []; let status = 201;
    const dir = mkdtempSync(join(tmpdir(), 'es-push-')); execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' }); const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';          // test only: trust the throwaway certificate
    const svc: HttpServer = httpsServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => { const chunks: Buffer[] = []; req.on('data', d => chunks.push(d)); req.on('end', () => { hits.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url ?? '' }); res.statusCode = status; res.end(); }); });
    await new Promise<void>(r => svc.listen(0, '127.0.0.1', r)); const endpoint = `https://127.0.0.1:${(svc.address() as AddressInfo).port}/push/xyz`; const u = await login(app, 'shop'); await as('shop', u.cookie, 'POST', '/api/me/push', browserSub(endpoint));
    await q(`INSERT INTO push_outbox(user_id,payload) VALUES ($1,$2)`, [u.id, JSON.stringify({ title: 'Secret title', body: 'Secret body', url: '/orders/abc', tag: 'x' })]); expect((await processPush(undefined, 5000)).sent).toBe(1);
    expect(hits).toHaveLength(1); const h = hits[0]; expect(h.headers['content-encoding']).toBe('aes128gcm'); expect(String(h.headers.authorization)).toMatch(/^vapid t=.+, k=/); expect(String(h.headers.authorization)).toContain(k.publicKey); expect(h.headers.ttl).toBe('86400');
    expect(h.body.length).toBeGreaterThan(100); expect(h.body.toString('latin1')).not.toContain('Secret');                                                                                // the push service only ever sees ciphertext
    status = 410; await q(`INSERT INTO push_outbox(user_id,payload) VALUES ($1,'{"title":"x","body":"","url":"/","tag":"x"}')`, [u.id]); const r = await processPush(undefined, 5000); expect(r.removed).toBe(1); expect(Number((await q('SELECT count(*) n FROM push_subscriptions WHERE user_id=$1', [u.id])).rows[0].n)).toBe(0); svc.close(); if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  });
  it('"send me a test" runs through the same inbox and queue', async () => {
    const u = await login(app, 'shop'); expect((await as('shop', u.cookie, 'POST', '/api/me/push/test')).json().error).toBe('push_not_configured'); vapid(); expect((await as('shop', u.cookie, 'POST', '/api/me/push/test')).json().error).toBe('no_device');
    await as('shop', u.cookie, 'POST', '/api/me/push', browserSub('https://push.example.test/t')); expect((await as('shop', u.cookie, 'POST', '/api/me/push/test')).json()).toMatchObject({ queued: true, devices: 1 }); expect((await as('shop', u.cookie, 'GET', '/api/me/notifications')).json().items[0].title).toBe('Notifications are working');
    expect(Number((await q('SELECT count(*) n FROM push_outbox WHERE user_id=$1', [u.id])).rows[0].n)).toBe(1);
  });
});
