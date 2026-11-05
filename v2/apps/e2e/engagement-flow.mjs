// End-to-end engagement in a real browser: a delivered order gets reviewed, the maker replies, buyer and maker talk, a review is reported and moderated.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/engagement-flow.mjs   (stack on :5180 with AUTH_RATE_LIMIT_MAX raised, demo data)
import { chromium } from 'playwright'; import sharp from 'sharp';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const H = { origin: BASE }; const PW = 'correct-horse-battery-staple';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fails = []; const log = []; const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const stamp = Date.now(); const shopName = `Ember Candles ${stamp % 10000}`;
const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#b8704a' } }).png().toBuffer();
const mk = async (w = 390) => { const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'en-CA' }); const page = await ctx.newPage(); page.on('pageerror', e => fails.push(`page error: ${e.message}`)); return { ctx, page }; };
const post = async (ctx, url, data, headers = {}) => { const r = await ctx.request.post(`${BASE}${url}`, { data, headers: { ...H, ...headers } }); if (!r.ok()) throw new Error(`${url} ${r.status()} ${await r.text()}`); return r.json().catch(() => ({})); };

// ---- set up: a seller with a product, two delivered orders from two guests (done through the API like a real shop would)
const seller = await mk(); await post(seller.ctx, '/api/studio/signup', { email: `maker${stamp}@t.test`, password: PW, fullName: 'Mina Maker', categories: ['candles-home-fragrance'], shopName });
const med = await (await seller.ctx.request.post(`${BASE}/api/studio/media`, { data: png, headers: { ...H, 'content-type': 'image/png' } })).json();
const prod = await post(seller.ctx, '/api/studio/products', { title: 'Ember soy candle', categorySlug: 'candles-home-fragrance', priceCents: 5200, stock: 20, attributes: {}, mediaIds: [med.id] }); await post(seller.ctx, `/api/studio/products/${prod.id}/publish`, { acknowledged: true });
const shop = await (await seller.ctx.request.get(`${BASE}/api/studio/shop`)).json();
async function delivered(name) {
  const b = await browser.newContext({ locale: 'en-CA' }); const detail = await (await b.request.get(`${BASE}/api/products/${prod.id}`)).json();
  await post(b, '/api/cart/items', { variantId: detail.variants[0].id, quantity: 1 }); const co = await post(b, '/api/checkout', { email: `${name.split(' ')[0].toLowerCase()}${stamp}@t.test`, address: { name, line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } });
  await post(b, `/api/dev/payments/${co.payment.ref}/simulate`, { outcome: 'succeeded' }); const list = await (await seller.ctx.request.get(`${BASE}/api/studio/orders`)).json(); const so = list.items.find(i => i.number === co.number);
  await post(seller.ctx, `/api/studio/orders/${so.id}/ship`, { carrier: 'canada_post', trackingNumber: 'AB123456789CA' }); await post(seller.ctx, `/api/studio/orders/${so.id}/deliver`, {}); return { token: co.token, soId: so.id, number: co.number, ctx: b };
}
const o1 = await delivered('Bea Buyer'); const o2 = await delivered('Cal Critic');

// ---- 1. the buyer reviews from the order page
{
  const { ctx, page } = await mk(); await page.goto(`${BASE}/orders/${o1.token}`); await page.waitForSelector('text=Write a review'); ok(true, 'a delivered order offers a review');
  await page.getByRole('button', { name: 'Write a review' }).click(); ok(await page.getByRole('button', { name: 'Post review' }).isDisabled(), 'posting waits for a rating and some words');
  await page.getByRole('radio', { name: '5 stars' }).click(); await page.fill('input[id^="rt-"]', 'Beautiful scent'); await page.fill('textarea[id^="rb-"]', 'Arrived well packed and the scent fills the room.'); await page.getByRole('button', { name: 'Post review' }).click(); await page.waitForSelector('text=Your review');
  ok(true, 'the review posts and the order page shows it');
  await page.goto(`${BASE}/p/${prod.id}`); await page.waitForSelector('text=Beautiful scent'); const t = await page.locator('body').innerText(); ok(t.includes('Bea B.') && !t.includes('Bea Buyer'), 'the product page shows the review with a shortened name');
  await page.goto(`${BASE}/shop/${shop.slug}`); await page.getByRole('tab', { name: 'Reviews' }).click(); await page.waitForSelector('text=Beautiful scent'); ok(true, 'the shop page Reviews tab lists it');
  ok((await (await ctx.request.get(`${BASE}/api/shops/${shop.slug}`)).json()).rating.avg === 5, 'the shop rating follows the review');
  await ctx.close();
  const r = await o1.ctx.request.post(`${BASE}/api/orders/by-token/${o1.token}/reviews`, { data: { productId: prod.id, rating: 3, body: 'again' }, headers: H }); ok(r.status() === 409, 'a second review of the same order is refused');
}
// ---- 2. buyer writes to the maker from the order page; maker replies in the studio
{
  const { ctx, page } = await mk(); await page.goto(`${BASE}/orders/${o1.token}`); await page.getByRole('button', { name: `Message ${shopName}` }).click(); await page.fill('#chat-in', 'Could the candle be gift wrapped next time?'); await page.getByRole('button', { name: 'Send' }).click(); await page.waitForSelector('text=Could the candle be gift wrapped next time?'); ok(true, 'the buyer sends a message from the order');
  const { ctx: sc, page: sp } = await mk(1280); await sp.goto(`${BASE}/studio/login`); await sp.fill('#sl-email', `maker${stamp}@t.test`); await sp.fill('#sl-pw', PW); await sp.getByRole('button', { name: 'Sign in' }).click(); await sp.waitForSelector('.sd-side');
  ok((await sp.locator('.sd-tasks .n').nth(1).innerText()) === '1', 'the studio home counts one message to answer'); await sp.locator('.sd-side a', { hasText: 'Messages' }).click(); await sp.waitForSelector('.table .tr'); ok(/reply/i.test(await sp.locator('.table .tr').first().innerText()), 'the inbox marks it as waiting for a reply');
  const body = await sp.locator('body').innerText(); ok(!body.includes('bea'), 'the maker does not see the buyer\'s email'); await sp.locator('.table .tr').first().click(); await sp.waitForSelector('text=Could the candle be gift wrapped'); await sp.fill('#chat-in', 'Yes, just ask at checkout with the gift note!'); await sp.getByRole('button', { name: 'Send' }).click(); await sp.waitForSelector('text=Yes, just ask at checkout'); ok(true, 'the maker replies');
  await page.reload(); await page.getByRole('button', { name: `Message ${shopName}` }).click(); await page.waitForSelector('text=Yes, just ask at checkout'); ok(true, 'the buyer sees the reply on the order page');
  // reply to the review, in public
  await sp.locator('.sd-side a', { hasText: 'Reviews' }).click(); await sp.waitForSelector('text=Beautiful scent'); await sp.getByRole('button', { name: 'Reply', exact: true }).click(); await sp.fill('#rv-text', 'Thank you Bea, so glad you love it!'); await sp.getByRole('button', { name: 'Post reply' }).click(); await sp.waitForSelector('text=Your reply'); ok(true, 'the maker replies to the review');
  await page.goto(`${BASE}/p/${prod.id}`); await page.waitForSelector('text=Reply from the maker'); ok(true, 'the reply shows publicly under the review');
  await sc.close(); await ctx.close();
}
// ---- 3. a signed-in buyer asks a question on the product page and carries on in their messages
{
  const { ctx, page } = await mk(); await page.goto(`${BASE}/p/${prod.id}`); await page.getByRole('button', { name: 'Sign in to ask the maker a question' }).click(); await page.waitForURL(/\/account/);
  await page.getByRole('button', { name: 'Create an account' }).click(); await page.fill('#ac-name', 'Quinn Questioner'); await page.fill('#ac-email', `quinn${stamp}@t.test`); await page.fill('#ac-pw', PW); await page.getByRole('button', { name: 'Create account' }).click(); await page.waitForURL(/\/p\//);
  await page.getByRole('button', { name: 'Ask the maker a question' }).click(); await page.fill('#chat-in', 'Is the wax soy?'); await page.getByRole('button', { name: 'Send' }).click(); await page.waitForSelector('text=Sent. Replies arrive'); ok(true, 'a signed-in buyer asks a question from the product page');
  const { ctx: sc, page: sp } = await mk(1280); await sp.goto(`${BASE}/studio/login`); await sp.fill('#sl-email', `maker${stamp}@t.test`); await sp.fill('#sl-pw', PW); await sp.getByRole('button', { name: 'Sign in' }).click(); await sp.waitForSelector('.sd-side'); await sp.goto(`${BASE}/studio/messages`); await sp.locator('.table .tr', { hasText: 'Quinn' }).click(); await sp.fill('#chat-in', 'Yes, 100% soy wax.'); await sp.getByRole('button', { name: 'Send' }).click(); await sp.waitForSelector('text=Yes, 100% soy'); await sc.close();
  await page.goto(`${BASE}/account/messages`); await page.waitForSelector('.thread-row'); ok((await page.locator('.dot').count()) === 1, 'the buyer\'s message list shows the new reply as unread'); await page.locator('.thread-row').first().click(); await page.waitForSelector('text=Yes, 100% soy wax.');
  await page.fill('#chat-in', 'Great, thank you!'); await page.getByRole('button', { name: 'Send' }).click(); await page.waitForSelector('text=Great, thank you!'); await page.goto(`${BASE}/account/messages`); await page.waitForSelector('.thread-row'); ok((await page.locator('.dot').count()) === 0, 'opening it marks it read');
  await page.goto(`${BASE}/shop/${shop.slug}`); await page.getByRole('button', { name: 'Follow' }).click(); await page.waitForSelector('text=Following'); await page.goto(`${BASE}/saved`); await page.waitForSelector('text=Shops you follow'); ok((await page.locator('body').innerText()).includes('Ember soy candle'), 'the Saved page shows the shops you follow and their newest pieces');
  await ctx.close();
}
// ---- 4. report, moderate, and what staff and support can see
{
  const r2 = await o2.ctx.request.post(`${BASE}/api/orders/by-token/${o2.token}/reviews`, { data: { productId: prod.id, rating: 1, title: 'Never arrived', body: 'I never received this and nobody answered.' }, headers: H }); ok(r2.status() === 201, 'a second buyer posts a 1-star review');
  const before = (await (await seller.ctx.request.get(`${BASE}/api/shops/${shop.slug}`)).json()).rating; ok(before.count === 2 && before.avg === 3, 'the shop rating blends both reviews');
  const { ctx: sc, page: sp } = await mk(1280); await sp.goto(`${BASE}/studio/login`); await sp.fill('#sl-email', `maker${stamp}@t.test`); await sp.fill('#sl-pw', PW); await sp.getByRole('button', { name: 'Sign in' }).click(); await sp.waitForSelector('.sd-side'); await sp.goto(`${BASE}/studio/reviews`); await sp.waitForSelector('text=Never arrived');
  await sp.locator('.tr', { hasText: 'Never arrived' }).getByRole('button', { name: 'Report' }).click(); ok(await sp.getByRole('button', { name: 'Send report' }).isDisabled(), 'a report needs a reason'); await sp.fill('#rv-text', 'Tracking shows it was delivered and signed for on the 3rd'); await sp.getByRole('button', { name: 'Send report' }).click(); await sp.waitForSelector('text=Reported'); ok(true, 'the maker reports the review');
  await sc.close();
  const { ctx: ac, page: ap } = await mk(1280); await ap.goto(`${BASE}/admin/login`); await ap.fill('#cl-email', 'admin@eazystores.test'); await ap.fill('#cl-pw', 'demo-password-2026'); await ap.getByRole('button', { name: 'Sign in' }).click(); await ap.waitForSelector('.sd-side'); await ap.goto(`${BASE}/admin/moderation`); await ap.waitForSelector('text=Reported reviews'); await ap.waitForSelector('text=Never arrived');
  await ap.getByRole('button', { name: 'Decide…' }).first().click(); ok(await ap.getByRole('button', { name: 'Hide the review' }).isDisabled(), 'a decision needs a reason'); await ap.fill('input[aria-label="Reason for the decision"]', 'Delivery was confirmed by tracking'); await ap.getByRole('button', { name: 'Hide the review' }).click(); await ap.waitForFunction(() => !document.body.textContent.includes('Seller says'));
  const after = (await (await seller.ctx.request.get(`${BASE}/api/shops/${shop.slug}`)).json()).rating; ok(after.count === 1 && after.avg === 5, 'hiding the review takes it out of the shop rating'); ok((await (await ac.request.get(`${BASE}/api/products/${prod.id}/reviews`)).json()).count === 1, 'and out of the public list'); await ac.close();
  const { ctx: pc, page: pp } = await mk(1280); await pp.goto(`${BASE}/support/login`); await pp.fill('#cl-email', 'support@eazystores.test'); await pp.fill('#cl-pw', 'demo-password-2026'); await pp.getByRole('button', { name: 'Sign in' }).click(); await pp.waitForSelector('.sd-side'); await pp.fill('input[aria-label="Order number, name or email"]', String(o1.number)); await pp.waitForFunction(() => document.querySelectorAll('.table .tr').length === 1); await pp.locator('.table .tr').first().click(); await pp.waitForSelector(`text=Messages with ${shopName}`);
  const t = await pp.locator('body').innerText(); ok(t.includes('gift wrapped') && t.includes('Read only'), 'support can read the order conversation (read only) to settle a dispute'); await pc.close();
}
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll engagement flow checks passed.'); process.exit(fails.length ? 1 : 0);
