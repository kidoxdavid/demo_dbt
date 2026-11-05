// OFFLINE VARIANT of make_reference.js (identical output logic). The sandbox cannot reach Google Fonts, so the @import is answered locally with the
// self-hosted Fraunces and Inter variable fonts (npm packages @fontsource-variable/*). Same fonts, same axes; nothing else differs.
// Regenerates the approved mockups: sheets/*.html and reference/*.png (the 17 screens the build must match).
// Needs: python3 (standard library only) and Playwright for Node with Chromium (npm i -D playwright && npx playwright install chromium).
// Needs internet once for Google Fonts (Fraunces, Inter); if offline, install those two fonts on the machine first.
const { execFileSync } = require('child_process'), path = require('path'), fs = require('fs');
const SRC = __dirname, ROOT = path.resolve(SRC, '..'), SHEETS = path.join(ROOT, 'sheets'), REF = path.join(ROOT, 'reference');
fs.mkdirSync(SHEETS, { recursive: true }); fs.mkdirSync(REF, { recursive: true });
execFileSync('python3', [path.join(SRC, 'render.py')], { cwd: SHEETS, env: { ...process.env, PYTHONPATH: SRC }, stdio: 'inherit' });
let chromium; try { chromium = require('playwright').chromium; } catch { chromium = require('playwright-core').chromium; }
const FONTS = path.resolve(SRC, '../../../node_modules/@fontsource-variable');
const fontCss = `@font-face{font-family:'Fraunces';font-style:normal;font-weight:100 900;font-display:block;src:url('file://${FONTS}/fraunces/files/fraunces-latin-opsz-normal.woff2') format('woff2')}
@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:block;src:url('file://${FONTS}/inter/files/inter-latin-wght-normal.woff2') format('woff2')}`;
const newPage = async (b, opts) => { const ctx = await b.newContext(opts); await ctx.route(/fonts\.googleapis\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: fontCss })); return ctx.newPage(); };
const url = (n) => 'file://' + path.join(SHEETS, n + '.html');
const phone = async (p, i, out) => { const bb = await (await p.$$('.phone'))[i].boundingBox(); await p.screenshot({ path: path.join(REF, out + '.png'), clip: { x: bb.x, y: bb.y + 46, width: 390, height: 798 } }); };
const JOBS = [
  ['2_buyer_phones', 1760, ['buyer-home', 'buyer-category', 'buyer-product', 'buyer-basket']],
  ['3_seller_onboarding', 1760, ['seller-onboarding-1-what-do-you-sell', 'seller-onboarding-2-shop-identity', 'seller-onboarding-3-first-product', 'seller-onboarding-4-live']],
  ['shop_A', 520, ['shop-look-atelier']], ['shop_B', 520, ['shop-look-noir']], ['shop_C', 520, ['shop-look-sage']],
  ['dir_A', 520, ['home-direction-atelier']], ['dir_B', 520, ['home-direction-noir']], ['dir_C', 520, ['home-direction-sage']],
];
(async () => {
  const b = await chromium.launch();
  for (const [n, w, names] of JOBS) {
    const p = await newPage(b, { viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
    await p.goto(url(n)); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(1500);
    for (let i = 0; i < names.length; i++) await phone(p, i, names[i]);
    await p.close(); console.log('done', n);
  }
  let p = await newPage(b, { viewport: { width: 1860, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(url('4_seller_studio')); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(1500);
  await (await p.$('div[style*="width:1180px"]')).screenshot({ path: path.join(REF, 'studio-desktop.png') });
  await phone(p, 0, 'studio-phone'); await p.close();
  p = await newPage(b, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(url('1_home_desktop')); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(REF, 'buyer-home-desktop.png'), fullPage: true });
  await b.close(); console.log('reference images written to', REF);
})();
