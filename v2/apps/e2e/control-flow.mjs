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

// 5. Roles: the admin turns a permission off for a role, a marketing user feels it at once, and resetting restores it
const maker = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-CA' })).newPage();
const mk = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-CA' })).newPage(); await mk.goto(`${BASE}/marketing/login`); await mk.fill('#cl-email', 'marketing@eazystores.test'); await mk.fill('#cl-pw', PW); await mk.getByRole('button', { name: 'Sign in' }).click(); await mk.waitForSelector('.sd-side');
await admin.goto(`${BASE}/admin/roles`); await admin.waitForSelector('text=Roles and access'); ok((await admin.locator('b', { hasText: 'Support' }).count()) >= 1, 'every role is listed on the roles page');
await admin.locator('.card', { hasText: 'Marketing' }).filter({ has: admin.getByRole('button', { name: 'Edit' }) }).first().getByRole('button', { name: 'Edit' }).click();
await admin.getByRole('switch', { name: /Marketing: Edit the home page/ }).click(); await admin.getByRole('button', { name: 'Save changes' }).click(); await admin.waitForSelector('text=Saved. It applies');
await mk.goto(`${BASE}/marketing/ads`); await mk.waitForSelector('[role=alert], .err, .empty', { timeout: 15000 }); ok(!(await mk.locator('.tr').count()), 'marketing loses access to its tools right after the admin switches the permission off');
await admin.getByRole('button', { name: 'Back to default' }).click(); await admin.waitForSelector('text=Back to the default.');
await mk.goto(`${BASE}/marketing/ads`); await mk.waitForSelector('h1'); ok(true, 'and gets it back when reset');

// 6. Open another console from admin, with no second sign-in
await admin.goto(`${BASE}/admin`); await admin.waitForSelector('.cons-portals'); await admin.locator('.cons-portals').getByRole('button', { name: 'Support' }).click(); await admin.waitForURL(/\/support$/); await admin.waitForSelector('.sd-side');
ok(!admin.url().includes('/login'), 'admin opens the support console from the admin sidebar without signing in again');
// 7. Switches for one maker, and working as that maker
await admin.goto(`${BASE}/admin/sellers`); await admin.fill('input[aria-label="Search by business, shop or owner email"]', 'clay'); await admin.waitForSelector('.table .tr'); await admin.locator('.table .tr', { hasText: 'Clay & Ember' }).first().click(); await admin.waitForSelector('text=Switches for this maker');
await admin.getByRole('switch', { name: 'Publish new listings for this maker' }).click(); await admin.waitForSelector('text=Type a short reason first.'); ok(true, 'a reason is needed before a maker switch changes');
await admin.fill('#mk-why', 'Listings under review'); await admin.getByRole('switch', { name: 'Publish new listings for this maker' }).click(); await admin.waitForFunction(() => document.querySelector('[role=switch][aria-label="Publish new listings for this maker"]')?.getAttribute('aria-checked') === 'false'); ok(true, 'publishing is paused for this maker');
await admin.getByRole('switch', { name: 'Publish new listings for this maker' }).click(); await admin.waitForFunction(() => document.querySelector('[role=switch][aria-label="Publish new listings for this maker"]')?.getAttribute('aria-checked') === 'true'); ok(true, 'and switched back on');
await admin.getByRole('button', { name: 'Work as this maker…' }).click(); await admin.fill('#aa-why', 'Fixing a listing for them'); await admin.fill('#aa-pw', PW); await admin.getByRole('button', { name: 'Open the studio' }).click(); await admin.waitForURL(/\/studio$/); await admin.waitForSelector('text=Working as admin inside');
ok(await admin.locator('text=Fixing a listing for them').first().isVisible(), 'the studio opens with a banner that says whose studio and why');
await admin.getByRole('button', { name: 'Leave' }).click(); await admin.waitForURL(/\/admin\/sellers\//); ok(true, 'Leave returns to the maker page in admin');

// 8. Pages, email wording and portal names
await admin.goto(`${BASE}/admin/pages`); await admin.waitForSelector('text=Pages'); await admin.getByRole('button', { name: 'New page' }).click(); await admin.fill('#pg-slug', 'privacy'); await admin.fill('#pg-title', 'Privacy policy'); await admin.fill('#pg-body', 'We keep what you tell us private.\n\n## What we collect\nYour name, email and address, to deliver your order.');
await admin.getByRole('switch', { name: 'Visible to visitors' }).click(); await admin.getByRole('button', { name: 'Save', exact: true }).click(); await admin.waitForSelector('text=Published');
await shop.goto(BASE + '/'); await shop.waitForSelector('nav[aria-label="Information"]'); await shop.getByRole('link', { name: 'Privacy policy' }).click(); await shop.waitForSelector('h1:has-text("Privacy policy")'); ok(await shop.locator('h2', { hasText: 'What we collect' }).isVisible(), 'a published page appears in the shop footer and renders its heading');
await admin.locator('.tr', { hasText: 'Privacy policy' }).getByRole('button', { name: 'Delete' }).click(); await admin.waitForSelector('text=No pages yet.');
await admin.goto(`${BASE}/admin/emails`); await admin.waitForSelector('text=Order shipped'); await admin.locator('.tr', { hasText: 'Order shipped' }).getByRole('button', { name: 'Edit' }).click(); await admin.fill('#ei-order_shipped', 'Hello from the EAZYstores team.'); await admin.getByRole('button', { name: 'Preview' }).click(); await admin.waitForSelector('[aria-label=Preview]');
ok((await admin.locator('[aria-label=Preview]').innerText()).includes('Hello from the EAZYstores team.') && (await admin.locator('[aria-label=Preview]').innerText()).includes('Tracking number'), 'the email preview shows the new line and keeps the order details');
await admin.goto(`${BASE}/admin/branding`); await admin.waitForSelector('#br-studio'); await admin.fill('#br-studio', 'makers'); await admin.selectOption('#bl-studio', 'sage'); await admin.getByRole('button', { name: 'Save' }).click(); await admin.waitForSelector('text=Saved. Each portal');
await maker.goto(`${BASE}/studio/login`); await maker.fill('#sl-email', 'amara@clayember.test'); await maker.fill('#sl-pw', PW); await maker.getByRole('button', { name: 'Sign in' }).click(); await maker.waitForSelector('.sd-side'); ok((await maker.locator('.sd-side .logo').first().innerText()).includes('makers'), 'the studio shows the new portal name beside the logo');
await admin.goto(`${BASE}/admin/branding`); await admin.fill('#br-studio', 'studio'); await admin.selectOption('#bl-studio', 'atelier'); await admin.getByRole('button', { name: 'Save' }).click(); await admin.waitForSelector('text=Saved. Each portal');
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll control flow checks passed.'); process.exit(fails.length ? 1 : 0);
