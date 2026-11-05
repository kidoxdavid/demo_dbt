// End-to-end #7: the customer journey. Store page, quick add, cart drawer, product page (stock, sold out, drop, notify), checkout steps, order timeline.
// Usage: ONLY=desktop|mobile node e2e/flow7.cjs <screenshotDir>    (needs API :3000 and web :5173)
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
    const slug = `cx-${id}${name[0]}`; const sc = await browser.newContext(); const r = sc.request;
    assert.equal((await r.post(`${BASE}/api/auth/signup`, { data: { email: `${slug}@example.test`, password: 'correct-horse-battery', fullName: 'Sam', businessName: `Journey ${slug}`, storeSlug: slug } })).status(), 201);
    await r.patch(`${BASE}/api/seller/business`, { data: { category: 'Gifts', description: 'Things', city: 'Calgary', region: 'AB', fulfilment: { pickup: true, delivery: true, shipping: false } } });
    await r.put(`${BASE}/api/seller/shipping-rules`, { data: { rules: [{ name: 'Free over $75', regions: ['AB'], minSubtotalCents: 7500, priceCents: 0 }, { name: 'Everywhere', regions: [], priceCents: 1200 }] } });
    const mk = async (n, stock, extra = {}) => (await (await r.post(`${BASE}/api/seller/products`, { data: { name: n, status: 'active', variants: [{ title: 'Default', priceCents: 3000, costCents: 1000, stock }], ...extra } })).json()).id;
    const low = await mk('Low Stock Candle', 3); const sold = await mk('Sold Out Mug', 0); const drop = await mk('Dropping Scarf', 10);
    await r.post(`${BASE}/api/seller/store/publish`); await r.put(`${BASE}/api/seller/products/${drop}/drop`, { data: { availableFrom: new Date(Date.now() + 3 * 86400000).toISOString() } });
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile }); const p = await ctx.newPage(); p.on('pageerror', e => { throw e; });
    const go = async (path, label) => { await p.goto(`${BASE}${path}`); await p.waitForLoadState('networkidle'); await noHScroll(p, `${name} ${label}`); };

    // Store page: badges, quick add opens the drawer, qty and free-delivery nudge
    await go(`/store/${slug}`, 'store'); await p.getByText('Only 3 left').first().waitFor(); await p.getByText('Sold out').first().waitFor(); await p.getByText(/Drops /).first().waitFor();
    await p.screenshot({ path: `${out}/${name}-store.png` });
    await p.getByRole('button', { name: 'Add Low Stock Candle to cart' }).click(); await p.getByRole('dialog', { name: 'Your cart' }).waitFor(); await p.getByText(/away from free delivery/).waitFor(); await noHScroll(p, `${name} drawer`);
    await p.getByRole('button', { name: 'Increase Low Stock Candle' }).click(); await p.getByRole('dialog').getByText('$60.00').first().waitFor(); await p.screenshot({ path: `${out}/${name}-drawer.png` });
    await p.keyboard.press('Escape'); await p.getByRole('dialog', { name: 'Your cart' }).waitFor({ state: 'detached' });
    assert.ok((await p.getByRole('button', { name: /Open cart, 2 items/ }).count()) === 1);

    // Product pages: sold out and drop both offer to tell you
    await go(`/store/${slug}/p/${sold}`, 'sold out product'); await p.getByRole('button', { name: 'Sold out' }).waitFor(); await p.getByLabel('Your email').fill('wait@example.test'); await p.getByRole('button', { name: 'Notify me' }).click(); await p.getByText('We will email you when it is back').waitFor();
    await go(`/store/${slug}/p/${drop}`, 'drop product'); await p.getByText(/^Drops /).first().waitFor(); await p.getByLabel('Your email').fill('wait@example.test'); await p.getByRole('button', { name: 'Remind me' }).click(); await p.getByText(/the moment it goes live/).waitFor(); await p.screenshot({ path: `${out}/${name}-drop.png` });
    await go(`/store/${slug}/p/${low}`, 'product'); await p.getByText('Only 3 left').first().waitFor(); await p.getByText(/Delivery anywhere in Canada: \$12.00/).waitFor(); await p.getByText('More from', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Increase quantity' }).click(); await p.getByRole('button', { name: /Add to cart · \$60.00/ }).waitFor(); await p.screenshot({ path: `${out}/${name}-product.png` });

    // Checkout: three steps, delivery as cards, summary beside it, order placed, timeline
    await p.getByRole('button', { name: /Open cart/ }).click(); await p.getByRole('link', { name: /^Checkout/ }).click(); await p.getByRole('heading', { name: 'Checkout' }).waitFor(); await noHScroll(p, `${name} checkout`);
    await p.getByLabel('Name').fill('Wendy Walker'); await p.getByLabel('Email').first().fill('wendy@example.test'); await p.getByRole('radio', { name: /Delivery/ }).check();
    await p.getByLabel('Street address').fill('1 Main St'); await p.getByLabel('City').fill('Calgary'); await p.getByLabel('Province').selectOption('AB'); await p.getByLabel('Postal code').fill('T2P 1J9');
    await p.getByText('Everywhere').first().waitFor(); await noHScroll(p, `${name} checkout delivery`); await p.screenshot({ path: `${out}/${name}-checkout.png`, fullPage: true });
    await p.getByRole('button', { name: /Place order/ }).click(); await p.getByRole('button', { name: 'Simulate successful payment' }).click(); await p.waitForURL(/\/order\//);
    await p.getByRole('list', { name: 'Order progress' }).waitFor(); await noHScroll(p, `${name} order`); await p.screenshot({ path: `${out}/${name}-order.png` });
    console.log(`${name}: customer journey passed`); await ctx.close(); await sc.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
