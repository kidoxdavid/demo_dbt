// End-to-end #2: customisation, share links/QR, refunds and the admin area, driven through the real UI + API + Postgres.
// Needs: API on :3000, web on :5173, and a staff account:
//   (cd apps/api && npm run make-staff -- e2e-admin@eazystores.test super_admin e2e-admin-password-1)
// Usage: node e2e/flow2.cjs <screenshotDir>
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const out = process.argv[2] ?? '.';
const id = Date.now().toString(36);
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

// TOTP (RFC 6238) so the test can act as an authenticator app.
function b32decode(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function code(secret, offsetSteps = 0) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offsetSteps));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest(); const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0');
}
const ADMIN = { email: 'e2e-admin@eazystores.test', password: 'e2e-admin-password-1' };
const admin = { secret: null, recovery: [] };
async function passwordStep(a) {
  await a.goto(`${BASE}/login`); await a.getByLabel('Email').fill(ADMIN.email); await a.getByLabel('Password').fill(ADMIN.password); await a.getByRole('button', { name: 'Log in' }).click();
}
/** First run enrols (QR secret read from the page, recovery codes saved); later sign-ins use a TOTP code or a one-time recovery code. */
async function adminSignIn(a, how) {
  await passwordStep(a);
  if (!admin.secret) {
    await a.waitForURL('**/admin');
    await a.getByRole('heading', { name: 'Set up two-factor sign-in' }).waitFor();                            // nothing else loads until two-factor is on
    await a.getByRole('button', { name: 'Set up two-factor' }).click();
    admin.secret = (await a.locator('.secretkey').innerText()).trim();
    await a.getByLabel('6-digit code').fill('000000'); await a.getByRole('button', { name: 'Turn on two-factor' }).click(); await a.getByRole('alert').filter({ hasText: 'not right' }).waitFor();
    await a.getByLabel('6-digit code').fill(code(admin.secret)); await a.getByRole('button', { name: 'Turn on two-factor' }).click();
    await a.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
    admin.recovery = await a.getByLabel('Recovery codes').locator('code').allInnerTexts(); assert.equal(admin.recovery.length, 10);
    await a.getByLabel('I have saved these codes').check(); await a.getByRole('button', { name: 'Continue' }).click();
    await a.getByRole('heading', { name: 'Platform overview' }).waitFor(); return;
  }
  await a.getByRole('heading', { name: 'Enter your code' }).waitFor();
  if (how === 'recovery') { await a.getByRole('button', { name: 'Use a recovery code instead' }).click(); await a.getByLabel('Recovery code').fill(admin.recovery.pop()); }
  else await a.getByLabel('6-digit code').fill(code(admin.secret, 1));       // the enrolment code used this 30s step; the next step is valid immediately
  await a.getByRole('button', { name: 'Verify' }).click(); await a.waitForURL('**/admin'); await a.getByRole('heading', { name: 'Platform overview' }).waitFor();
}

function png(w, h, c1, c2) { // minimal real PNG (gradient) so uploads are renderable
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const t = (x / w + y / h) / 2, o = y * (w * 3 + 1) + 1 + x * 3; for (let k = 0; k < 3; k++) raw[o + k] = Math.round(c1[k] + (c2[k] - c1[k]) * t); } }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function noHScroll(page, label) {
  // On phone emulation the browser WIDENS innerWidth when content overflows, so "scrollWidth - innerWidth" is always 0 there.
  // Compare against the real device width instead.
  const expected = page.viewportSize().width;
  const m = await page.evaluate(() => ({ iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  assert.ok(m.iw === expected && m.sw <= expected, `${label}: layout is ${m.iw}px wide (content ${m.sw}px) on a ${expected}px screen`);
}

(async () => {
  execFileSync('npm', ['run', 'reset-mfa', '--silent', '--', ADMIN.email], { cwd: `${__dirname}/../../api`, stdio: 'pipe' });   // start from a known state
  const browser = await chromium.launch();
  for (const [name, vp, mobile] of [['desktop', { width: 1280, height: 860 }, false], ['mobile', { width: 390, height: 800 }, true]]) {
    const slug = `cx-${id}${name[0]}`;
    const sc = await browser.newContext({ viewport: vp, isMobile: mobile }); const p = await sc.newPage();
    p.on('pageerror', e => { throw e; });

    // --- Seller: signup, profile, publish
    await p.goto(`${BASE}/signup`);
    await p.getByLabel('Your name').fill('Maker'); await p.getByLabel('Email').fill(`${slug}@example.test`); await p.getByLabel('Password').fill('correct-horse-battery');
    await p.getByLabel('Business name').fill(`Custom ${slug}`); await p.getByLabel('Store address').fill(slug);
    await p.getByRole('button', { name: 'Create store' }).click(); await p.waitForURL('**/dashboard');
    await p.getByRole('link', { name: 'Settings' }).click();
    await p.getByLabel('What do you sell? (category)').fill('Personalised gifts'); await p.getByLabel('About your business').fill('Made to order gifts.');
    await p.getByLabel('Customer pickup').check(); await p.getByRole('button', { name: 'Save changes' }).click();
    await p.getByText('Saved.').waitFor(); await p.getByRole('button', { name: 'Publish my store' }).click(); await p.getByText('Your store is live!').waitFor();

    // --- Seller: made-to-order product with customer options
    await p.getByRole('link', { name: 'Products' }).click(); await p.getByRole('button', { name: 'Add product' }).click();
    await p.getByLabel('Product name').fill('Name Plate'); await p.getByLabel('Option name').nth(0).fill('Standard'); await p.getByLabel('Price ($)').nth(0).fill('40.00'); await p.getByLabel('Your cost ($)').nth(0).fill('12.00'); await p.getByLabel('In stock').nth(0).fill('0');
    await p.getByLabel(/Made to order/).check();
    await p.getByRole('button', { name: 'Add a customer option' }).click();
    await p.getByLabel('Question or label').nth(0).fill('Name to print');
    await p.getByLabel('Customer must answer').nth(0).check();
    await p.getByRole('button', { name: 'Add a customer option' }).click();
    await p.getByLabel('Question or label').nth(1).fill('Colour'); await p.getByLabel('Answer type').nth(1).selectOption('select'); await p.getByLabel('Choices (separate with commas)').fill('Black, White'); await p.getByLabel('Customer must answer').nth(1).check();
    await p.getByRole('button', { name: 'Add a customer option' }).click();
    await p.getByLabel('Question or label').nth(2).fill('Reference photo'); await p.getByLabel('Answer type').nth(2).selectOption('image');
    await noHScroll(p, `${name} product form with options`);
    await p.screenshot({ path: `${out}/${name}-x1-product-options.png`, fullPage: true });
    await p.getByRole('button', { name: 'Save product' }).click(); await p.getByText(/Product saved/).waitFor();

    // --- Seller: share page (channel-tagged link + QR that really renders)
    await p.getByRole('link', { name: 'Share', exact: true }).click(); await p.getByRole('heading', { name: 'Share' }).waitFor();
    await p.getByLabel('Where will you share it?').selectOption('whatsapp');
    const link = await p.getByLabel('Store link').inputValue(); assert.match(link, new RegExp(`/store/${slug}\\?src=whatsapp$`));
    const qrImg = p.getByRole('img', { name: /QR code for/ }); await qrImg.waitFor();
    assert.ok(await qrImg.evaluate(i => i.complete && i.naturalWidth > 0), 'QR image failed to load');
    await noHScroll(p, `${name} share page`); await p.screenshot({ path: `${out}/${name}-x2-share.png`, fullPage: true });

    // --- Customer arrives via the WhatsApp link, must fill required options, uploads a photo, pays
    const gc = await browser.newContext({ viewport: vp, isMobile: mobile }); const g = await gc.newPage();
    await g.goto(`${BASE}/store/${slug}?src=whatsapp`);
    await g.getByRole('link', { name: /Name Plate/ }).first().click(); await g.waitForURL('**/p/**');
    await g.getByText('Make it yours').waitFor();
    await g.getByRole('button', { name: 'Add to cart' }).click();
    await g.getByRole('alert').filter({ hasText: 'Name to print' }).waitFor();              // client-side required check
    await g.getByLabel(/Name to print/).fill('MAYA');
    await g.getByRole('button', { name: 'Add to cart' }).click();
    await g.getByRole('alert').filter({ hasText: 'Colour' }).waitFor();
    await g.getByLabel(/^Colour/).selectOption('White');
    await g.getByLabel(/Reference photo/).setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('nope') });
    await g.getByRole('alert').filter({ hasText: 'JPG, PNG or WebP' }).waitFor();
    await g.getByLabel(/Reference photo/).setInputFiles({ name: 'sketch.png', mimeType: 'image/png', buffer: png(300, 300, [20, 20, 20], [200, 160, 90]) });
    await g.getByText('Attached: sketch.png').waitFor();
    await noHScroll(g, `${name} product page with options`); await g.screenshot({ path: `${out}/${name}-x3-customer-options.png`, fullPage: true });
    await g.getByRole('button', { name: 'Add to cart' }).click();
    await g.getByRole('link', { name: 'Check out', exact: true }).click();
    await g.getByText('Name to print: MAYA').waitFor(); await g.getByText('Reference photo: photo attached').waitFor();
    await noHScroll(g, `${name} checkout with customised line`);
    await g.getByLabel('Name', { exact: true }).fill('Gift Buyer'); await g.getByLabel('Email').fill('gift@example.test');
    await g.getByRole('button', { name: 'Continue to payment' }).click();
    await g.getByRole('button', { name: 'Simulate successful payment' }).click(); await g.getByText('Your order is confirmed').waitFor();

    // --- Seller: sees the customer's answers and photo; partial refund through the UI
    await p.getByRole('link', { name: 'Orders' }).click(); await p.getByRole('button', { name: /Open order/ }).click();
    await p.getByText('MAYA').first().waitFor(); await p.getByText('White').first().waitFor();
    const photo = p.getByRole('img', { name: /Reference photo from customer/ }); await photo.waitFor();
    assert.ok(await photo.evaluate(i => i.complete && i.naturalWidth > 0), 'customer photo failed to load for the seller');
    p.once('dialog', d => d.accept());
    await p.getByLabel('Amount ($)').fill('10.00'); await p.getByLabel(/Reason/).fill('Goodwill for a delayed reply');
    await noHScroll(p, `${name} order with answers and refund form`); await p.screenshot({ path: `${out}/${name}-x4-order-refund.png`, fullPage: true });
    await p.getByRole('button', { name: /^Refund \$10\.00$/ }).click();
    await p.getByText(/Goodwill for a delayed reply/).waitFor(); await p.getByText(/Refunded so far \$10\.00/).waitFor();
    // asking for more than is refundable is blocked in the UI (and by the server)
    await p.getByLabel('Amount ($)').fill('500.00'); await p.getByLabel(/Reason/).fill('Too much on purpose');
    assert.ok(await p.getByRole('button', { name: /^Refund \$500\.00$/ }).isDisabled(), 'refund above the remaining amount must be disabled');
    await p.getByRole('link', { name: 'Overview' }).click();
    await p.getByText('Sales by channel').waitFor(); await p.getByRole('cell', { name: 'whatsapp' }).waitFor();   // order attributed to the WhatsApp link
    await p.getByText('Refunds on open sales').waitFor();
    await noHScroll(p, `${name} overview with channels`); await p.screenshot({ path: `${out}/${name}-x5-overview-channels.png`, fullPage: true });
    await sc.close(); await gc.close();
    console.log(`✓ ${name}: customisation, share, refund passed`);
  }

  // --- Admin area (staff account created beforehand)
  for (const [name, vp, mobile] of [['desktop', { width: 1280, height: 860 }, false], ['mobile', { width: 390, height: 800 }, true]]) {
    const target = `cx-${id}${name[0]}`;
    const ac = await browser.newContext({ viewport: vp, isMobile: mobile }); const a = await ac.newPage(); a.on('pageerror', e => { throw e; });
    if (!mobile) {
      await adminSignIn(a, 'enrol');                                                                               // first sign-in: forced two-factor setup
      await a.getByRole('button', { name: 'Log out' }).first().click(); await a.waitForURL(BASE + '/');
      await adminSignIn(a, 'totp');                                                                                // then a normal sign-in with an authenticator code
    } else { await adminSignIn(a, 'recovery'); }                                                                   // phone run uses a one-time recovery code
    await a.getByText('Gross merchandise value').waitFor();
    await noHScroll(a, `${name} admin overview`); await a.screenshot({ path: `${out}/${name}-x6-admin-overview.png`, fullPage: true });
    await a.getByRole('link', { name: 'Sellers' }).click(); await a.getByLabel(/Search by business name/).fill(target);
    await a.getByRole('cell', { name: new RegExp(`Custom ${target}`) }).waitFor();
    await noHScroll(a, `${name} admin sellers`);
    await a.getByRole('button', { name: 'Suspend' }).click();
    assert.ok(await a.getByRole('button', { name: 'Suspend seller' }).isDisabled(), 'suspend needs a reason');
    await a.getByLabel(/Reason/).fill('Prohibited item reports under review');
    await a.getByRole('button', { name: 'Suspend seller' }).click(); await a.getByText(/Seller suspended/).waitFor();
    await noHScroll(a, `${name} admin sellers after suspend`);
    const gone = await a.request.get(`${BASE}/api/public/stores/${target}`); assert.equal(gone.status(), 404, 'suspended store must be hidden');
    await a.getByRole('button', { name: 'Reinstate' }).click(); await a.getByLabel(/Reason/).fill('Appeal accepted after review'); await a.getByRole('button', { name: 'Reinstate seller' }).click(); await a.getByText(/Seller reinstated/).waitFor();
    await a.getByRole('link', { name: 'Audit log' }).click(); await a.getByText('seller.suspend').first().waitFor(); await a.getByText('Prohibited item reports under review').first().waitFor();
    await noHScroll(a, `${name} admin audit`); await a.screenshot({ path: `${out}/${name}-x7-admin-audit.png`, fullPage: true });
    await a.getByRole('link', { name: 'Plans' }).click(); await a.getByRole('heading', { name: 'Starter' }).waitFor(); await noHScroll(a, `${name} admin plans`);
    await a.getByRole('link', { name: 'Featured' }).click(); await a.getByRole('heading', { name: 'Featured maker' }).waitFor(); await noHScroll(a, `${name} admin featured`);
    await ac.close();
    console.log(`✓ ${name}: admin passed`);
  }
  await browser.close();
})().catch(e => { console.error('✗ E2E2 FAILED:', e.message); process.exit(1); });
