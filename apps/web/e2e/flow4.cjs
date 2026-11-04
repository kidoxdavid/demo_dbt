// End-to-end #4: governance. Store review, rejection and approval, verified badge, product moderation, storefront search and paging,
// legal pages, and seller account closure, all through the real UI with a staff account that must use two-factor.
// Usage: ONLY=desktop|mobile node e2e/flow4.cjs <screenshotDir>    (needs API :3000, web :5173, and the e2e staff user from flow2's header)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('../../api/node_modules/pg');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://eazy_owner:owner_pw@localhost:5432/eazystores';
const out = process.argv[2] ?? '.';
const id = Date.now().toString(36);
const ADMIN = { email: 'e2e-admin@eazystores.test', password: 'e2e-admin-password-1' };

async function sql(text, params = []) {
  const c = new Client({ connectionString: DB }); await c.connect();
  try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_admin','on',true)`); const r = await c.query(text, params); await c.query('COMMIT'); return r.rows; } finally { await c.end(); }
}
function b32(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const o = []; for (const ch of s.toUpperCase()) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); }
const totp = secret => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = crypto.createHmac('sha1', b32(secret)).update(b).digest(); const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); };
async function noHScroll(page, label) {
  const expected = page.viewportSize().width; const m = await page.evaluate(() => ({ iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  assert.ok(m.iw === expected && m.sw <= expected, `${label}: layout is ${m.iw}px wide (content ${m.sw}px) on a ${expected}px screen`);
}

// On phones the tab bar shows five items; the rest live under More.
async function openNav(page, name, exact = false) {
  if (page.viewportSize().width < 900) await page.getByRole('link', { name: 'More', exact: true }).click();
  await page.getByRole('link', { name, exact }).first().click();
}
let browser; const pages = {};
(async () => {
  execFileSync('npm', ['run', 'reset-mfa', '--silent', '--', ADMIN.email], { cwd: `${__dirname}/../../api`, stdio: 'pipe' });
  browser = await chromium.launch();
  for (const [name, vp, mobile] of [['desktop', { width: 1280, height: 860 }, false], ['mobile', { width: 390, height: 800 }, true]].filter(v => !process.env.ONLY || v[0] === process.env.ONLY)) {
    const slug = `gv-${id}${name[0]}`; const biz = `Review ${slug}`; const email = `${slug}@example.test`; const pw = 'correct-horse-battery';
    const ac = await browser.newContext({ viewport: vp, isMobile: mobile }); const a = await ac.newPage(); a.on('pageerror', e => { throw e; });
    const sc = await browser.newContext({ viewport: vp, isMobile: mobile }); const p = await sc.newPage();
    const gc = await browser.newContext({ viewport: vp, isMobile: mobile }); const g = await gc.newPage(); pages.admin = a; pages.seller = p; pages.shopper = g;
    const card = (page, text) => page.locator('section.card').filter({ hasText: text });
    const adminLink = async label => { await a.getByRole('link', { name: label, exact: true }).first().click(); };

    // --- Staff sign in (forced two-factor setup on first use)
    await a.goto(`${BASE}/login`); await a.getByLabel('Email').fill(ADMIN.email); await a.getByLabel('Password').fill(ADMIN.password); await a.getByRole('button', { name: 'Log in' }).click();
    await a.getByRole('heading', { name: 'Set up two-factor sign-in' }).waitFor(); await a.getByRole('button', { name: 'Set up two-factor' }).click();
    const secret = (await a.locator('.secretkey').innerText()).trim(); await a.getByLabel('6-digit code').fill(totp(secret)); await a.getByRole('button', { name: 'Turn on two-factor' }).click();
    await a.getByLabel('I have saved these codes').check(); await a.getByRole('button', { name: 'Continue' }).click(); await a.getByRole('heading', { name: 'Platform overview' }).waitFor();

    // --- Staff turn on "store review" (needs a reason)
    await adminLink('Review queue'); await a.getByRole('heading', { name: 'Review queue' }).waitFor();
    await a.getByRole('button', { name: /^Turn (on|off)$/ }).waitFor();                                                                // the control only appears once the real value is known
    if (await a.getByRole('button', { name: 'Turn off' }).count()) { await a.getByRole('button', { name: 'Turn off' }).click(); await a.getByLabel('Reason for this change').fill('Resetting before the test'); await a.getByRole('button', { name: 'Confirm' }).click(); await a.getByText('Setting updated.').waitFor(); }
    await a.getByRole('button', { name: 'Turn on', exact: true }).click(); assert.ok(await a.getByRole('button', { name: 'Confirm' }).isDisabled(), 'a reason is required');
    await a.getByLabel('Reason for this change').fill('Launching with manual review of every new store'); await a.getByRole('button', { name: 'Confirm' }).click(); await a.getByText('Setting updated.').waitFor();

    // --- Seller signs up (must tick the terms box), completes the profile and submits
    await p.goto(`${BASE}/signup`);
    await p.getByLabel('Your name').fill('Review Seller'); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(pw); await p.getByLabel('Business name').fill(biz); await p.getByLabel('Store address').fill(slug);
    const terms = p.getByRole('checkbox', { name: /I agree to the/ }); assert.equal(await terms.getAttribute('required'), '', 'terms checkbox must be required'); await terms.check();
    await p.getByRole('button', { name: 'Create store' }).click(); await p.waitForURL('**/dashboard');
    await openNav(p, 'Settings');
    await p.getByLabel('What do you sell? (category)').fill('Gifts'); await p.getByLabel('About your business', { exact: true }).fill('Hand made gifts.'); await p.getByLabel('Customer pickup').check();
    await p.getByRole('button', { name: 'Save changes' }).click(); await p.getByText('Saved.').waitFor();
    assert.equal((await p.request.post(`${BASE}/api/seller/products`, { data: { name: 'Candle', status: 'active', variants: [{ priceCents: 2000, costCents: 700, stock: 9 }] } })).status(), 201);
    await p.getByRole('button', { name: 'Publish my store' }).click(); await p.getByText(/Submitted for review/).first().waitFor();
    await p.reload(); await p.getByText('Waiting for review.').waitFor();
    await g.goto(`${BASE}/store/${slug}`); await g.getByRole('heading', { name: 'Store not found' }).waitFor();                       // not public while waiting

    // --- Staff reject with a reason; the seller sees it
    await adminLink('Review queue'); await a.reload(); const c1 = card(a, biz); await c1.waitFor();
    await c1.getByText('Candle').waitFor();                                                                                           // reviewers see what they are approving
    await noHScroll(a, `${name} review queue`); await a.screenshot({ path: `${out}/${name}-z1-review-queue.png`, fullPage: true });
    await c1.getByRole('button', { name: 'Reject…' }).click(); await a.getByLabel(/Reason \(the seller will see this\)/).fill('Please describe what you sell in more detail');
    await a.getByRole('button', { name: 'Reject store' }).click(); await a.getByText(`${biz} sent back to draft.`).waitFor();
    await p.reload(); await p.getByText('Not approved yet.').waitFor(); await p.getByText('Please describe what you sell in more detail').waitFor();
    await noHScroll(p, `${name} settings after rejection`);
    await p.getByRole('button', { name: 'Publish my store' }).click(); await p.getByText(/Submitted for review/).first().waitFor();

    // --- Verification request, then staff approve the store and verify the seller
    await p.reload(); await p.getByLabel('Business registration number (if you have one)').fill('AB-1234567'); await p.getByLabel('Tell us about your business').fill('Registered sole proprietorship in Alberta.');
    await p.getByRole('button', { name: 'Request verification' }).click(); await p.getByText('Request sent.').waitFor();
    await adminLink('Review queue'); await a.reload();
    await card(a, biz).first().getByRole('button', { name: 'Approve' }).click(); await a.getByText(`${biz} approved and live.`).waitFor();
    await g.reload(); await g.getByRole('heading', { name: biz }).waitFor(); assert.equal(await g.getByText('Verified seller').count(), 0, 'not verified yet');
    const vcard = card(a, 'AB-1234567'); await vcard.getByRole('button', { name: 'Mark verified…' }).click();
    await a.getByLabel(/Reason \(kept on record/).fill('Registration details are consistent'); await a.getByRole('button', { name: 'Verify', exact: true }).click(); await a.getByText('Decision recorded.').waitFor();
    await g.reload(); await g.getByText('✓ Verified seller').waitFor();
    await noHScroll(g, `${name} verified storefront`); await g.screenshot({ path: `${out}/${name}-z2-verified-store.png`, fullPage: true });
    assert.ok((await sql(`SELECT 1 FROM email_outbox WHERE to_email=$1 AND template='store_approved'`, [email])).length === 1, 'approval email queued');

    // --- Product moderation
    const prods = await (await g.request.get(`${BASE}/api/public/stores/${slug}/products`)).json(); const pid = prods[0].id;
    await adminLink('Products'); await a.getByLabel(/Search by product, brand, business/).fill(slug);
    const row = a.locator('tr').filter({ hasText: 'Candle' }); await row.getByRole('button', { name: 'Remove' }).click();
    await a.getByLabel(/Reason \(the seller will see this\)/).fill('Item category is not allowed'); await a.getByRole('button', { name: 'Remove product' }).click(); await a.getByText('Product removed and the seller was told.').waitFor();
    await noHScroll(a, `${name} admin products`); await a.screenshot({ path: `${out}/${name}-z3-moderation.png`, fullPage: true });
    await g.goto(`${BASE}/store/${slug}/p/${pid}`); await g.getByRole('heading', { name: 'Product not found' }).waitFor();
    await p.getByRole('link', { name: 'Products' }).click(); await p.getByText('Removed by a moderator.').waitFor(); await p.getByText('Item category is not allowed').waitFor();
    assert.equal(await p.getByRole('button', { name: 'Publish product' }).count(), 0, 'a removed product cannot be republished by the seller');
    await a.locator('tr').filter({ hasText: 'Candle' }).getByRole('button', { name: 'Restore' }).click(); await a.getByLabel('Reason for restoring').fill('Appeal accepted'); await a.locator('form').getByRole('button', { name: 'Restore', exact: true }).click(); await a.getByText('Product restored as a draft.').waitFor();
    await p.reload(); await p.getByRole('button', { name: 'Publish product' }).click(); await p.locator('.badge.active').first().waitFor();            // wait for the real status badge, not loose text

    // --- Storefront search and paging (27 more products)
    for (let i = 1; i <= 27; i++) assert.equal((await p.request.post(`${BASE}/api/seller/products`, { data: { name: `Item ${String(i).padStart(2, '0')}`, status: 'active', variants: [{ priceCents: 1000 + i, stock: 5 }] } })).status(), 201);
    await g.goto(`${BASE}/store/${slug}`); await g.locator('.pc').first().waitFor(); await g.getByText('28 pieces').waitFor();
    assert.equal(await g.locator('.pc').count(), 24, 'first page shows 24');
    await g.getByRole('button', { name: 'Show more' }).click(); await g.waitForFunction(() => document.querySelectorAll('.pc').length === 28); assert.equal(await g.getByRole('button', { name: 'Show more' }).count(), 0);
    await g.getByLabel('Search this store').fill('Item 07'); await g.waitForFunction(() => document.querySelectorAll('.pc').length === 1); await g.getByText('1 piece', { exact: true }).waitFor();
    await g.getByLabel('Search this store').fill('zzzz'); await g.getByRole('heading', { name: 'No matches' }).waitFor();
    await g.getByLabel('Search this store').fill(''); await g.waitForFunction(() => document.querySelectorAll('.pc').length === 24);
    await noHScroll(g, `${name} storefront with search`);

    // --- Legal pages are present and clearly marked as drafts
    for (const [path, heading] of [['/terms', 'Terms of use (shoppers)'], ['/seller-terms', 'Seller agreement'], ['/privacy', 'Privacy policy'], ['/rules', 'Prohibited items']]) {
      await g.goto(BASE + path); await g.getByRole('heading', { name: heading }).waitFor(); await g.getByText('Draft for legal review.').waitFor(); await noHScroll(g, `${name} ${path}`);
    }

    // --- Seller closes the account (confirmation, password, and a typed word are all required)
    await openNav(p, 'Settings'); await p.getByRole('button', { name: 'Close my account…' }).click();
    assert.ok(await p.getByRole('button', { name: 'Permanently close my account' }).isDisabled(), 'needs the typed confirmation');
    await p.getByLabel('Your password').fill('wrong-password-123'); await p.getByLabel('Type CLOSE to confirm').fill('CLOSE'); await p.getByRole('button', { name: 'Permanently close my account' }).click();
    await p.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();
    await noHScroll(p, `${name} close account`); await p.screenshot({ path: `${out}/${name}-z4-close-account.png`, fullPage: true });
    await p.getByLabel('Your password').fill(pw); await p.getByRole('button', { name: 'Permanently close my account' }).click(); await p.waitForURL(BASE + '/');
    await g.goto(`${BASE}/store/${slug}`); await g.getByRole('heading', { name: 'Store not found' }).waitFor();
    await p.goto(`${BASE}/login`); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(pw); await p.getByRole('button', { name: 'Log in' }).click(); await p.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();
    await ac.close(); await sc.close(); await gc.close();
    console.log(`✓ ${name}: review, verification, moderation, search, legal, closure passed`);
  }
  await browser.close();
})().catch(async e => { console.error('✗ E2E4 FAILED:', e.message); for (const [k, pg] of Object.entries(pages)) { try { await pg.screenshot({ path: `${out}/FAIL-flow4-${k}.png`, fullPage: true }); } catch { /* closed */ } } process.exit(1); })
  .finally(async () => { try { await sql(`DELETE FROM platform_settings WHERE key='store_review_required'`); } catch { /* best effort: leave the platform in its default state */ } });
