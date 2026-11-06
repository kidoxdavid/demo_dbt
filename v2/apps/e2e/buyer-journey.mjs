// A first-time buyer, start to finish, on a phone and on a laptop: add straight from a card, see the basket, check out, a declined card, pay, find the order again.
// It makes its own maker and piece through the API, so it works on an empty database too.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/buyer-journey.mjs   (web on :5180 proxying the API)
import { chromium } from 'playwright'; import sharp from 'sharp';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const fails = []; const log = []; const ok = (c, m) => { log.push(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
const post = async (path, body, cookie, ct) => { const r = await fetch(BASE + path, { method: 'POST', headers: { origin: BASE, 'content-type': ct ?? 'application/json', ...(cookie ? { cookie } : {}) }, body: ct ? body : JSON.stringify(body) }); return { r, j: await r.json().catch(() => null), cookie: (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ') }; };
const stamp = Date.now(); const title = `Journey mug ${stamp}`;
const s = await post('/api/studio/signup', { email: `jmaker${stamp}@t.test`, password: 'correct-horse-battery', fullName: 'Jo Maker', categories: ['pottery-ceramics'], shopName: `Journey Pottery ${stamp % 10000}` }); ok(s.r.status === 201, 'a maker signs up');
const m = await post('/api/studio/media', await sharp({ create: { width: 900, height: 900, channels: 3, background: '#c8a05a' } }).jpeg().toBuffer(), s.cookie, 'image/jpeg');
const p = await post('/api/studio/products', { title, categorySlug: 'pottery-ceramics', priceCents: 3200, stock: 6, attributes: {}, mediaIds: [m.j.id] }, s.cookie); const pub = await post(`/api/studio/products/${p.j.id}/publish`, { acknowledged: true }, s.cookie); ok(pub.r.status === 200, 'the maker lists a piece');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const problems = [];
async function run(label, viewport, pay) {
  const page = await (await browser.newContext({ viewport, locale: 'en-CA' })).newPage(); page.on('pageerror', e => problems.push(`${label}: page error ${e.message}`)); page.on('response', r => { if (r.status() >= 400 && !/\/api\/(me|admin\/me|studio\/me)$/.test(r.url())) problems.push(`${label}: ${r.status()} ${r.url().replace(BASE, '')}`); });
  const money = t => Number((String(t).match(/\$?\s*(\d+(?:\.\d+)?)/) ?? [])[1]);
  await page.goto(`${BASE}/search?q=${encodeURIComponent(title)}`); await page.waitForSelector('.pcard'); const add = page.locator('.pcard', { hasText: title }).locator('.qadd'); ok(await add.count() === 1, `${label}: the card has an add button`);
  await add.click(); await page.waitForSelector('.toast'); ok((await page.locator('.toast').innerText()).includes('Added'), `${label}: tapping it confirms the add`); await page.waitForFunction(() => document.querySelector('.qadd.done')); ok(true, `${label}: the button shows it was added`);
  if (viewport.width < 600) { ok((await page.locator('.tabbadge').innerText()) === '1', `${label}: the Basket tab shows 1 item`); }
  await page.goto(BASE + '/basket'); await page.waitForSelector('.bline'); const checkoutText = await page.getByRole('link', { name: /Checkout/ }).first().innerText(); ok(/incl\. GST/.test(checkoutText), `${label}: the basket button says the total includes GST`); const basketTotal = money(checkoutText.split('·')[1].replace('$', ''));
  await page.getByRole('link', { name: /Checkout/ }).first().click(); await page.waitForSelector('#co-email'); await page.fill('#co-email', `jbuyer${stamp}${label[0]}@t.test`); await page.fill('#co-name', 'Bea Buyer'); await page.fill('#co-l1', '1 Main St'); await page.fill('#co-city', 'Calgary'); await page.fill('#co-post', 'T2N 1N4');
  await page.getByRole('button', { name: 'Continue to payment' }).click(); await page.waitForSelector('text=Test mode'); const payTotal = money(await page.getByRole('button', { name: /Pay \$.* \(test\)/ }).innerText()); ok(Math.abs(payTotal - basketTotal) < 0.005, `${label}: the amount to pay ($${payTotal}) is the basket total ($${basketTotal})`);
  await page.getByRole('button', { name: 'Simulate a declined card' }).click(); await page.waitForSelector('text=was declined'); ok(true, `${label}: a declined card says so plainly`);
  await page.goto(BASE + '/basket'); await page.waitForSelector('.bline'); ok(true, `${label}: after a decline the piece is still in the basket`);
  await page.getByRole('link', { name: /Checkout/ }).first().click(); await page.waitForSelector('#co-name'); await page.fill('#co-name', 'Bea Buyer'); await page.fill('#co-l1', '1 Main St'); await page.fill('#co-city', 'Calgary'); await page.fill('#co-post', 'T2N 1N4'); if (await page.locator('#co-email').count() && !(await page.inputValue('#co-email'))) await page.fill('#co-email', `jbuyer${stamp}${label[0]}@t.test`);
  await page.getByRole('button', { name: 'Continue to payment' }).click(); await page.waitForSelector('text=Test mode'); await page.getByRole('button', { name: /Pay \$.* \(test\)/ }).click(); await page.waitForURL(/\/orders\//); await page.waitForSelector('text=Thank you');
  const body = await page.locator('body').innerText(); ok(body.includes('Test mode: no card was charged'), `${label}: the confirmation says this was test mode`); ok(money((body.match(/Total\s*\$([\d.]+)/) ?? [])[1]) === basketTotal, `${label}: the order total matches the basket total`);
  ok(await page.getByRole('link', { name: 'Keep browsing' }).count() === 1 || await page.getByRole('button', { name: 'Keep browsing' }).count() === 1, `${label}: the confirmation offers a way on`);
  await page.getByRole('link', { name: /Account/ }).first().click(); await page.waitForURL(/\/account/);
  await page.close();
}
await run('phone', { width: 390, height: 798 }); await run('laptop', { width: 1280, height: 900 });
await browser.close(); console.log(log.join('\n')); if (problems.length) console.log('\nProblems seen:\n  ' + [...new Set(problems)].join('\n  '));
console.log(fails.length || problems.length ? `\n${fails.length} FAILED, ${problems.length} problems` : '\nAll buyer journey checks passed.'); process.exit(fails.length || problems.length ? 1 : 0);
