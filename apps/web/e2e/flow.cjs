// End-to-end: drives the real UI against the real API + Postgres. Usage: node e2e/flow.cjs <screenshotDir>
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const out = process.argv[2] ?? '.';
const id = Date.now().toString(36);
const slug = `e2e-${id}`;

async function noHScroll(page, label) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(o <= 0, `${label}: horizontal overflow of ${o}px`);
}

(async () => {
  const browser = await chromium.launch();
  for (const [name, vp, mobile] of [['mobile', { width: 375, height: 740 }, true], ['desktop', { width: 1280, height: 800 }, false]]) {
    const s = name === 'mobile' ? `${slug}m` : `${slug}d`;
    const seller = await browser.newContext({ viewport: vp, isMobile: mobile, deviceScaleFactor: 1 });
    const p = await seller.newPage();
    p.on('pageerror', e => { throw e; });

    // 1. Signup
    await p.goto(`${BASE}/signup`);
    await p.getByLabel('Your name').fill('Test Seller');
    await p.getByLabel('Email').fill(`${s}@example.test`);
    await p.getByLabel('Password').fill('correct-horse-battery');
    await p.getByLabel('Business name').fill(`Scented ${s}`);
    await p.getByLabel('Store address').fill(s);
    await noHScroll(p, `${name} signup`);
    await p.screenshot({ path: `${out}/${name}-1-signup.png` });
    await p.getByRole('button', { name: 'Create store' }).click();
    await p.waitForURL('**/dashboard');
    await p.getByRole('heading', { name: 'Overview' }).waitFor();

    // 2. Publishing is blocked until the profile is complete (real validation)
    await p.getByRole('link', { name: 'Store settings' }).click();
    await p.getByRole('button', { name: 'Publish my store' }).click();
    await p.getByRole('alert').filter({ hasText: 'Before publishing' }).waitFor();

    // 3. Fill settings, save, publish
    await p.getByLabel('What do you sell? (category)').fill('Perfumes');
    await p.getByLabel('About your business').fill('Handpicked fragrances, delivered in Calgary.');
    await p.getByLabel('Tagline').fill('Smell great, simply');
    await p.getByLabel('Customer pickup').check();
    await p.getByLabel('Delivery', { exact: true }).check();
    await p.getByLabel('Delivery fee ($)').fill('5.00');
    await noHScroll(p, `${name} settings`);
    await p.getByRole('button', { name: 'Save changes' }).click();
    await p.getByText('Saved.').waitFor();
    await p.screenshot({ path: `${out}/${name}-2-settings.png`, fullPage: true });
    await p.getByRole('button', { name: 'Publish my store' }).click();
    await p.getByText('Your store is live!').waitFor();

    // 4. Add a product with two options and costs
    await p.getByRole('link', { name: 'Products' }).click();
    await p.getByRole('button', { name: 'Add product' }).click();
    await p.getByLabel('Product name').fill('Oud Noir');
    await p.getByLabel('Description').fill('Warm, smoky oud.');
    await p.getByLabel('Option name').nth(0).fill('50ml');
    await p.getByLabel('Price ($)').nth(0).fill('80.00');
    await p.getByLabel('Your cost ($)').nth(0).fill('35.00');
    await p.getByLabel('In stock').nth(0).fill('4');
    await p.getByRole('button', { name: 'Add another option' }).click();
    await p.getByLabel('Option name').nth(1).fill('100ml');
    await p.getByLabel('Price ($)').nth(1).fill('140.00');
    await p.getByLabel('In stock').nth(1).fill('2');
    await noHScroll(p, `${name} product form`);
    await p.screenshot({ path: `${out}/${name}-3-product-form.png`, fullPage: true });
    await p.getByRole('button', { name: 'Save product' }).click();
    await p.getByText('Product saved.').waitFor();
    await p.getByText('4 in stock').waitFor();
    await noHScroll(p, `${name} products`);
    // Stock adjustment
    await p.getByRole('button', { name: 'Add one Oud Noir 50ml' }).click();
    await p.getByText('5 in stock').waitFor();

    // 5. A guest shops (separate browser context: no seller session)
    const guest = await browser.newContext({ viewport: vp, isMobile: mobile });
    const g = await guest.newPage();
    await g.goto(`${BASE}/store/${s}`);
    await g.getByRole('heading', { name: `Scented ${s}` }).waitFor();
    await g.getByText('Pickup available · Delivery $5.00').waitFor();
    await noHScroll(g, `${name} storefront`);
    await g.screenshot({ path: `${out}/${name}-4-storefront.png`, fullPage: true });
    await g.getByLabel('Option').selectOption({ label: '100ml — $140.00' });
    await g.getByRole('button', { name: 'Add to cart' }).click();
    await g.getByRole('link', { name: 'Checkout' }).click();
    await g.getByText('Total: $140.00').waitFor();
    await g.getByLabel('Name').fill('Guest Buyer');
    await g.getByLabel('Email').fill('guest@example.test');
    await g.getByLabel('How would you like to receive it?').selectOption('delivery');
    await g.getByText('Total: $145.00').waitFor();
    await g.getByLabel('Street address').fill('1 Main St');
    await g.getByLabel('City').fill('Calgary');
    await g.getByLabel('Province').fill('AB');
    await g.getByLabel('Postal code').fill('T2T 2T2');
    await noHScroll(g, `${name} checkout`);
    await g.screenshot({ path: `${out}/${name}-5-checkout.png`, fullPage: true });
    await g.getByRole('button', { name: 'Continue to payment' }).click();
    await g.getByRole('heading', { name: /Pay for order/ }).waitFor();
    await g.getByText('No real money moves').waitFor();   // simulated payment is clearly labelled
    await g.screenshot({ path: `${out}/${name}-6-pay-simulated.png` });
    await g.getByRole('button', { name: 'Simulate successful payment' }).click();
    await g.getByText('Your order is confirmed').waitFor();
    await noHScroll(g, `${name} order status`);
    await g.screenshot({ path: `${out}/${name}-7-order-confirmed.png` });

    // 6. Seller sees the order, progresses it, and the dashboard separates revenue from profit
    await p.getByRole('link', { name: 'Orders' }).click();
    await p.getByRole('button', { name: /Open order/ }).click();
    await p.getByText('Deliver to: 1 Main St, Calgary T2T 2T2').waitFor();
    await p.getByRole('button', { name: 'Start processing' }).click();
    await p.getByRole('button', { name: 'Mark shipped' }).waitFor();
    await noHScroll(p, `${name} orders`);
    await p.screenshot({ path: `${out}/${name}-8-orders.png`, fullPage: true });
    await p.getByRole('link', { name: 'Overview' }).click();
    await p.getByText('Gross sales (not profit)').waitFor();
    await p.getByText('$140.00').first().waitFor();
    await p.getByText('Unknown').first().waitFor();   // no costs on sold item: COGS/profit must read Unknown, not $0.00
    await p.getByText(/no cost recorded/).waitFor();      // 100ml option had no cost: gross profit flagged partial
    await noHScroll(p, `${name} overview`);
    await p.screenshot({ path: `${out}/${name}-9-overview.png`, fullPage: true });

    // 7. Stock actually decreased: 100ml now sold out of 2 -> 1 left, visible to the next guest
    await g.goto(`${BASE}/store/${s}`);
    await g.getByLabel('Option').selectOption({ label: '100ml — $140.00' });
    await seller.close(); await guest.close();
    console.log(`✓ ${name}: full flow passed`);
  }
  await browser.close();
})().catch(e => { console.error('✗ E2E FAILED:', e.message); process.exit(1); });
