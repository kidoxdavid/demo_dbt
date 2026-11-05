// End-to-end staff flows in a real browser: admin, support, finance and marketing, each in its own sign-in window, against the demo data.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/console-flow.mjs   (web on :5180 proxying the API; demo seed with orders)
import { chromium } from 'playwright'; import sharp from 'sharp';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const PW = 'demo-password-2026';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fails = []; const log = []; const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const stamp = Date.now(); const H = { origin: BASE };
const win = async (w = 1280) => { const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'en-CA' }); const page = await ctx.newPage(); page.on('pageerror', e => fails.push(`page error: ${e.message}`)); return { ctx, page }; };
async function signIn(page, area, email, pw = PW) { await page.goto(`${BASE}/${area}/login`); await page.fill('#cl-email', email); await page.fill('#cl-pw', pw); await page.getByRole('button', { name: 'Sign in' }).click(); }
const body = async page => page.locator('body').innerText();

// ---------------------------------------------------------------- windows are separate
{
  const { ctx, page } = await win();
  await page.goto(`${BASE}/admin`); await page.waitForURL(/\/admin\/login/); ok(true, 'signed-out visitors are sent to the admin sign-in');
  await signIn(page, 'admin', 'support@eazystores.test'); await page.waitForSelector('[role=alert]'); ok(/access/i.test(await page.locator('[role=alert]').innerText()), 'a support login is refused in the admin window');
  await signIn(page, 'support', 'support@eazystores.test', 'wrong-password-here'); await page.waitForSelector('[role=alert]'); ok(/do not match/.test(await page.locator('[role=alert]').innerText()), 'a wrong password is refused');
  await signIn(page, 'support', 'support@eazystores.test'); await page.waitForSelector('.sd-side'); ok(true, 'support signs in to the support window');
  await page.goto(`${BASE}/finance`); await page.waitForURL(/\/finance\/login/); ok(true, 'being signed in to support does not sign you in to finance');

  // ---------------------------------------------------------------- support
  await page.goto(`${BASE}/support`); await page.waitForSelector('.table .tr'); await page.fill('input[aria-label="Order number, name or email"]', '10001'); await page.waitForFunction(() => document.querySelectorAll('.table .tr').length === 1);
  await page.locator('.table .tr').first().click(); await page.waitForSelector('text=maya@demo.test'); const t = await body(page); ok(t.includes('Maya R.') && t.includes('maya@demo.test'), 'support sees the buyer, name and email, which sellers never do');
  await page.fill('#note-body', 'Buyer asked for a gift receipt'); await page.getByRole('button', { name: 'Save note' }).click(); await page.waitForSelector('text=Buyer asked for a gift receipt'); ok(true, 'an internal note saves');
  await page.getByRole('button', { name: 'Resend the confirmation' }).click(); await page.waitForSelector('text=Confirmation email queued.'); ok(true, 'the confirmation can be resent');
  ok((await page.getByRole('button', { name: 'Refund…' }).count()) === 0, 'support has no refund button');
  await page.goto(`${BASE}/support/users`); await page.fill('input[aria-label="Name or email"]', 'amara'); await page.waitForSelector('.table .tr'); await page.locator('.table .tr').first().click(); await page.waitForSelector('text=Internal notes'); ok(true, 'people lookup opens a person with notes');
  await page.goto(`${BASE}/support/audit`); await page.waitForSelector('.table .tr'); ok((await body(page)).includes('note.add'), 'the audit log shows the note');
  await ctx.close();
}

// ---------------------------------------------------------------- admin
const buyer = await browser.newContext({ locale: 'en-CA' }); const bemail = `buyer${stamp}@t.test`;
await buyer.request.post(`${BASE}/api/auth/signup`, { data: { email: bemail, password: 'correct-horse-battery-staple', fullName: 'Rae Shopper' }, headers: H });
{
  const { ctx, page } = await win(); await signIn(page, 'admin', 'admin@eazystores.test'); await page.waitForSelector('text=Active sellers'); ok(true, 'admin overview shows the marketplace counts');
  await page.locator('.sd-nav', { hasText: 'People' }).click(); await page.fill('input[aria-label="Search by name or email"]', bemail); await page.waitForFunction(() => document.querySelectorAll('.table .tr').length === 1); await page.locator('.table .tr').first().click(); await page.waitForSelector('text=Disable this account');
  ok(await page.getByRole('button', { name: 'Disable' }).isDisabled(), 'disabling needs a reason'); await page.fill('#du-why', 'Repeated chargebacks'); await page.getByRole('button', { name: 'Disable' }).click(); await page.waitForSelector('text=Re-enable this account');
  const r = await buyer.request.post(`${BASE}/api/auth/login`, { data: { email: bemail, password: 'correct-horse-battery-staple' }, headers: { ...H, 'x-area': 'shop' } }); ok(r.status() === 401, 'a disabled person can no longer sign in');
  await page.fill('#du-why', 'Appeal accepted'); await page.getByRole('button', { name: 'Re-enable' }).click(); await page.waitForSelector('text=Disable this account'); ok(true, 're-enabled');

  await page.goto(`${BASE}/admin/sellers`); await page.fill('input[aria-label="Search by business, shop or owner email"]', 'clay'); await page.waitForSelector('.table .tr'); await page.locator('.table .tr', { hasText: 'Clay & Ember' }).first().click(); await page.waitForSelector('text=Standing');
  await page.selectOption('#sl-st', 'suspended'); await page.fill('#sl-why', 'Under review for a buyer complaint'); await page.getByRole('button', { name: 'Save changes' }).click(); await page.waitForSelector('text=Saved.');
  const gone = await buyer.request.get(`${BASE}/api/shops/clay-ember`); ok(gone.status() === 404, 'a suspended seller\'s shop disappears from the storefront');
  await page.selectOption('#sl-st', 'active'); await page.fill('#sl-why', 'Complaint resolved'); await page.getByRole('button', { name: 'Save changes' }).click(); await page.waitForFunction(() => document.querySelector('.saved') && document.body.textContent.includes('Complaint resolved')); ok((await buyer.request.get(`${BASE}/api/shops/clay-ember`)).status() === 200, 'reactivating brings the shop back');
  ok((await body(page)).includes('seller.suspend'), 'the history shows the suspension and its reason');

  // review queue: a restricted product from a new seller
  const s = await ctx.request.post(`${BASE}/api/studio/signup`, { data: { email: `toys${stamp}@t.test`, password: 'correct-horse-battery-staple', fullName: 'Tom Toymaker', categories: ['toys-games'], shopName: `Toy Shop ${stamp % 1000}` }, headers: H });
  const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#3a6ea5' } }).png().toBuffer(); const med = await (await ctx.request.post(`${BASE}/api/studio/media`, { data: png, headers: { ...H, 'content-type': 'image/png' } })).json();
  const mk = async title => { const p = await (await ctx.request.post(`${BASE}/api/studio/products`, { data: { title, categorySlug: 'toys-games', priceCents: 1800, stock: 4, attributes: { age_range: '6-8' }, mediaIds: [med.id] }, headers: H })).json(); const pub = await ctx.request.post(`${BASE}/api/studio/products/${p.id}/publish`, { data: { acknowledged: true }, headers: H }); if (!pub.ok()) throw new Error(await pub.text()); return p.id; };
  const keep = await mk('Wooden train set'); const drop = await mk('Magnet building set'); void s;
  await page.locator('.sd-nav', { hasText: 'Review queue' }).click(); await page.waitForSelector('text=Wooden train set'); ok(true, 'restricted-category products appear in the review queue');
  await page.locator('.tr', { hasText: 'Wooden train set' }).getByRole('button', { name: 'Approve' }).click(); await page.waitForFunction(() => !document.body.textContent.includes('Wooden train set')); ok((await buyer.request.get(`${BASE}/api/products/${keep}`)).status() === 200, 'approving keeps the product live');
  await page.locator('.tr', { hasText: 'Magnet building set' }).getByRole('button', { name: 'Remove…' }).click(); ok(await page.getByRole('button', { name: 'Remove product' }).isDisabled(), 'removing needs a reason'); await page.fill('input[aria-label="Reason for removing"]', 'Small magnets, no safety information'); await page.getByRole('button', { name: 'Remove product' }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('Magnet building set')); ok((await buyer.request.get(`${BASE}/api/products/${drop}`)).status() === 404, 'removing hides the product from the shop');

  // settings: shorten the payout hold so finance can pay out (restored at the end)
  await page.locator('.sd-nav', { hasText: 'Settings' }).click(); await page.waitForSelector('text=payout_hold_days'); await page.locator('.tr', { hasText: 'payout_hold_days' }).getByRole('button', { name: 'Change' }).click(); await page.fill('#st-val', '"soon"'); await page.fill('#st-why', 'test'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.waitForSelector('[role=alert]'); ok(true, 'an invalid setting value is refused');
  await page.fill('#st-val', '0'); await page.fill('#st-why', 'Pay out sooner while we test'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('#st-val')); ok(true, 'a valid setting saves');
  await page.locator('.sd-nav', { hasText: 'Audit log' }).click(); await page.fill('input[aria-label="Filter by action"]', 'setting.update'); await page.waitForSelector('.table .tr'); ok((await body(page)).includes('payout_hold_days'), 'the audit log records the setting change with who and why');
  await ctx.close();
}

// ---------------------------------------------------------------- finance
{
  const { ctx, page } = await win(); await signIn(page, 'finance', 'finance@eazystores.test'); await page.waitForSelector('text=Owed to sellers'); ok(true, 'finance overview shows the ledger figures');
  await page.locator('.sd-nav', { hasText: 'Seller balances' }).click(); await page.fill('input[aria-label="Search sellers"]', 'Clay'); await page.waitForSelector('.table .tr'); const row = page.locator('.table .tr', { hasText: 'Clay & Ember' }).first(); ok(/available/.test(await row.innerText()), 'balances show available money and money on hold');
  await row.getByRole('button', { name: 'Record payout…' }).click(); const amt = page.locator('input[id^="pa-"]'); const avail = await amt.inputValue(); ok(Number(avail) > 0, 'the payout form starts at the available amount');
  await amt.fill(String(Number(avail) + 100)); ok(await page.getByRole('button', { name: /Record payout of/ }).isDisabled(), 'paying more than is available is blocked');
  await amt.fill('10.00'); await page.locator('input[id^="pr-"]').fill(`ETF-${stamp}`); await page.getByRole('button', { name: /Record payout of/ }).click(); await page.waitForSelector(`text=ETF-${stamp}`); ok(true, 'a payout is recorded and listed');
  await page.locator('.sd-nav', { hasText: 'Orders and refunds' }).click(); await page.fill('input[aria-label="Order number, name or email"]', '10004'); await page.waitForFunction(() => document.querySelectorAll('.table .tr').length === 1); await page.locator('.table .tr').first().click(); await page.waitForSelector('text=Payments and refunds');
  await page.getByRole('button', { name: 'Refund…' }).click(); await page.selectOption('select[aria-label^="Refund quantity"]', '1'); await page.fill('input[id^="rr-"]', 'Goodwill after a late parcel'); await page.getByRole('button', { name: 'Refund', exact: true }).last().click(); await page.waitForSelector('text=Goodwill after a late parcel'); ok(true, 'finance refunds part of an order and it appears under refunds');
  await page.locator('.sd-nav', { hasText: 'GST and exports' }).click(); await page.waitForSelector('text=Net GST to remit'); const csv = await page.request.get(`${BASE}/api/finance/export/sales.csv`); ok(csv.ok() && (await csv.text()).startsWith('order,date,seller'), 'the sales export downloads as a CSV'); ok((await csv.headers())['content-disposition']?.includes('attachment'), 'and as an attachment');
  await page.fill('input[aria-label="From date"]', '2999-01-01'); await page.fill('input[aria-label="To date"]', '2999-01-02'); await page.waitForFunction(() => document.body.textContent.includes('$0.00')); ok(true, 'GST for a period with no sales is zero');
  await ctx.close();
}

// ---------------------------------------------------------------- admin restores the setting; marketing curates the home page
{
  const { ctx, page } = await win(); await signIn(page, 'admin', 'admin@eazystores.test'); await page.waitForSelector('.sd-side'); await page.goto(`${BASE}/admin/settings`); await page.waitForSelector('text=payout_hold_days'); await page.locator('.tr', { hasText: 'payout_hold_days' }).getByRole('button', { name: 'Change' }).click(); await page.fill('#st-val', '5'); await page.fill('#st-why', 'Back to normal'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('#st-val')); ok(true, 'the payout hold is put back to 5 days');
  await page.goto(`${BASE}/admin/settings`); await page.waitForSelector('text=Features'); const before = await page.getByLabel('wishlists on').isChecked(); await page.getByLabel('wishlists on').click(); await page.waitForFunction(b => document.querySelector('input[aria-label="wishlists on"]').checked !== b, before); await page.getByLabel('wishlists on').click(); ok(true, 'feature flags toggle'); await ctx.close();
}
{
  const { ctx, page } = await win(); await signIn(page, 'marketing', 'marketing@eazystores.test'); await page.waitForSelector('text=Maker spotlight'); ok(true, 'marketing opens the home page editor');
  const original = await page.inputValue('#hm-promo'); await page.fill('#hm-promo', `Free shipping over $60 this week ${stamp % 1000}`);
  const picks = page.locator('input[aria-label="Find a product for New from makers: desktop"]'); await picks.fill('Speckled'); await page.locator('button.opt', { hasText: 'Speckled' }).first().click(); await page.getByRole('button', { name: 'Move up', exact: true }).last().click();
  await page.getByRole('button', { name: 'Save changes' }).click(); await page.waitForSelector('text=Saved. The shop home page now shows this.'); ok(true, 'home page changes save');
  const shop = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const sp = await shop.newPage(); await sp.goto(BASE + '/'); await sp.waitForSelector('.dspot'); ok((await sp.locator('.promo').innerText()).includes('this week'), 'the new promo bar text shows on the shop home page'); ok((await sp.locator('.drow .pcard h4').allInnerTexts()).some(t => t.startsWith('Speckled')), 'the curated product shows in "New from makers"');
  await page.fill('#hm-promo', original); await page.getByRole('button', { name: 'Find a product for New from makers: desktop' }).count(); await page.reload(); await page.waitForSelector('#hm-promo');
  const rm = page.getByRole('button', { name: /^Remove Speckled/ }).first(); if (await rm.count()) await rm.click(); await page.fill('#hm-promo', original); await page.getByRole('button', { name: 'Save changes' }).click(); await page.waitForSelector('text=Saved. The shop home page now shows this.'); ok(true, 'the original home page is restored');
  await page.locator('.sd-nav', { hasText: 'Search words' }).click(); await page.fill('#sy-t', 'carafe'); await page.fill('#sy-r', 'jug, pitcher'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.waitForSelector('text=also finds jug, pitcher'); ok(true, 'a search synonym is added');
  const found = await (await shop.request.get(`${BASE}/api/products?q=carafe`)).json(); ok(found.total > 0, 'searching the new word finds the synonym matches');
  await page.locator('.tr', { hasText: 'carafe' }).getByRole('button', { name: 'Remove' }).click(); await page.waitForFunction(() => !document.body.textContent.includes('also finds jug, pitcher')); ok(true, 'and it can be removed');
  await ctx.close(); await shop.close();
}
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll console flow checks passed.'); process.exit(fails.length ? 1 : 0);
