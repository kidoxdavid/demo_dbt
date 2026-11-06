// Admin controls other portals' features: toggles and typed settings in a real browser, and the shop reacting to them.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/control-flow.mjs   (web on :5180 proxying the API; demo seed)
import { chromium } from 'playwright';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const PW = 'demo-password-2026';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fails = []; const log = []; const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-CA' })).newPage(); admin.on('pageerror', e => fails.push(`page error: ${e.message}`));
const shop = await (await browser.newContext({ viewport: { width: 390, height: 798 }, locale: 'en-CA' })).newPage(); shop.on('pageerror', e => fails.push(`page error: ${e.message}`));

await admin.goto(`${BASE}/admin/login`); await admin.fill('#cl-email', 'admin@eazystores.test'); await admin.fill('#cl-pw', PW); await admin.getByRole('button', { name: 'Sign in' }).click(); await admin.waitForSelector('.sd-side');
await admin.goto(`${BASE}/admin/settings`); await admin.waitForSelector('[role=switch]');
ok((await admin.locator('[role=switch]').count()) >= 10, 'every feature has a switch');
ok((await admin.locator('h3', { hasText: 'Studio (makers)' }).count()) === 1, 'features are grouped by portal');
const sw = n => admin.getByRole('switch', { name: n });

// 1. Saved hearts off: the heart disappears from product cards
await shop.goto(BASE + '/c/pottery-ceramics'); await shop.waitForSelector('.pcard'); ok((await shop.locator('.pcard .heart').count()) > 0, 'hearts show while the feature is on');
await sw('Saved pieces (hearts)').click(); await admin.waitForFunction(() => document.querySelector('[role=switch][aria-label="Saved pieces (hearts)"]')?.getAttribute('aria-checked') === 'false');
await shop.reload(); await shop.waitForSelector('.pcard'); ok((await shop.locator('.pcard .heart').count()) === 0, 'hearts disappear when the admin switches saved pieces off');
await sw('Saved pieces (hearts)').click(); await admin.waitForFunction(() => document.querySelector('[role=switch][aria-label="Saved pieces (hearts)"]')?.getAttribute('aria-checked') === 'true');
await shop.reload(); await shop.waitForSelector('.pcard'); ok((await shop.locator('.pcard .heart').count()) > 0, 'and come back when switched on');

// 2. Following off
await sw('Following shops').click(); await admin.waitForFunction(() => document.querySelector('[role=switch][aria-label="Following shops"]')?.getAttribute('aria-checked') === 'false');
await shop.goto(BASE + '/shop/clay-ember'); await shop.waitForSelector('.pcard'); ok((await shop.getByRole('button', { name: 'Follow' }).count()) === 0, 'the Follow button disappears when following is switched off');
await sw('Following shops').click();

// 3. Closing buyer sign-ups hides "Create an account"
await sw('Buyer sign-ups').click(); await admin.waitForFunction(() => document.querySelector('[role=switch][aria-label="Buyer sign-ups"]')?.getAttribute('aria-checked') === 'false');
await shop.goto(BASE + '/account'); await shop.waitForSelector('#ac-email'); ok((await shop.getByRole('button', { name: 'Create an account' }).count()) === 0, 'new accounts cannot be started while buyer sign-ups are closed');
await sw('Buyer sign-ups').click(); await admin.waitForFunction(() => document.querySelector('[role=switch][aria-label="Buyer sign-ups"]')?.getAttribute('aria-checked') === 'true');

// 4. Typed settings: commission as a percent, free shipping as dollars
await admin.getByRole('group').count();
const row = t => admin.locator('.tr', { hasText: t }).first();
ok((await row('Commission').innerText()).includes('10%'), 'commission shows as a percent, not basis points');
await row('Commission').getByRole('button', { name: 'Change' }).click(); await admin.fill('#st-val', '12.5'); await admin.getByRole('button', { name: 'Save' }).click(); await admin.waitForSelector('text=Commission saved.');
ok((await row('Commission').innerText()).includes('12.5%'), 'commission 12.5% saved and shown');
await row('Commission').getByRole('button', { name: 'Change' }).click(); await admin.fill('#st-val', '10'); await admin.getByRole('button', { name: 'Save' }).click(); await admin.waitForSelector('text=Commission saved.');
await row('Free shipping from').getByRole('button', { name: 'Change' }).click(); await admin.fill('#st-val', 'abc'); await admin.getByRole('button', { name: 'Save' }).click(); await admin.waitForSelector('[role=alert]'); ok(true, 'a non-number is refused with a plain message');
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll control flow checks passed.'); process.exit(fails.length ? 1 : 0);
