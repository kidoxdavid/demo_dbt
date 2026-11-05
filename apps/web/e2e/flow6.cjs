// End-to-end #6: profit-first. Overview headline, profit page, per-order breakdown with delivery cost, expenses, and the loses-money price warning.
// Usage: ONLY=desktop|mobile node e2e/flow6.cjs <screenshotDir>    (needs API :3000 and web :5173)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'; const out = process.argv[2] ?? '.'; const id = Date.now().toString(36);
async function noHScroll(page, label) {
  const w = page.viewportSize().width; const m = await page.evaluate(() => ({ iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  if (!(m.iw === w && m.sw <= w)) console.log(await page.evaluate(x => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > x + 1).slice(0, 6).map(e => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`), w));
  assert.ok(m.iw === w && m.sw <= w, `${label}: layout is ${m.iw}px wide (content ${m.sw}px) on a ${w}px screen`);
}
(async () => {
  const browser = await chromium.launch();
  for (const [name, vp, mobile] of [['desktop', { width: 1280, height: 860 }, false], ['mobile', { width: 390, height: 800 }, true]].filter(v => !process.env.ONLY || v[0] === process.env.ONLY)) {
    const slug = `pf-${id}${name[0]}`; const ctx = await browser.newContext({ viewport: vp, isMobile: mobile }); const p = await ctx.newPage(); p.on('pageerror', e => { throw e; });
    const go = async (path, label) => { await p.goto(`${BASE}${path}`); await p.waitForLoadState('networkidle'); await noHScroll(p, `${name} ${label}`); };
    const r = ctx.request;
    assert.equal((await r.post(`${BASE}/api/auth/signup`, { data: { email: `${slug}@example.test`, password: 'correct-horse-battery', fullName: 'Pat Seller', businessName: `Profit ${slug}`, storeSlug: slug } })).status(), 201);
    await r.patch(`${BASE}/api/seller/business`, { data: { category: 'Gifts', description: 'Things', region: 'AB', fulfilment: { pickup: true, delivery: true, shipping: false } } });
    await r.post(`${BASE}/api/seller/products`, { data: { name: 'Soy Candle', status: 'active', variants: [{ title: 'Std', priceCents: 3400, costCents: 1100, stock: 20 }] } });
    await r.post(`${BASE}/api/seller/store/publish`);
    const prods = await (await r.get(`${BASE}/api/seller/products`)).json(); const vid = prods[0].variants[0].id;
    const co = await (await r.post(`${BASE}/api/public/stores/${slug}/checkout`, { data: { items: [{ variantId: vid, quantity: 2 }], email: 'b@example.test', name: 'Bea', fulfilment: 'delivery', address: { line1: '1 Main', city: 'Calgary', region: 'AB', postalCode: 'T2T2T2', country: 'CA' } } })).json();
    await r.post(`${BASE}/api/public/payments/${co.paymentId}/simulate`, { data: { outcome: 'succeeded' } });

    // Login through the real screen, land on the overview with "what you kept" first
    await p.goto(`${BASE}/login`); await p.getByLabel('Email').fill(`${slug}@example.test`); await p.getByLabel('Password').fill('correct-horse-battery'); await p.getByRole('button', { name: 'Log in' }).click(); await p.waitForURL(/dashboard/);
    await p.getByText('what you actually kept').waitFor(); await p.getByText('Add costs', { exact: false }).count(); await noHScroll(p, `${name} overview`);
    assert.ok(/delivery order\(s\) have no delivery cost/.test(await p.locator('.keephero').innerText()));              // the nudge to finish the picture
    await p.screenshot({ path: `${out}/${name}-profit-overview.png` });

    // Order page: enter what delivery cost, the figure updates
    await go('/dashboard/orders', 'orders'); await p.getByRole('button', { name: /Open order/ }).first().click(); await p.getByText('You keep on this order').waitFor();
    const before = await p.locator('.orderkeep h3').innerText();
    await p.getByLabel('What you paid to deliver it ($)').fill('9.50'); await p.getByRole('button', { name: 'Save' }).click(); await p.getByText('Saved.').waitFor();
    await p.waitForFunction(b => document.querySelector('.orderkeep h3')?.textContent !== b, before); await noHScroll(p, `${name} order keep`);

    // Profit page and expenses
    await go('/dashboard/profit', 'profit'); await p.getByText('Where the money went').waitFor(); await p.getByText('You kept', { exact: true }).first().waitFor();
    await p.getByLabel('Amount ($)').fill('15'); await p.getByLabel('Note (optional)').fill('Instagram boost'); await p.getByRole('button', { name: 'Add expense' }).click(); await p.getByText('You kept after expenses').waitFor();
    await noHScroll(p, `${name} profit with expenses`); await p.screenshot({ path: `${out}/${name}-profit-page.png`, fullPage: true });

    // New product: the warning appears while typing a price that loses money
    await go('/dashboard/products', 'products'); await p.getByRole('button', { name: 'Add product' }).click();
    await p.getByLabel('Price ($)').fill('9'); await p.getByLabel('Your cost ($)').fill('9'); await p.getByText('You lose', { exact: false }).waitFor();
    await p.getByLabel('Price ($)').fill('60'); await p.getByText('per sale', { exact: false }).waitFor(); await noHScroll(p, `${name} price hint`);
    console.log(`${name}: profit flow passed`); await ctx.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
