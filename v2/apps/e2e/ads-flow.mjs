// End-to-end ads in a real browser: two sellers compete for a category page, shoppers see marked sponsored pieces, a click is charged once, staff can stop a campaign.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/ads-flow.mjs   (stack on :5180 with AUTH_RATE_LIMIT_MAX raised, demo data)
import { chromium } from 'playwright'; import sharp from 'sharp';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const H = { origin: BASE }; const PW = 'correct-horse-battery-staple';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fails = []; const log = []; const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const stamp = Date.now(); const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#c9a66b' } }).png().toBuffer();
const mk = async (w = 1280) => { const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'en-CA' }); const page = await ctx.newPage(); page.on('pageerror', e => fails.push(`page error: ${e.message}`)); return { ctx, page }; };
const post = async (ctx, url, data, headers = {}) => { const r = await ctx.request.post(`${BASE}${url}`, { data, headers: { ...H, ...headers } }); if (!r.ok()) throw new Error(`${url} ${r.status()} ${await r.text()}`); return r.json().catch(() => ({})); };

async function seller(tag, title) {
  const s = await mk(); await post(s.ctx, '/api/studio/signup', { email: `${tag}${stamp}@t.test`, password: PW, fullName: `${tag} Maker`, categories: ['candles-home-fragrance'], shopName: `${tag} Candles ${stamp % 1000}` });
  const med = await (await s.ctx.request.post(`${BASE}/api/studio/media`, { data: png, headers: { ...H, 'content-type': 'image/png' } })).json();
  const p = await post(s.ctx, '/api/studio/products', { title, categorySlug: 'candles-home-fragrance', priceCents: 3200, stock: 30, attributes: {}, mediaIds: [med.id] }); await post(s.ctx, `/api/studio/products/${p.id}/publish`, { acknowledged: true });
  const b = await browser.newContext({ locale: 'en-CA' }); const d = await (await b.request.get(`${BASE}/api/products/${p.id}`)).json(); await post(b, '/api/cart/items', { variantId: d.variants[0].id, quantity: 1 });
  const co = await post(b, '/api/checkout', { email: `${tag}buyer${stamp}@t.test`, address: { name: 'Bea', line1: '1 St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } }); await post(b, `/api/dev/payments/${co.payment.ref}/simulate`, { outcome: 'succeeded' }); await b.close();       // some earnings to pay for clicks with
  return { ...s, email: `${tag}${stamp}@t.test`, productId: p.id, title };
}
const A = await seller('Alder', `Alder cedar candle ${stamp}`); const B = await seller('Birch', `Birch cedar candle ${stamp}`);
const studio = async (s) => { await s.page.goto(`${BASE}/studio`); await s.page.waitForSelector('.sd-side'); };          // sign-up already opened their studio session

// ---- 1. seller A builds a campaign in the studio
await studio(A); await A.page.locator('.sd-side a', { hasText: 'Ads' }).click(); await A.page.waitForSelector('text=No campaigns yet'); ok(true, 'the Ads page starts empty with an explanation of how it is paid');
await A.page.getByRole('link', { name: 'New campaign' }).click(); await A.page.waitForSelector('#ad-name'); ok(await A.page.getByRole('button', { name: 'Start campaign' }).isDisabled(), 'a campaign needs a name and a piece');
await A.page.fill('#ad-name', 'Autumn push'); await A.page.fill('#ad-bid', '0.05'); await A.page.getByLabel(A.title).check(); await A.page.getByLabel('Candles & home fragrance').check(); await A.page.getByRole('button', { name: 'Start campaign' }).click(); await A.page.waitForSelector('[role=alert]'); ok(/minimum/i.test(await A.page.locator('[role=alert]').innerText()), 'a bid below the minimum is refused with a plain message');
await A.page.fill('#ad-bid', '0.90'); await A.page.fill('#ad-daily', '3.00'); await A.page.getByRole('button', { name: 'Start campaign' }).click(); await A.page.waitForSelector('text=Running'); ok(true, 'the campaign starts');
const idA = A.page.url().split('/ads/')[1];
await post(B.ctx, '/api/studio/ads', { name: 'Birch push', productIds: [B.productId], bidCents: 60, dailyBudgetCents: 500, totalBudgetCents: null, categories: ['candles-home-fragrance'], keywords: [] });

// ---- 2. shoppers see marked sponsored pieces; the higher bid comes first
const shopper = await mk(); const sp = shopper.page; await sp.goto(`${BASE}/c/candles-home-fragrance`); await sp.waitForSelector('.pcard');
const tags = await sp.locator('.pcard', { has: sp.locator('.chip.tag', { hasText: 'Sponsored' }) }).locator('h4').allInnerTexts(); ok(tags.length === 2, 'two sponsored pieces are marked "Sponsored" in the category'); ok(tags[0] === A.title && tags[1] === B.title, 'the higher bid is shown first');
const order = await sp.locator('.grid4 .pcard h4').allInnerTexts(); ok(order.indexOf(A.title) === 2, 'sponsored pieces sit in a fixed slot, the organic order is otherwise untouched');
await sp.goto(`${BASE}/search?q=cedar`); await sp.waitForSelector('.pcard'); ok((await sp.locator('.chip.tag', { hasText: 'Sponsored' }).count()) >= 1, 'search shows sponsored pieces for matching words');
await sp.goto(`${BASE}/c/candles-home-fragrance`); await sp.waitForSelector('.pcard'); await sp.locator('.pcard', { hasText: A.title }).first().click(); await sp.waitForSelector('.pdp-desktop'); ok(!sp.url().includes('ad='), 'the tracking token is removed from the address after the click');
await sp.waitForTimeout(600);

// ---- 3. the click was charged once; a repeat from the same place is free
await A.page.goto(`${BASE}/studio/ads/${idA}`); await A.page.waitForSelector('text=Click rate'); const stats = async () => ({ clicks: await A.page.locator('.stat .n').nth(1).innerText(), spent: await A.page.locator('.stat .n').nth(3).innerText() });
const s1 = await stats(); ok(s1.clicks === '1' && s1.spent !== '$0.00', `the click shows in the seller's numbers and was charged (${s1.spent})`);
await sp.goto(`${BASE}/c/candles-home-fragrance`); await sp.waitForSelector('.pcard'); await sp.locator('.pcard', { hasText: A.title }).first().click(); await sp.waitForSelector('.pdp-desktop'); await sp.waitForTimeout(600); await A.page.reload(); await A.page.waitForSelector('text=Click rate'); const s2 = await stats(); ok(s2.clicks === '1' && s2.spent === s1.spent, 'a repeat click from the same place is filtered out: not counted and not charged');
const fin = await mk(); await fin.page.goto(`${BASE}/finance/login`); await fin.page.fill('#cl-email', 'finance@eazystores.test'); await fin.page.fill('#cl-pw', 'demo-password-2026'); await fin.page.getByRole('button', { name: 'Sign in' }).click(); await fin.page.waitForSelector('text=Ad revenue'); const adRev = await fin.page.locator('.card', { hasText: 'Ad revenue' }).first().innerText(); ok(!adRev.includes('$0.00'), 'finance shows the ad revenue from the ledger');

// ---- 4. pause, and staff stop
await A.page.getByRole('button', { name: 'Pause' }).click(); await A.page.waitForSelector('text=Paused'); await sp.goto(`${BASE}/c/candles-home-fragrance`); await sp.waitForSelector('.pcard'); ok(!(await sp.locator('.chip.tag', { hasText: 'Sponsored' }).allInnerTexts()).length || (await sp.locator('.pcard', { has: sp.locator('.chip.tag', { hasText: 'Sponsored' }) }).locator('h4').allInnerTexts()).every(t => t !== A.title), 'a paused campaign stops showing');
await A.page.getByRole('button', { name: 'Resume' }).click(); await A.page.waitForSelector('text=Running');
const mkt = await mk(); await mkt.page.goto(`${BASE}/marketing/login`); await mkt.page.fill('#cl-email', 'marketing@eazystores.test'); await mkt.page.fill('#cl-pw', 'demo-password-2026'); await mkt.page.getByRole('button', { name: 'Sign in' }).click(); await mkt.page.waitForSelector('.sd-side'); await mkt.page.locator('.sd-nav', { hasText: 'Ads' }).click(); await mkt.page.waitForSelector('text=Autumn push');
await mkt.page.locator('.tr', { hasText: 'Autumn push' }).getByRole('button', { name: 'Stop…' }).click(); ok(await mkt.page.getByRole('button', { name: 'Stop campaign' }).isDisabled(), 'stopping needs a reason'); await mkt.page.fill('input[aria-label="Reason"]', 'Product photos are not of the product'); await mkt.page.getByRole('button', { name: 'Stop campaign' }).click(); await mkt.page.waitForSelector('text=Stopped by staff');
await A.page.reload(); await A.page.waitForSelector('text=Staff stopped this campaign'); ok((await A.page.locator('body').innerText()).includes('Product photos are not of the product'), 'the seller sees why it was stopped'); ok(await A.page.getByRole('button', { name: 'Resume' }).count() === 0, 'and cannot restart it');
await sp.goto(`${BASE}/c/candles-home-fragrance`); await sp.waitForSelector('.pcard'); const after = await sp.locator('.pcard', { has: sp.locator('.chip.tag', { hasText: 'Sponsored' }) }).locator('h4').allInnerTexts(); ok(!after.includes(A.title) && after.includes(B.title), 'a stopped campaign leaves the page and the next bidder remains');
await mkt.page.locator('.tr', { hasText: 'Autumn push' }).getByRole('button', { name: 'Release…' }).click(); await mkt.page.fill('input[aria-label="Reason"]', 'Photos replaced'); await mkt.page.getByRole('button', { name: 'Release campaign' }).click(); await mkt.page.waitForFunction(() => !document.body.textContent.includes('Stopped: '));
await A.page.reload(); await A.page.waitForSelector('text=Paused'); await A.page.getByRole('button', { name: 'Resume' }).click(); await A.page.waitForSelector('text=Running'); ok(true, 'released campaigns can be resumed by the seller');
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll ads flow checks passed.'); process.exit(fails.length ? 1 : 0);
