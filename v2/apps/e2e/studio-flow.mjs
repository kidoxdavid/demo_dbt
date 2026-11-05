// End-to-end seller flow in a real browser: open a shop, publish a first product with a real photo, get an order, ship it, refund part of it, edit products, shipping and shop settings.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/studio-flow.mjs   (web on :5180 proxying the API, test payment provider)
import { chromium } from 'playwright'; import sharp from 'sharp';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fails = []; const log = []; const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const stamp = Date.now(); const email = `seller${stamp}@t.test`; const shopName = `Wick & Wax ${stamp % 10000}`;
const photo = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#c8a05a' } }).png().toBuffer();
const ctx = await browser.newContext({ viewport: { width: 390, height: 798 }, locale: 'en-CA' }); const page = await ctx.newPage(); page.on('pageerror', e => fails.push(`page error: ${e.message}`));
const text = async sel => (await page.locator(sel).first().innerText());

// ---- 1. Onboarding
await page.goto(BASE + '/studio'); await page.waitForURL(/\/studio\/login/); ok(true, 'signed-out visitors are sent to the studio sign-in');
await page.goto(BASE + '/studio/start/2'); await page.waitForURL(/\/studio\/start\/1/); ok(true, 'later onboarding steps need an account first');
const t0 = Date.now();   // timing starts when a new maker lands on step 1
await page.waitForSelector('.tile-sel'); ok((await page.locator('.tile-sel').count()) === 10, 'step 1 shows ten category tiles');
ok(await page.getByRole('button', { name: 'Continue' }).isDisabled(), 'Continue waits for a choice');
await page.getByRole('button', { name: 'Candles', exact: true }).click(); await page.getByRole('button', { name: 'Jewellery', exact: true }).click(); await page.getByRole('button', { name: 'Continue' }).click();
await page.fill('#sa-name', 'Wendy Wick'); await page.fill('#sa-shop', shopName); await page.fill('#sa-email', email); await page.fill('#sa-pw', 'short'); await page.getByRole('button', { name: 'Create account' }).click(); await page.waitForSelector('[role=alert]'); ok(/password/i.test(await text('[role=alert]')), 'a weak password is refused with a plain message');
await page.fill('#sa-pw', 'correct-horse-battery-staple'); await page.getByRole('button', { name: 'Create account' }).click(); await page.waitForURL(/\/studio\/start\/2/); await page.waitForSelector('.previewcard'); ok(true, 'account created, on to shop identity');
ok((await page.inputValue('#ob-name')) === shopName, 'shop name pre-filled');
await page.fill('#ob-tag', 'Hand-poured soy candles'); await page.getByRole('radio', { name: 'Noir' }).click(); await page.getByRole('button', { name: 'Continue' }).click(); await page.waitForURL(/\/studio\/start\/3/);
await page.waitForSelector('#p-title'); await page.fill('#p-title', 'Cedar soy candle in a jar'); await page.fill('#p-price', '24'); await page.fill('#p-qty', '10');
await page.waitForSelector('text=suggested'); ok((await text('.chips-row .chip')).toLowerCase().includes('candles'), 'category is suggested from the title');
ok(await page.getByRole('button', { name: 'Publish product' }).isDisabled(), 'publishing waits until the product is ready (needs a photo)');
await page.setInputFiles('input[aria-label="Add a cover photo"]', { name: 'candle.png', mimeType: 'image/png', buffer: photo }); await page.waitForSelector('.photos .cover img');
await page.waitForFunction(() => document.querySelector('.saved')?.textContent?.includes('saved')); ok(true, 'photo uploads and the draft saves itself');
await page.waitForFunction(() => !document.querySelector('.problems')); ok(true, 'the readiness list clears once nothing is missing');
await page.getByRole('button', { name: 'Publish product' }).click(); await page.waitForURL(/\/studio\/start\/4/); ok(true, 'product published, shop goes live');
await page.fill('#sh-rate', '7.50'); await page.fill('#sh-free', '60'); await page.getByRole('button', { name: 'Continue' }).click(); await page.waitForURL(/\/studio\/start\/5/); await page.waitForSelector('.qr svg');
ok((await text('.livecard .u')).includes('/shop/'), 'step 5 shows the shop link and a QR code'); const secs = (Date.now() - t0) / 1000; console.log(`TIMING sign-up to live listing on a phone, scripted: ${secs.toFixed(1)} s`); ok(secs < 600, 'a new maker reaches a live listing in under 10 minutes (scripted run, a lower bound for a person)'); const slug = (await text('.livecard .u')).split('/shop/')[1];
const pub = await (await ctx.request.get(`${BASE}/api/shops/${slug}`)).json(); ok(pub.name === shopName && pub.look === 'noir' && pub.tagline === 'Hand-poured soy candles', 'the public shop page shows what was entered');
await page.getByRole('link', { name: 'Go to my studio' }).click(); await page.waitForURL(/\/studio$/); await page.waitForSelector('.sp-cards'); ok(true, 'studio home opens on a phone'); ok((await page.locator('.tabbar').count()) === 1, 'phone studio has its tab bar');
const done = await page.evaluate(() => document.body.textContent); ok(done.includes('3 of 5 done') || done.includes('Next: set up payouts'), 'checklist counts what is done');

// ---- 2. A buyer buys; the seller handles the order
const buyer = await browser.newContext({ locale: 'en-CA' }); const prod = (await (await buyer.request.get(`${BASE}/api/products?shop=${slug}`)).json()).items[0]; const detail = await (await buyer.request.get(`${BASE}/api/products/${prod.id}`)).json();
const H = { origin: BASE }; await buyer.request.post(`${BASE}/api/cart/items`, { data: { variantId: detail.variants[0].id, quantity: 3 }, headers: H });
const co = await (await buyer.request.post(`${BASE}/api/checkout`, { data: { email: 'bea@t.test', address: { name: 'Bea Buyer', line1: '1 Main St', city: 'Calgary', region: 'AB', postal: 'T2N 1N4' } }, headers: H })).json();
await buyer.request.post(`${BASE}/api/dev/payments/${co.payment.ref}/simulate`, { data: { outcome: 'succeeded' }, headers: H });
await ctx.close(); const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-CA' }); const d = await desk.newPage(); d.on('pageerror', e => fails.push(`page error: ${e.message}`));
await d.goto(BASE + '/studio/login'); await d.fill('#sl-email', email); await d.fill('#sl-pw', 'wrong-password-here'); await d.getByRole('button', { name: 'Sign in' }).click(); await d.waitForSelector('[role=alert]'); ok(true, 'a wrong password is refused');
await d.fill('#sl-pw', 'correct-horse-battery-staple'); await d.getByRole('button', { name: 'Sign in' }).click(); await d.waitForSelector('.sd-side'); ok(true, 'studio sign-in works and shows the desktop sidebar');
ok((await d.locator('.sd-nav', { hasText: 'Orders' }).locator('.sd-badge').innerText()) === '1', 'the Orders badge shows one order to ship'); await d.waitForSelector('.sd-recent .orderrow'); ok((await d.locator('.sd-tasks .n').first().innerText()) === '1', 'home says one order to ship');
await d.locator('.sd-side a', { hasText: 'Orders' }).click(); await d.waitForSelector('.table .tr'); await d.locator('.table .tr').first().click(); await d.waitForSelector('text=Ship to');
ok((await d.locator('body').innerText()).includes('Bea Buyer') && !(await d.locator('body').innerText()).includes('bea@t.test'), 'the seller sees who to ship to but not the buyer\'s email');
await d.getByRole('button', { name: 'Mark as shipped' }).click(); await d.fill('#o-trk', '!!'); ok(await d.getByRole('button', { name: /Save and email/ }).isDisabled(), 'a too-short tracking number cannot be saved');
await d.fill('#o-trk', 'AB123456789CA'); await d.getByRole('button', { name: /Save and email/ }).click(); await d.waitForSelector('text=Tracking'); ok(true, 'shipping with tracking works');
await d.getByRole('button', { name: 'Refund', exact: true }).click(); await d.selectOption('select[aria-label^="Refund quantity"]', '1'); await d.fill('#o-rr', 'Jar arrived chipped'); await d.getByRole('button', { name: 'Refund', exact: true }).last().click(); await d.waitForSelector('text=Refunded to buyer'); ok(true, 'a partial refund works and shows on the order');
const bo = await (await buyer.request.get(`${BASE}/api/orders/by-token/${co.token}`)).json(); const so = bo.sellers[0]; ok(so.refundedCents > 0 && so.refundedCents < so.totalCents && bo.paymentStatus === 'partially_refunded', 'the buyer sees the partial refund');
await d.getByRole('button', { name: 'Mark as delivered' }).click(); await d.waitForSelector('text=Delivered'); ok(true, 'delivered');

// ---- 3. Products, shipping, shop settings
await d.locator('.sd-side a', { hasText: 'Products' }).click(); await d.waitForSelector('.table .tr'); await d.locator('.table .tr').first().click(); await d.waitForSelector('#e-title');
await d.fill('#e-price', '26'); await d.fill('#e-stock', '8'); await d.getByRole('button', { name: 'Save', exact: true }).click(); await d.waitForSelector('text=Saved.'); ok(true, 'product price and stock save');
await d.getByRole('button', { name: 'Add an option' }).click(); await d.fill('input[aria-label="Option 1 name"]', 'Size'); await d.fill('input[aria-label="Option 1 values"]', 'Small, Large'); await d.getByRole('button', { name: 'Save options' }).click(); await d.waitForSelector('.vtable');
ok((await d.locator('.vtable tbody tr').count()) === 2, 'options make one row per size, each with its own price and stock');
await d.fill('input[aria-label="Price for Large"]', '34'); await d.fill('input[aria-label="Quantity for Large"]', '5'); await d.locator('.vtable tbody tr', { hasText: 'Large' }).getByRole('button', { name: 'Save' }).click(); await d.waitForSelector('text=Saved.');
await d.fill('input[aria-label="Price for Small"]', '26'); await d.fill('input[aria-label="Quantity for Small"]', '5'); await d.locator('.vtable tbody tr', { hasText: 'Small' }).getByRole('button', { name: 'Save' }).click(); await d.waitForSelector('text=Saved.');
const live = await (await buyer.request.get(`${BASE}/api/products/${prod.id}`)).json(); ok(live.variants.length === 2 && live.variants.some(v => v.priceCents === 3400), 'the shop shows the new options and prices');
await d.getByRole('button', { name: 'Hide from shop' }).click(); await d.waitForSelector('text=Hidden from the shop.'); ok((await buyer.request.get(`${BASE}/api/products/${prod.id}`)).status() === 404, 'a hidden product disappears from the shop');
await d.getByRole('button', { name: 'Publish', exact: true }).click(); await d.waitForSelector('text=Your product is live.'); ok((await buyer.request.get(`${BASE}/api/products/${prod.id}`)).status() === 200, 'publishing puts it back');
await d.locator('.sd-side a', { hasText: 'Shop page' }).click(); await d.waitForSelector('#s-tag'); await d.fill('#s-tag', 'Soy candles, poured by hand'); await d.getByLabel(/Vacation mode/).check(); await d.getByRole('button', { name: 'Save changes' }).click(); await d.waitForSelector('text=Saved.');
const vac = await (await buyer.request.get(`${BASE}/api/shops/${slug}`)).json(); ok(vac.vacation === true && vac.tagline === 'Soy candles, poured by hand', 'shop settings and vacation mode reach the public page');
const addVac = await buyer.request.post(`${BASE}/api/cart/items`, { data: { variantId: live.variants[0].id, quantity: 1 }, headers: H }); ok(addVac.status() === 409, 'buyers cannot buy from a shop on vacation');
await d.getByLabel(/Vacation mode/).uncheck(); await d.getByRole('button', { name: 'Save changes' }).click(); await d.waitForSelector('text=Saved.');
await d.goto(BASE + '/studio/shipping'); await d.getByRole('button', { name: 'Add a profile' }).click(); await d.fill('#sp-n', 'Bulky items'); await d.selectOption('#sp-t', 'per_item'); await d.fill('#sp-e', '2.50'); await d.getByRole('button', { name: 'Save profile' }).click(); await d.waitForSelector('text=Bulky items'); ok(true, 'a second shipping profile can be added');
await d.goto(BASE + '/studio/payouts'); await d.waitForSelector('text=Not available yet'); ok((await d.locator('body').innerText()).includes('not connected yet'), 'payouts honestly say they are not connected');
await d.goto(BASE + '/studio/orders/00000000-0000-4000-8000-000000000000'); await d.waitForSelector('text=We could not find that order'); ok(true, 'an unknown order shows a friendly page');
await d.locator('.sd-side a', { hasText: 'Home' }).click(); await d.waitForSelector('.sd-recent'); const week = await d.locator('.stat .n').first().innerText(); ok(week.startsWith('$') && week !== '$0', 'the week\'s sales show on the home page');
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll studio flow checks passed.'); process.exit(fails.length ? 1 : 0);
