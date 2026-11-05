// End-to-end notifications in a real browser: bell and inbox for a buyer and a maker, settings that stick, an unsubscribe link, and the push-on-this-device flow.
// Headless Chromium cannot reach a real push service, so the browser's subscribe() call is replaced with one that returns a browser-shaped subscription; everything on OUR side (service worker, key, permission flow, API, queue) is real.
// Run: VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... on the API; then CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/notifications-flow.mjs
import { chromium } from 'playwright'; import sharp from 'sharp'; import { createHmac } from 'node:crypto';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const H = { origin: BASE }; const PW = 'correct-horse-battery-staple'; const SECRET = process.env.NOTIFY_SECRET ?? 'dev-only-notify-secret';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fails = []; const log = []; const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const stamp = Date.now(); const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#3d5a4b' } }).png().toBuffer();
const mk = async (w = 390, perms = []) => { const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'en-CA' }); if (perms.length) await ctx.grantPermissions(perms, { origin: BASE }); const page = await ctx.newPage(); page.on('pageerror', e => fails.push(`page error: ${e.message}`)); return { ctx, page }; };
const post = async (ctx, url, data) => { const r = await ctx.request.post(`${BASE}${url}`, { data, headers: H }); if (!r.ok()) throw new Error(`${url} ${r.status()} ${await r.text()}`); return r.json().catch(() => ({})); };
const unsubToken = (email, category) => { const b = Buffer.from(JSON.stringify({ e: email, c: category })).toString('base64url'); return `${b}.${createHmac('sha256', SECRET).update(b).digest('base64url')}`; };

// ---- set up: a maker with a live product, and a buyer who writes to them
const maker = await mk(1280); await post(maker.ctx, '/api/studio/signup', { email: `maker${stamp}@t.test`, password: PW, fullName: 'Mara Maker', categories: ['candles-home-fragrance'], shopName: `Wick Works ${stamp % 1000}` });
const med = await (await maker.ctx.request.post(`${BASE}/api/studio/media`, { data: png, headers: { ...H, 'content-type': 'image/png' } })).json();
const prod = await post(maker.ctx, '/api/studio/products', { title: 'Wick soy candle', categorySlug: 'candles-home-fragrance', priceCents: 2800, stock: 9, attributes: {}, mediaIds: [med.id] }); await post(maker.ctx, `/api/studio/products/${prod.id}/publish`, { acknowledged: true });
const shop = await (await maker.ctx.request.get(`${BASE}/api/studio/shop`)).json();
const buyerEmail = `buyer${stamp}@t.test`; const buyer = await mk(390, ['notifications']); const bp = buyer.page;
await bp.addInitScript(() => {                      // stand-in for the browser's push service: same shapes a real browser returns
  const sub = async () => { const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)); const b64 = u => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); const auth = crypto.getRandomValues(new Uint8Array(16));
    return { endpoint: `https://push.example.test/device/${Math.random().toString(36).slice(2)}`, toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: b64(raw), auth: b64(auth) } }; }, unsubscribe: async () => { window.__pushSub = null; return true; } }; };
  PushManager.prototype.subscribe = async function () { window.__pushSub = await sub(); return window.__pushSub; }; PushManager.prototype.getSubscription = async function () { return window.__pushSub ?? null; };
});
await bp.goto(`${BASE}/account`); await bp.getByRole('button', { name: 'Create an account' }).click(); await bp.fill('#ac-name', 'Bea Buyer'); await bp.fill('#ac-email', buyerEmail); await bp.fill('#ac-pw', PW); await bp.getByRole('button', { name: 'Create account' }).click(); await bp.waitForSelector('text=Hello, Bea');
await post(buyer.ctx, `/api/shops/${shop.slug}/messages`, { productId: prod.id, body: 'Does the candle come with a lid?' });

// ---- 1. the maker is told, in the studio
await maker.page.goto(`${BASE}/studio`); await maker.page.waitForSelector('.sd-side'); await maker.page.waitForFunction(() => /\d/.test(document.querySelector('a[href="/studio/notifications"] .sd-badge')?.textContent ?? ''), null, { timeout: 15000 }); ok(true, 'the studio sidebar shows an unread badge on Notifications');
await maker.page.locator('.sd-side a', { hasText: 'Notifications' }).click(); await maker.page.waitForSelector('text=New message from Bea B.'); ok(true, 'the new message is in the maker\'s inbox'); await maker.page.locator('.thread-row', { hasText: 'New message from' }).first().click(); await maker.page.waitForURL(/\/studio\/messages\//); ok(true, 'opening it goes to the conversation');
await maker.page.fill('#chat-in', 'Yes, it comes with a lid.'); await maker.page.getByRole('button', { name: 'Send' }).click(); await maker.page.waitForSelector('text=Yes, it comes with a lid.'); await maker.page.goto(`${BASE}/studio/notifications`); await maker.page.waitForSelector('.thread-row'); ok(!(await maker.page.locator('.dot').count()), 'a notification that was opened is no longer unread');

// ---- 2. the buyer's bell
await bp.goto(`${BASE}/`); await bp.waitForSelector('.pcard'); await bp.waitForSelector('a[aria-label^="Notifications"] .badge'); ok((await bp.locator('a[aria-label^="Notifications"] .badge').innerText()) === '1', 'the buyer\'s bell shows one unread');
await bp.goto(`${BASE}/account/notifications`); await bp.waitForSelector('text=New message from'); await bp.locator('.thread-row').first().click(); await bp.waitForURL(/\/account\/messages\//); await bp.waitForSelector('text=Yes, it comes with a lid.'); ok(true, 'tapping a notification opens the conversation');
await bp.goto(`${BASE}/`); await bp.waitForSelector('.pcard'); await bp.waitForFunction(() => !document.querySelector('a[aria-label^="Notifications"] .badge')); ok(true, 'and the bell clears');

// ---- 3. settings that stick; receipts locked
await bp.goto(`${BASE}/account/notifications`); await bp.getByRole('tab', { name: 'Settings' }).click(); await bp.waitForSelector(`text=Emails go to ${buyerEmail}`); const orders = bp.locator('.card', { hasText: 'Orders and shipping' }).first().getByLabel(/Email/); ok(await orders.isDisabled() && await orders.isChecked(), 'order emails are locked on');
const msg = bp.locator('.card', { hasText: 'Messages' }).first(); await msg.getByLabel('Email').uncheck(); await bp.waitForTimeout(400); await bp.reload(); await bp.getByRole('tab', { name: 'Settings' }).click(); await bp.waitForSelector(`text=Emails go to`); ok(!(await bp.locator('.card', { hasText: 'Messages' }).first().getByLabel('Email').isChecked()), 'switching message emails off is remembered'); await bp.locator('.card', { hasText: 'Messages' }).first().getByLabel('Email').check();

// ---- 4. push on this device (real service worker, real key, real permission flow; only the browser's subscribe is stood in)
await bp.getByRole('button', { name: 'Turn on for this device' }).click(); await bp.getByText(/^On for this device/).waitFor(); ok(true, 'push turns on for this device');
const sw = await bp.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/'); return r?.active?.scriptURL ?? r?.installing?.scriptURL ?? r?.waiting?.scriptURL ?? null; }); ok(!!sw && sw.endsWith('/sw.js'), `the service worker is registered (${sw})`);
await bp.getByRole('button', { name: 'Send me a test' }).click(); await bp.waitForSelector('text=Sent. It should arrive'); await bp.getByRole('tab', { name: /Inbox/ }).click(); await bp.waitForSelector('text=Notifications are working'); ok(true, 'the test lands in the inbox and is queued as a push');
await bp.getByRole('tab', { name: 'Settings' }).click(); await bp.getByRole('button', { name: 'Turn off on this device' }).click(); await bp.waitForSelector('text=Turn on for this device'); ok(true, 'push can be turned off again');

// ---- 5. unsubscribing from an email link, signed out
const anon = await mk(390); await anon.page.goto(`${BASE}/unsubscribe?t=${encodeURIComponent(unsubToken(buyerEmail, 'reviews'))}`); await anon.page.waitForSelector('text=Stop reviews emails?'); await anon.page.getByRole('button', { name: 'Unsubscribe' }).click(); await anon.page.waitForSelector('text=You are unsubscribed'); ok(true, 'an unsubscribe link works without signing in');
await bp.goto(`${BASE}/account/notifications`); await bp.getByRole('tab', { name: 'Settings' }).click(); await bp.waitForSelector('text=Reviews'); ok(!(await bp.locator('.card', { hasText: 'Reviews' }).first().getByLabel('Email').isChecked()), 'the signed-out unsubscribe shows in the account settings');
await anon.page.goto(`${BASE}/unsubscribe?t=${encodeURIComponent(unsubToken(buyerEmail, 'reviews') + 'x')}`); await anon.page.waitForSelector('text=This link does not work'); ok(true, 'a forged link is refused');
await anon.page.goto(`${BASE}/unsubscribe?t=${encodeURIComponent(unsubToken(buyerEmail, 'orders'))}`); await anon.page.waitForSelector('text=This link does not work'); ok(true, 'order emails cannot be unsubscribed from by link');
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll notifications flow checks passed.'); process.exit(fails.length ? 1 : 0);
