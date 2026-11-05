// Visual-regression: screenshot each screen and compare with design/eazystores/reference/<name>.png using pixelmatch (threshold 0.1, AA ignored).
// PASS = at most 1.5% of pixels differ. Only the bottom-left and bottom-right 24px corners of PHONE references are masked (the mockup's rounded device corners).
// Never raise the tolerance; never regenerate a reference to make a test pass. Diffs are written to apps/e2e/visual-diffs/.
import { chromium } from 'playwright'; import pixelmatch from 'pixelmatch'; import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url)); const REF = join(here, '../../design/eazystores/reference'); const OUT = join(here, 'visual-diffs'); mkdirSync(OUT, { recursive: true });
const BASELINES = join(here, 'baselines'); mkdirSync(BASELINES, { recursive: true }); const UPDATE = process.argv.includes('--update-baselines');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const ONLY = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined; const LIMIT = 1.5;
const screens = JSON.parse(readFileSync(join(here, 'screens.json'), 'utf8')).filter(s => !ONLY || s.name === ONLY);

// ---- helpers for screens that need data (all through the real API, except shop-look fixtures, see docs/DESIGN.md deviation 5)
async function findProductId(ctx, title) { const r = await ctx.request.get(`${BASE}/api/products?q=${encodeURIComponent(title)}&limit=10`); const hit = (await r.json()).items.find(i => i.title === title); if (!hit) throw new Error(`product not found: ${title}`); return hit.id; }
async function fillCart(page, lines) {
  for (const l of lines) {
    const id = await findProductId(page.context(), l.title); const p = await (await page.context().request.get(`${BASE}/api/products/${id}`)).json();
    const v = p.variants.find(v => Object.entries(l.options ?? p.defaultOptions ?? {}).every(([k, x]) => v.options[k] === x)); if (!v) throw new Error(`variant not found for ${l.title}`);
    const r = await page.context().request.post(`${BASE}/api/cart/items`, { data: { variantId: v.id, quantity: l.quantity ?? 1 }, headers: { origin: BASE } }); if (!r.ok()) throw new Error(`cart add failed ${r.status()} ${await r.text()}`);
  }
}
async function installFixture(page, name) {
  const fx = JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
  await page.route('**/api/shops/*', r => r.fulfill({ json: fx.shop })); await page.route('**/api/products?*', r => r.fulfill({ json: { total: fx.items.length, makers: 1, fuzzy: false, items: fx.items } }));
}
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); const rows = []; let failed = 0;
for (const s of screens) {
  const ctx = await browser.newContext({ viewport: { width: s.viewport[0], height: s.viewport[1] }, deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: s.colorScheme ?? 'light', locale: 'en-CA', timezoneId: 'America/Edmonton' });
  const page = await ctx.newPage(); await page.clock.install({ time: new Date('2026-11-05T09:41:00-07:00') });
  await page.addInitScript(() => { const st = document.createElement('style'); document.addEventListener('DOMContentLoaded', () => { st.textContent = '*{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(st); }); });
  if (s.storage) await page.addInitScript(kv => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, s.storage);
  if (s.fixture) await installFixture(page, s.fixture);
  let path = s.path;
  if (s.productTitle) { const id = await findProductId(ctx, s.productTitle); path = `/p/${id}`; }
  await page.goto(BASE + path);
  if (s.cart) { await fillCart(page, s.cart); await page.goto(BASE + path); }
  if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 15000 }); await page.evaluate(() => document.fonts.ready); await page.waitForLoadState('load'); await page.waitForTimeout(400);
  const shot = s.selector ? await (await page.$(s.selector)).screenshot() : await page.screenshot({ fullPage: s.fullPage ?? false });
  writeFileSync(join(OUT, `${s.name}.actual.png`), shot);
  const refPath = s.baseline ? join(BASELINES, `${s.name}.png`) : join(REF, `${s.ref ?? s.name}.png`);
  if (s.baseline && (UPDATE || !existsSync(refPath))) { writeFileSync(refPath, shot); rows.push({ name: s.name, result: 'BASELINE WRITTEN (component-library snapshot, not a mockup)' }); await ctx.close(); continue; }
  if (!existsSync(refPath)) { rows.push({ name: s.name, result: 'NO REFERENCE (shown for review only)' }); await ctx.close(); continue; }
  const a = PNG.sync.read(shot), r = PNG.sync.read(readFileSync(refPath));
  if (a.width !== r.width || a.height !== r.height) { rows.push({ name: s.name, result: `FAIL size ${a.width}x${a.height} vs ${r.width}x${r.height}` }); failed++; await ctx.close(); continue; }
  const mask = (img) => { if (s.kind !== 'phone') return; const c = 24 * 2; for (let y = img.height - c; y < img.height; y++) for (let x = 0; x < img.width; x++) if (x < c || x >= img.width - c) { const i = (y * img.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = 255; } };
  mask(a); mask(r);
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, r.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false });
  const pct = (n / (a.width * a.height)) * 100; const ok = pct <= LIMIT; if (!ok) { failed++; writeFileSync(join(OUT, `${s.name}.diff.png`), PNG.sync.write(diff)); }
  rows.push({ name: s.name, result: `${ok ? 'PASS' : 'FAIL'} ${pct.toFixed(2)}% differ` }); await ctx.close();
}
await browser.close(); for (const r of rows) console.log(r.name.padEnd(44), r.result); process.exit(failed ? 1 : 0);
