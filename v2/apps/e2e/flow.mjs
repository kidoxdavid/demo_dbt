// End-to-end buyer flow in a real browser against the running stack (web on :5180 proxying the API, demo data seeded, test payment provider).
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/flow.mjs
import { chromium } from 'playwright';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fails = []; const log = [];
const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const stamp = Date.now();

async function phone() { const ctx = await browser.newContext({ viewport: { width: 390, height: 798 }, locale: 'en-CA' }); const page = await ctx.newPage(); page.on('pageerror', e => fails.push(`page error: ${e.message}`)); return { ctx, page }; }

// ---- 1. Guest: browse, add, basket, checkout, pay
{
  const { ctx, page } = await phone();
  await page.goto(BASE + '/'); await page.waitForSelector('.pcard');
  ok((await page.locator('.pcard').count()) === 4, 'home shows four cards on a phone');
  await page.locator('.pcard h4', { hasText: 'Dusk over the hills' }).click(); await page.waitForSelector('.buybar');
  ok(await page.locator('h1', { hasText: 'Dusk over the hills' }).isVisible(), 'product page opens from a card');
  await page.getByRole('button', { name: 'Add to basket' }).click(); await page.waitForSelector('.toast');
  ok((await page.locator('.toast').innerText()).includes('Added'), 'adding shows a confirmation');
  await page.goto(BASE + '/basket'); await page.waitForSelector('.bline');
  ok((await page.locator('.bline').count()) === 1, 'basket has the piece');
  await page.locator('select.qty').selectOption('2'); await page.waitForFunction(() => document.querySelector('.summarybar')?.textContent?.includes('2 items'));
  ok(true, 'quantity change reprices the basket');
  await page.getByRole('button', { name: /This is a gift/ }).click(); await page.locator('#gift-msg').fill('Happy birthday!'); await page.getByRole('button', { name: 'Save message' }).click();
  await page.waitForFunction(() => document.body.textContent.includes('Edit message')); ok(true, 'gift message saves');
  await page.getByRole('link', { name: /Checkout/ }).click(); await page.waitForSelector('#co-email');
  await page.fill('#co-email', `guest${stamp}@t.test`); await page.fill('#co-name', 'Gia Guest'); await page.fill('#co-l1', '1 Main St'); await page.fill('#co-city', 'Calgary'); await page.fill('#co-post', '12345');
  await page.getByRole('button', { name: 'Continue to payment' }).click(); await page.waitForSelector('[role=alert]');
  ok((await page.locator('[role=alert]').innerText()).length > 5, 'a bad postal code is refused with a message');
  await page.fill('#co-post', 'T2N 1N4'); await page.getByRole('button', { name: 'Continue to payment' }).click(); await page.waitForSelector('text=Test mode');
  ok(await page.locator('text=GST').first().isVisible(), 'payment step shows the GST');
  await page.getByRole('button', { name: /Pay \$.* \(test\)/ }).click(); await page.waitForURL(/\/orders\//); await page.waitForSelector('text=Thank you');
  ok(true, 'test payment confirms the order'); ok((await page.locator('.timeline li.on').count()) >= 1, 'order page shows progress');
  ok((await page.locator('.badge').count()) === 0, 'basket is empty after paying');
  await ctx.close();
}

// ---- 2. Sign up, save a piece, follow a shop, filters
{
  const { ctx, page } = await phone();
  await page.goto(BASE + '/c/pottery-ceramics'); await page.waitForSelector('.pcard');
  const total = async () => (await page.locator('.cat-head .n').innerText());
  ok(/412 pieces from 38 makers/.test(await total()), 'category header reads 412 pieces from 38 makers');
  await page.locator('.pcard .heart').first().click(); await page.waitForURL(/\/account/); ok(true, 'saving as a guest sends you to sign in');
  await page.getByRole('button', { name: 'Create an account' }).click(); await page.fill('#ac-name', 'Sam Saver'); await page.fill('#ac-email', `saver${stamp}@t.test`); await page.fill('#ac-pw', 'correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Create account' }).click(); await page.waitForURL(/\/c\/pottery-ceramics/); await page.waitForSelector('.pcard');
  await page.locator('.pcard .heart').first().click(); await page.waitForSelector('.pcard .heart.on'); ok(true, 'signed-in heart fills in');
  await page.goto(BASE + '/saved'); await page.waitForSelector('.pcard'); ok((await page.locator('.pcard').count()) === 1, 'saved page lists the piece');
  await page.goto(BASE + '/c/pottery-ceramics'); await page.waitForSelector('.pcard');
  await page.getByRole('button', { name: /^Handmade/ }).click(); await page.waitForFunction(() => /\d+ pieces/.test(document.querySelector('.cat-head .n')?.textContent ?? '') && !document.querySelector('.cat-head .n').textContent.startsWith('412'));
  ok(true, 'Handmade filter narrows the list'); ok(page.url().includes('handmade=true'), 'filter lives in the URL');
  await page.goto(BASE + '/shop/clay-ember'); await page.waitForSelector('.pcard'); await page.getByRole('button', { name: 'Follow' }).click(); await page.waitForSelector('text=Following'); ok(true, 'following a shop works');
  await page.goto(BASE + '/search?q=mug'); await page.waitForSelector('.pcard'); ok((await page.locator('.pcard').count()) > 0, 'search finds mugs');
  await page.goto(BASE + '/search?q=zzzzqqq'); await page.waitForSelector('.empty'); ok(true, 'an empty search says so');
  await page.goto(BASE + '/account'); await page.waitForSelector('text=Hello, Sam'); await page.getByRole('button', { name: 'Sign out' }).click(); await page.waitForSelector('text=Sign in'); ok(true, 'sign out works');
  await ctx.close();
}

// ---- 3. Desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage(); page.on('pageerror', e => fails.push(`page error: ${e.message}`));
  await page.goto(BASE + '/'); await page.waitForSelector('.dspot'); ok(await page.locator('.dnav').isVisible(), 'desktop shows the category nav');
  await page.locator('.dnav a', { hasText: 'Pottery' }).click(); await page.waitForSelector('.grid4 .pcard'); ok((await page.locator('.grid4 .pcard').count()) === 24, 'desktop category shows a four-column grid');
  await page.locator('.pcard h4').first().click(); await page.waitForSelector('.pdp-desktop'); ok(true, 'desktop product page opens');
  await page.goto(BASE + '/p/00000000-0000-4000-8000-000000000000'); await page.waitForSelector('text=We could not find that piece'); ok(true, 'unknown product shows a friendly page');
  await ctx.close();
}
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll flow checks passed.'); process.exit(fails.length ? 1 : 0);
