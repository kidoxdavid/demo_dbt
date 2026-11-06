// A maker runs a promotion on their own store page; staff approve it; visitors see it; the maker can hide it.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/promotions-flow.mjs   (web on :5180 proxying the API; demo seed)
import { chromium } from 'playwright';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const PW = 'demo-password-2026';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fails = []; const log = []; const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const page = async (w, h) => { const p = await (await browser.newContext({ viewport: { width: w, height: h }, locale: 'en-CA' })).newPage(); p.on('pageerror', e => fails.push(`page error: ${e.message}`)); return p; };
const stamp = Date.now(); const headline = `Autumn glaze sale ${stamp % 10000}`;

const maker = await page(1280, 900); await maker.goto(`${BASE}/studio/login`); await maker.fill('#sl-email', 'amara@clayember.test'); await maker.fill('#sl-pw', PW); await maker.getByRole('button', { name: 'Sign in' }).click(); await maker.waitForSelector('.sd-side');
// start clean: end any promotion left from an earlier run
await maker.goto(`${BASE}/studio/promotions`); await maker.waitForSelector('#pr-h'); if (await maker.getByRole('button', { name: 'End it' }).count()) { await maker.getByRole('button', { name: 'End it' }).click(); await maker.waitForFunction(() => !document.body.textContent.includes('End it')); }
await maker.fill('#pr-h', headline); await maker.fill('#pr-b', 'Small batch, fired this week.'); const opts = await maker.locator('#pr-p option').allInnerTexts(); ok(opts.length > 1, 'the maker can pick one of their own pieces to feature');
await maker.selectOption('#pr-p', { index: 1 }); await maker.getByRole('button', { name: 'Start promotion' }).click(); await maker.waitForSelector('text=Waiting for approval'); ok(true, 'a new promotion waits for approval');

const visitor = await page(390, 798); await visitor.goto(`${BASE}/shop/clay-ember`); await visitor.waitForSelector('.pcard'); ok((await visitor.locator('text=' + headline).count()) === 0, 'visitors do not see it before approval');

const staff = await page(1280, 900); await staff.goto(`${BASE}/marketing/login`); await staff.fill('#cl-email', 'marketing@eazystores.test'); await staff.fill('#cl-pw', PW); await staff.getByRole('button', { name: 'Sign in' }).click(); await staff.waitForSelector('.sd-side');
await staff.goto(`${BASE}/marketing/promotions`); await staff.waitForSelector(`text=${headline}`); await staff.locator('.tr', { hasText: headline }).getByRole('button', { name: 'Approve' }).click(); await staff.waitForSelector('.tr:has-text("' + headline + '") >> text=Live'); ok(true, 'marketing approves it');

await visitor.reload(); await visitor.waitForSelector(`text=${headline}`); ok(await visitor.getByRole('region', { name: 'Promotion from this maker' }).isVisible(), 'the promotion shows on the store page for visitors');
await visitor.getByRole('region', { name: 'Promotion from this maker' }).getByRole('button', { name: 'Shop now' }).click(); await visitor.waitForURL(/\/p\//); ok(true, 'its button opens the featured piece');
await maker.goto(`${BASE}/studio/promotions`); await maker.waitForSelector('text=Showing on your store page'); ok(/[1-9]\d* clicks/.test(await maker.locator('.card.sd-card').first().innerText()), 'the maker sees the click counted');
await maker.getByRole('switch', { name: 'Show on my store page' }).click(); await maker.waitForSelector('text=Hidden by you'); await visitor.goto(`${BASE}/shop/clay-ember`); await visitor.waitForSelector('.pcard'); ok((await visitor.locator('text=' + headline).count()) === 0, 'the maker hides it with one switch');

const admin = await page(1280, 900); await admin.goto(`${BASE}/admin/login`); await admin.fill('#cl-email', 'admin@eazystores.test'); await admin.fill('#cl-pw', PW); await admin.getByRole('button', { name: 'Sign in' }).click(); await admin.waitForSelector('.sd-side');
await admin.goto(`${BASE}/admin/settings`); await admin.getByRole('switch', { name: 'Store promotions', exact: true }).waitFor(); ok(true, 'admin has the Store promotions feature switch');
await admin.goto(`${BASE}/admin/promotions`); await admin.waitForSelector(`text=${headline}`); ok(true, 'admin sees the same approval list');
await maker.goto(`${BASE}/studio/promotions`); await maker.getByRole('button', { name: 'End it' }).click();
await browser.close(); console.log(log.join('\n')); console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.join('\n')}` : '\nAll promotions flow checks passed.'); process.exit(fails.length ? 1 : 0);
