// End-to-end #3: email verification, sales tax at checkout, password reset by email link, and seller two-factor, through the real UI.
// Emails are read from the outbox table (the app runs in "simulated" mail mode in development), so the links used are the real ones.
// Needs: API :3000 and web :5173 running, local Postgres owner access (default dev credentials).
// Usage: node e2e/flow3.cjs <screenshotDir>
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('../../api/node_modules/pg');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://eazy_owner:owner_pw@localhost:5432/eazystores';
const out = process.argv[2] ?? '.';
const id = Date.now().toString(36);

async function latestMail(to, template) {
  const c = new Client({ connectionString: DB }); await c.connect();
  try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_admin','on',true)`);
    const r = await c.query('SELECT text_body FROM email_outbox WHERE to_email=$1 AND template=$2 ORDER BY created_at DESC LIMIT 1', [to, template]); await c.query('COMMIT'); return r.rows[0]?.text_body; }
  finally { await c.end(); }
}
const pathOf = text => { const u = new URL(/https?:\/\/\S+/.exec(text)[0]); return u.pathname + u.search; };
function b32decode(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const o = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); }
function code(secret, off = 0) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + off)); const h = crypto.createHmac('sha1', b32decode(secret)).update(b).digest(); const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); }
async function noHScroll(page, label) {
  // Phone emulation widens innerWidth when content overflows, so compare with the real device width.
  const expected = page.viewportSize().width;
  const m = await page.evaluate(() => ({ iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  assert.ok(m.iw === expected && m.sw <= expected, `${label}: layout is ${m.iw}px wide (content ${m.sw}px) on a ${expected}px screen`);
}

let browser, cur;
(async () => {
  browser = await chromium.launch();
  for (const [name, vp, mobile] of [['desktop', { width: 1280, height: 860 }, false], ['mobile', { width: 390, height: 800 }, true]].filter(v => !process.env.ONLY || v[0] === process.env.ONLY)) {
    const slug = `t3-${id}${name[0]}`; const email = `${slug}@example.test`; const pw1 = 'correct-horse-battery'; const pw2 = 'a-brand-new-password-9';
    const sc = await browser.newContext({ viewport: vp, isMobile: mobile }); const p = await sc.newPage(); cur = p; p.on('pageerror', e => { throw e; });
    if (process.env.DEBUG_AUTH) p.on('response', r => { if (r.url().includes('/api/auth/')) console.log('  ', r.status(), r.request().method(), r.url().replace(BASE, '')); });

    // --- Signup, then confirm the email through the emailed link
    await p.goto(`${BASE}/signup`);
    await p.getByLabel('Your name').fill('Tax Seller'); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(pw1);
    await p.getByLabel('Business name').fill(`Tax ${slug}`); await p.getByLabel('Store address').fill(slug);
    await p.getByRole('checkbox', { name: /I agree to the/ }).check();
    await p.getByRole('button', { name: 'Create store' }).click(); await p.waitForURL('**/dashboard');
    await p.getByText(/Confirm your email address to publish/).waitFor();
    await noHScroll(p, `${name} dashboard with verification banner`); await p.screenshot({ path: `${out}/${name}-y1-verify-banner.png`, fullPage: true });
    const vlink = pathOf(await latestMail(email, 'verify_email'));
    const vp2 = await sc.newPage(); await vp2.goto(BASE + vlink); await vp2.getByRole('heading', { name: 'Email confirmed' }).waitFor();
    await vp2.goto(BASE + vlink); await vp2.getByRole('heading', { name: 'That link did not work' }).waitFor();   // one use only
    await vp2.close(); await p.reload(); await p.getByRole('heading', { name: 'Overview' }).waitFor();
    assert.equal(await p.getByText(/Confirm your email address to publish/).count(), 0, 'banner should disappear once verified');

    // --- Settings: province, GST/HST, delivery; publish
    await p.getByRole('link', { name: 'Settings' }).click();
    await p.getByLabel('What do you sell? (category)').fill('Gifts'); await p.getByLabel('About your business', { exact: true }).fill('Gifts and candles.');
    await p.getByLabel('Province', { exact: true }).selectOption('AB');
    await p.getByLabel('Customer pickup').check(); await p.getByLabel('Delivery', { exact: true }).check(); await p.getByLabel('Delivery fee ($)').fill('5.00');
    await p.getByLabel(/registered to collect GST\/HST/).check(); await p.getByLabel('GST/HST number').fill('123456789RT0001');
    await noHScroll(p, `${name} settings with tax`); await p.screenshot({ path: `${out}/${name}-y2-settings-tax.png`, fullPage: true });
    await p.getByRole('button', { name: 'Save changes' }).click(); await p.getByText('Saved.').waitFor();
    await p.getByRole('button', { name: 'Publish my store' }).click(); await p.getByText('Your store is live!').waitFor();
    // tax needs a province: clearing it while tax is on is refused with a clear message
    await p.getByLabel('Province', { exact: true }).selectOption(''); await p.getByRole('button', { name: 'Save changes' }).click();
    await p.getByRole('alert').filter({ hasText: 'Choose your province' }).waitFor(); await p.getByLabel('Province', { exact: true }).selectOption('AB');
    await p.getByRole('button', { name: 'Save changes' }).click(); await p.getByText('Saved.').waitFor();
    // a product via the API on the same signed-in session
    const made = await p.request.post(`${BASE}/api/seller/products`, { data: { name: 'Candle', status: 'active', variants: [{ priceCents: 2000, costCents: 700, stock: 20 }] } }); assert.equal(made.status(), 201);

    // --- Customer: the cart shows the tax BEFORE paying, and it follows the delivery province
    const gc = await browser.newContext({ viewport: vp, isMobile: mobile }); const g = await gc.newPage();
    await g.goto(`${BASE}/store/${slug}`); await g.getByRole('link', { name: /Candle/ }).first().click(); await g.waitForURL('**/p/**');
    await g.getByRole('button', { name: 'Add to cart' }).click(); await g.getByRole('link', { name: 'Check out', exact: true }).click();
    await g.locator('.sumline').filter({ hasText: 'GST' }).waitFor();                                                 // pickup: seller province AB, GST 5% of $20
    assert.match(await g.locator('.sumline.total').innerText(), /\$21\.00/);
    await g.getByLabel('How would you like to receive it?').selectOption('delivery');
    await g.getByText('Choose your province so we can work out tax.').waitFor();                                       // delivery needs a destination province
    await g.getByLabel('Street address').fill('1 Main St'); await g.getByLabel('City').fill('Toronto'); await g.getByLabel('Postal code').fill('M5V 2T6');
    await g.getByLabel('Province').selectOption('ON');
    await g.locator('.sumline').filter({ hasText: 'HST' }).waitFor();                                                  // ($20 + $5 delivery) x 13% = $3.25
    assert.match(await g.locator('.sumline.total').innerText(), /\$28\.25/);
    await noHScroll(g, `${name} checkout with tax`); await g.screenshot({ path: `${out}/${name}-y3-checkout-tax.png`, fullPage: true });
    await g.getByLabel('How would you like to receive it?').selectOption('pickup');
    await g.locator('.sumline').filter({ hasText: 'GST' }).waitFor();
    await g.getByLabel('Name', { exact: true }).fill('Tax Buyer'); await g.getByLabel('Email').fill('taxbuyer@example.test');
    await g.getByRole('button', { name: 'Continue to payment' }).click();
    await g.getByRole('button', { name: 'Simulate successful payment' }).click(); await g.getByText('Your order is confirmed').waitFor();
    await g.getByRole('cell', { name: 'GST' }).waitFor(); await noHScroll(g, `${name} order page with tax`);
    const confirmation = await latestMail('taxbuyer@example.test', 'order_confirmation'); assert.ok(/GST \$1\.00/.test(confirmation) && /Total \$21\.00/.test(confirmation), 'confirmation email should show tax and total');
    await gc.close();

    // --- Seller sees the tax on the order and as money owed to the tax authority, not income
    await p.getByRole('link', { name: 'Orders' }).click(); await p.getByRole('button', { name: /Open order/ }).click(); await p.getByRole('cell', { name: 'GST' }).waitFor();
    await p.getByRole('link', { name: 'Overview' }).click(); await p.getByText('Tax collected (owed to the tax authority)').waitFor();
    await noHScroll(p, `${name} overview with tax`); await p.screenshot({ path: `${out}/${name}-y4-overview-tax.png`, fullPage: true });

    // --- Forgot password: emailed link, new password, signed out everywhere, link works once
    await p.getByRole('button', { name: 'Log out' }).first().click(); await p.waitForURL(BASE + '/');
    await p.goto(`${BASE}/login`); await p.getByRole('link', { name: 'Forgot your password?' }).click();
    await p.getByRole('heading', { name: 'Reset your password' }).waitFor();          // wait for the page change before typing
    await p.getByLabel('Email').fill(email); await p.getByRole('button', { name: 'Email me a link' }).click(); await p.getByText(/we have emailed a link/).waitFor();
    await noHScroll(p, `${name} forgot password`);
    const rlink = pathOf(await latestMail(email, 'reset_password'));
    await p.goto(BASE + rlink); await p.getByLabel('New password', { exact: true }).fill(pw2); await p.getByLabel('Repeat the new password').fill(pw2 + 'x'); await p.getByRole('button', { name: 'Change password' }).click();
    await p.getByRole('alert').filter({ hasText: 'do not match' }).waitFor();
    await p.getByLabel('Repeat the new password').fill(pw2); await p.getByRole('button', { name: 'Change password' }).click(); await p.getByText(/signed out everywhere/).waitFor();
    await p.goto(BASE + rlink); await p.getByLabel('New password', { exact: true }).fill('yet-another-password-1'); await p.getByLabel('Repeat the new password').fill('yet-another-password-1'); await p.getByRole('button', { name: 'Change password' }).click();
    await p.getByRole('alert').filter({ hasText: 'expired or was already used' }).waitFor();                           // single use
    await p.goto(`${BASE}/login`); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(pw1); await p.getByRole('button', { name: 'Log in' }).click();
    await p.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();                                              // old password no longer works
    await p.getByLabel('Password').fill(pw2); await p.getByRole('button', { name: 'Log in' }).click(); await p.waitForURL('**/dashboard');

    // --- Seller turns on two-factor, then signs in with a code
    await p.getByRole('link', { name: 'Settings' }).click(); await p.getByRole('button', { name: 'Set up two-factor' }).click();
    const secret = (await p.locator('.secretkey').innerText()).trim();
    await noHScroll(p, `${name} two-factor setup`); await p.screenshot({ path: `${out}/${name}-y5-mfa-setup.png`, fullPage: true });
    await p.getByLabel('6-digit code').fill(code(secret)); await p.getByRole('button', { name: 'Turn on two-factor' }).click();
    await p.getByRole('heading', { name: 'Save your recovery codes' }).waitFor(); assert.equal(await p.getByLabel('Recovery codes').locator('code').count(), 10);
    await p.getByLabel('I have saved these codes').check(); await p.getByRole('button', { name: 'Continue' }).click();
    await p.getByRole('button', { name: 'Log out' }).first().click(); await p.waitForURL(BASE + '/');
    await p.goto(`${BASE}/login`); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(pw2); await p.getByRole('button', { name: 'Log in' }).click();
    await p.getByRole('heading', { name: 'Enter your code' }).waitFor(); assert.equal(await p.getByRole('heading', { name: 'Overview' }).count(), 0, 'no dashboard before the code');
    await noHScroll(p, `${name} two-factor prompt`);
    await p.getByLabel('6-digit code').fill('123456'); await p.getByRole('button', { name: 'Verify' }).click(); await p.getByRole('alert').filter({ hasText: 'not right' }).waitFor();
    await p.getByLabel('6-digit code').fill(code(secret, 1)); await p.getByRole('button', { name: 'Verify' }).click(); await p.waitForURL('**/dashboard'); await p.getByRole('heading', { name: 'Overview' }).waitFor();
    await sc.close();
    console.log(`✓ ${name}: verification, tax, reset, two-factor passed`);
  }
  await browser.close();
})().catch(async e => { console.error('✗ E2E3 FAILED:', e.message); try { if (cur) await cur.screenshot({ path: `${out}/FAIL-flow3.png`, fullPage: true }); } catch { /* page already closed */ } process.exit(1); });
