// End-to-end: drives the real UI against the real API + Postgres. Usage: node e2e/flow.cjs <screenshotDir>
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
// Minimal PNG encoder: a diagonal two-colour gradient, so uploaded photos are real, renderable images.
function png(w, h, c1, c2) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const t = (x / w + y / h) / 2, o = y * (w * 3 + 1) + 1 + x * 3;
    for (let k = 0; k < 3; k++) raw[o + k] = Math.round(c1[k] + (c2[k] - c1[k]) * t); } }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const out = process.argv[2] ?? '.';
const id = Date.now().toString(36);
const slug = `e2e-${id}`;

async function noHScroll(page, label) {
  // On phone emulation the browser WIDENS innerWidth when content overflows, so "scrollWidth - innerWidth" is always 0 there.
  // Compare against the real device width instead.
  const expected = page.viewportSize().width;
  const m = await page.evaluate(() => ({ iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  assert.ok(m.iw === expected && m.sw <= expected, `${label}: layout is ${m.iw}px wide (content ${m.sw}px) on a ${expected}px screen`);
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
    await p.getByRole('link', { name: 'Settings' }).click();
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
    // Photo upload through the real UI (bad type is refused client-side first)
    await p.getByLabel('Add photos to Oud Noir').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await p.getByRole('alert').filter({ hasText: 'use a JPG, PNG or WebP' }).waitFor();
    await p.getByLabel('Add photos to Oud Noir').setInputFiles({ name: 'oud.png', mimeType: 'image/png', buffer: png(480, 600, [14, 62, 52], [214, 170, 92]) });
    await p.getByLabel('Photos of Oud Noir').locator('img').waitFor();
    // Stock adjustment
    await p.getByRole('button', { name: 'Add one Oud Noir 50ml' }).click();
    await p.getByText('5 in stock').waitFor();

    // 5. A guest shops (separate browser context: no seller session)
    const guest = await browser.newContext({ viewport: vp, isMobile: mobile });
    const g = await guest.newPage();
    await g.goto(`${BASE}/store/${s}`);
    await g.getByRole('heading', { name: `Scented ${s}` }).waitFor();
    await g.getByText(/Pickup · Delivery \$5\.00/).waitFor();
    await g.locator('.pc-img img.a').first().waitFor();   // uploaded photo is shown on the public storefront
    assert.ok(await g.locator('.pc-img img.a').first().evaluate(i => i.complete && i.naturalWidth > 0), 'storefront image failed to load');
    await noHScroll(g, `${name} storefront`);
    await g.screenshot({ path: `${out}/${name}-4-storefront.png`, fullPage: true });
    await g.getByRole('link', { name: /Oud Noir/ }).first().click();       // cards link to the product page (no quick-add on the grid)
    await g.waitForURL('**/p/**');
    await g.getByRole('button', { name: '100ml', exact: true }).click();
    await g.getByRole('button', { name: 'Add to cart' }).click();
    await g.getByRole('link', { name: 'Check out', exact: true }).click();
    await g.locator('.sumline.total').filter({ hasText: '$140.00' }).waitFor();
    await g.getByLabel('Name').fill('Guest Buyer');
    await g.getByLabel('Email').fill('guest@example.test');
    await g.getByLabel('How would you like to receive it?').selectOption('delivery');
    await g.locator('.sumline.total').filter({ hasText: '$145.00' }).waitFor();
    await g.getByLabel('Street address').fill('1 Main St');
    await g.getByLabel('City').fill('Calgary');
    await g.getByLabel('Province').selectOption('AB');
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
    // 8. Spreadsheet import through the real UI: preview flags problems, commit skips them, nothing existing is overwritten
    await p.getByRole('link', { name: 'Import' }).click();
    const csv = 'Product Name,Option,SKU,Price,Cost,Quantity,Brand\nRose Water,,RW-1,12.50,5,10,Maison\nOud Noir,30ml,ON-30,50,20,3,Maison\nBad Row,,BR-1,abc,,2,\nSilk Scarf,,SS-1,45,18,6,';
    await p.getByLabel('CSV file').setInputFiles({ name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await p.getByRole('button', { name: 'Check my file' }).click();
    await p.getByText('2 ready').waitFor();
    await p.getByText('1 with problems').waitFor();
    await p.getByText(/Invalid price "abc"/).waitFor();
    await p.getByText(/already exists/).waitFor();                // "Oud Noir" already in the catalogue
    await noHScroll(p, `${name} import`);
    await p.screenshot({ path: `${out}/${name}-10-import-preview.png`, fullPage: true });
    await p.getByRole('button', { name: 'Import 2 row(s)' }).click();
    await p.getByText(/Imported 2 product\(s\)/).waitFor();
    await p.getByRole('link', { name: 'Products' }).click();
    await p.getByRole('heading', { name: 'Rose Water' }).waitFor();
    await p.getByRole('heading', { name: 'Silk Scarf' }).waitFor();
    assert.equal(await p.getByRole('heading', { name: 'Oud Noir' }).count(), 1, 'existing product must not be duplicated or overwritten');
    await p.screenshot({ path: `${out}/${name}-11-products.png`, fullPage: true });
    // 9. Customer discovery: marketplace shows the new store, search finds the product (typo tolerant), product page adds to the right cart
    await g.goto(`${BASE}/?q=oud%20noirr`);
    await g.getByRole('link', { name: /Oud Noir/ }).first().waitFor();
    await noHScroll(g, `${name} marketplace search`);
    await g.getByRole('link', { name: /Oud Noir/ }).first().click();
    await g.waitForURL('**/p/**');
    await g.locator('h1', { hasText: 'Oud Noir' }).waitFor();
    await g.getByRole('button', { name: 'Add to cart' }).click();
    await g.getByRole('link', { name: 'Check out', exact: true }).waitFor();
    await noHScroll(g, `${name} product page`);
    await g.screenshot({ path: `${out}/${name}-12-product-page.png`, fullPage: true });
    await seller.close(); await guest.close();
    console.log(`✓ ${name}: full flow passed`);
  }
  await browser.close();
})().catch(e => { console.error('✗ E2E FAILED:', e.message); process.exit(1); });
