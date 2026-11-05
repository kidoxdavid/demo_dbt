// End-to-end #5: Stage 3. Discount codes, delivery rules, counter sales, plan trial, customer account, reviews, favourites, business assistant.
// Usage: ONLY=desktop|mobile node e2e/flow5.cjs <screenshotDir>    (needs API :3000 and web :5173, both running against a migrated dev database)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const out = process.argv[2] ?? '.';
const id = Date.now().toString(36);
async function noHScroll(page, label) {
  const expected = page.viewportSize().width; const m = await page.evaluate(() => ({ iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  if (!(m.iw === expected && m.sw <= expected)) console.log(await page.evaluate(w => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > w + 1).slice(0, 6).map(e => `${e.tagName}.${e.className} right=${Math.round(e.getBoundingClientRect().right)} ${(e.textContent || '').slice(0, 25)}`), expected));
  assert.ok(m.iw === expected && m.sw <= expected, `${label}: layout is ${m.iw}px wide (content ${m.sw}px) on a ${expected}px screen`);
}
(async () => {
  const browser = await chromium.launch();
  for (const [name, vp, mobile] of [['desktop', { width: 1280, height: 860 }, false], ['mobile', { width: 390, height: 800 }, true]].filter(v => !process.env.ONLY || v[0] === process.env.ONLY)) {
    const slug = `s3-${id}${name[0]}`; const pw = 'correct-horse-battery'; const cust = `buyer-${slug}@example.test`;
    const sc = await browser.newContext({ viewport: vp, isMobile: mobile }); const s = await sc.newPage(); s.on('pageerror', e => { throw e; });
    const cc = await browser.newContext({ viewport: vp, isMobile: mobile }); const c = await cc.newPage(); c.on('pageerror', e => { throw e; });
    const shot = (page, n) => page.screenshot({ path: `${out}/${name}-${n}.png`, fullPage: false });
    const go = async (page, path, label) => { await page.goto(`${BASE}${path}`); await page.waitForLoadState('networkidle'); await noHScroll(page, `${name} ${label}`); };

    // Seller set-up through the API (earlier flows cover the sign-up screens); everything after is the real UI.
    const r = await sc.request;
    let res = await r.post(`${BASE}/api/auth/signup`, { data: { email: `${slug}@example.test`, password: pw, fullName: 'Sam Seller', businessName: `Stage3 ${slug}`, storeSlug: slug } }); assert.equal(res.status(), 201);
    await r.patch(`${BASE}/api/seller/business`, { data: { category: 'Gifts', description: 'Small-batch things', region: 'AB', taxFederal: true, fulfilment: { pickup: true, delivery: true, shipping: false } } });
    res = await r.post(`${BASE}/api/seller/products`, { data: { name: 'Linen Tote', description: 'A sturdy tote.', status: 'active', variants: [{ title: 'Natural', priceCents: 2500, costCents: 900, stock: 10, weightGrams: 300, barcode: `BC${id}` }] } }); assert.equal(res.status(), 201);
    assert.equal((await r.post(`${BASE}/api/seller/store/publish`)).status(), 200);

    // --- Plan: start the Professional trial from the screen (it unlocks counter sales)
    await go(s, '/dashboard/plan', 'plan');
    await s.getByText('Simulated billing.').waitFor();
    await s.locator('section.plan', { hasText: 'Professional' }).getByRole('button', { name: /free trial/ }).click();
    await s.getByText('Your free trial has started').waitFor(); await shot(s, 'plan');

    // --- Discount code
    await go(s, '/dashboard/discounts', 'discounts');
    await s.getByLabel('Code', { exact: true }).fill('SAVE10'); await s.getByLabel('Percent (1 to 100)').fill('10'); await s.getByRole('button', { name: 'Create code' }).click();
    await s.getByRole('cell', { name: /SAVE10/ }).waitFor(); await noHScroll(s, `${name} discounts list`); await shot(s, 'discounts');

    // --- Delivery rule
    await go(s, '/dashboard/delivery', 'delivery');
    await s.getByRole('button', { name: 'Add a rule' }).click(); await s.getByLabel('Name (shown to the customer)').fill('Anywhere in Canada'); await s.getByLabel('Delivery price ($)').fill('7.50');
    await s.getByRole('button', { name: 'Save delivery prices' }).click(); await s.getByText('Saved.').waitFor(); await noHScroll(s, `${name} delivery saved`); await shot(s, 'delivery');

    // --- Counter sale: scan the barcode, see the real total, take cash, get change
    await go(s, '/dashboard/pos', 'pos');
    await s.getByLabel(/Scan a barcode/).fill(`BC${id}`); await s.getByRole('button', { name: 'Find' }).click();
    await s.getByTestId('pos-total').waitFor(); assert.equal(await s.getByTestId('pos-total').innerText(), '$26.25');           // $25.00 + 5% GST
    await s.getByRole('button', { name: 'Add one Linen Tote' }).click(); await s.waitForFunction(() => document.querySelector('[data-testid=pos-total]')?.textContent === '$52.50');
    await s.getByLabel('Cash received ($)').fill('50'); await s.getByRole('button', { name: 'Cash is less than the total' }).waitFor();
    await s.getByLabel('Cash received ($)').fill('60'); await s.getByRole('button', { name: 'Record sale' }).click();
    await s.getByText('Change due: $7.50').waitFor(); await noHScroll(s, `${name} pos receipt`); await shot(s, 'pos');
    await s.getByText('Today at the counter').waitFor();

    // --- Customer: account, order with a code, review, favourite
    await go(c, `/store/${slug}/p/${(await (await cc.request.get(`${BASE}/api/public/stores/${slug}/products`)).json())[0].id}`, 'product');
    await c.getByLabel('Save to favourites').click(); await c.waitForURL(/\/account\/signup/);
    await c.getByLabel('Your name').fill('Cleo Customer'); await c.getByLabel('Email').fill(cust); await c.getByLabel('Password').fill(pw); await c.getByRole('button', { name: 'Create account' }).click();
    await c.getByRole('heading', { name: 'Linen Tote' }).waitFor();                                                                  // sent back to the product
    await c.getByLabel('Save to favourites').click(); await c.getByLabel('Remove from favourites').waitFor();
    await c.getByRole('button', { name: 'Add to cart' }).click(); await c.getByRole('link', { name: /^Checkout/ }).click();
    await c.getByLabel('Discount code').fill('SAVE10'); await c.getByRole('button', { name: 'Apply' }).click(); await c.getByText('Discount (SAVE10)').waitFor();
    assert.equal(await c.getByLabel('Email').inputValue(), cust);                                                                    // pre-filled from the account
    await noHScroll(c, `${name} checkout`); await shot(c, 'checkout');
    await c.getByRole('button', { name: /Place order/ }).click(); await c.getByRole('button', { name: 'Simulate successful payment' }).click(); await c.waitForURL(/\/order\//);
    await go(c, '/account', 'account'); await c.getByText('Linen Tote', { exact: false }).first().waitFor(); await c.getByRole('heading', { name: 'Favourites' }).waitFor(); await shot(c, 'account');
    await c.getByRole('link', { name: 'Review' }).first().click(); await c.getByRole('heading', { name: 'Review this product' }).waitFor();
    await c.getByRole('button', { name: '5 stars' }).click(); await c.getByLabel('Headline (optional)').fill('Lovely tote'); await c.getByLabel('Your review (optional)').fill('Sturdy and well made.');
    await c.getByRole('button', { name: 'Post review' }).click(); await c.getByText('Thank you. Your review is up.').waitFor();
    await c.getByText('Verified purchase').waitFor(); await noHScroll(c, `${name} reviews`); await shot(c, 'review');

    // --- Seller replies; assistant answers from the data
    await go(s, '/dashboard/reviews', 'reviews'); await s.getByText('Lovely tote').waitFor(); await s.getByRole('button', { name: 'Reply' }).click();
    await s.getByLabel(/Your reply/).fill('Thank you, Cleo!'); await s.getByRole('button', { name: 'Post reply' }).click(); await s.getByText('Your reply').waitFor(); await shot(s, 'reviews');
    await go(s, '/dashboard/assist', 'assist'); await s.getByRole('button', { name: /after costs and platform fees/ }).click(); await s.getByText('How to read this').waitFor();
    await s.getByText('Profit after platform fees').first().waitFor(); await noHScroll(s, `${name} assist`); await shot(s, 'assist');
    if (mobile) { await go(s, '/dashboard/more', 'more'); await s.getByRole('link', { name: /Discounts/ }).waitFor(); await shot(s, 'more'); }
    await go(s, '/dashboard/orders', 'orders'); await s.getByText('counter').first().waitFor();
    console.log(`${name}: stage 3 flow passed`);
    await sc.close(); await cc.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
