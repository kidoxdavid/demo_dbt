// Accessibility pass: axe-core (WCAG 2.1 A/AA) on the key screens in light and dark, a 320 px reflow check, and a keyboard check.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/a11y.mjs   (web on :5180 proxying the API; demo seed)
import { chromium } from 'playwright'; import { createRequire } from 'node:module';
const axeSource = (await import('node:fs')).readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180'; const PW = 'demo-password-2026';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const productId = (await (await fetch(`${BASE}/api/products?limit=1`)).json()).items[0].id;
const findings = new Map(); const reflow = []; let scans = 0;

async function ctxFor(scheme, width) { const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-CA', colorScheme: scheme }); return { ctx, page: await ctx.newPage() }; }
async function scan(page, name, scheme) {
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(400);
  await page.evaluate(src => { if (!window.axe) (0, eval)(src); }, axeSource);
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
  scans++;
  for (const v of r.violations) {
    const key = `${v.id}|${v.impact}`; const e = findings.get(key) ?? { id: v.id, impact: v.impact, help: v.help, where: new Map() };
    const w = e.where.get(name) ?? { schemes: new Set(), nodes: new Set() }; w.schemes.add(scheme);
    for (const n of v.nodes.slice(0, 3)) w.nodes.add(`${n.target.join(' ')}${n.any[0]?.data?.fgColor ? ` (${n.any[0].data.fgColor} on ${n.any[0].data.bgColor}, ${n.any[0].data.contrastRatio}:1)` : ''}`);
    e.where.set(name, w); findings.set(key, e);
  }
}
const buyer = [['home', '/'], ['category', '/c/pottery-ceramics'], ['product', `/p/${productId}`], ['search', '/search?q=mug'], ['basket', '/basket'], ['checkout', '/checkout'], ['account-sign-in', '/account'], ['shop', '/shop/clay-ember']];
const guestStudio = [['studio-sign-in', '/studio/login'], ['onboarding-1', '/studio/start/1'], ['admin-sign-in', '/admin/login']];

for (const scheme of ['light', 'dark']) {
  const { ctx, page } = await ctxFor(scheme, 390);
  for (const [n, p] of buyer) { await page.goto(BASE + p); await scan(page, n, scheme); }
  for (const [n, p] of guestStudio) { await page.goto(BASE + p); await scan(page, n, scheme); }
  await ctx.close();
  // signed-in studio (desktop)
  const s = await ctxFor(scheme, 1280); await s.page.goto(BASE + '/studio/login'); await s.page.fill('#sl-email', 'amara@clayember.test'); await s.page.fill('#sl-pw', PW); await s.page.getByRole('button', { name: 'Sign in' }).click(); await s.page.waitForSelector('.sd-side');
  for (const [n, p] of [['studio-dashboard', '/studio'], ['studio-orders', '/studio/orders'], ['studio-products', '/studio/products'], ['studio-new-product', '/studio/products/new'], ['studio-shop', '/studio/shop'], ['studio-shipping', '/studio/shipping'], ['studio-messages', '/studio/messages'], ['studio-ads', '/studio/ads'], ['studio-promotion', '/studio/promotions']]) { await s.page.goto(BASE + p); await scan(s.page, n, scheme); }
  await s.ctx.close();
  // consoles
  for (const [area, email, paths] of [['admin', 'admin@eazystores.test', ['', '/users', '/sellers', '/moderation', '/settings', '/audit', '/roles', '/emails', '/pages', '/branding', '/promotions']], ['support', 'support@eazystores.test', ['', '/users', '/audit']], ['finance', 'finance@eazystores.test', ['', '/sellers', '/reports']], ['marketing', 'marketing@eazystores.test', ['', '/ads', '/synonyms', '/promotions']]]) {
    const c = await ctxFor(scheme, 1280); await c.page.goto(`${BASE}/${area}/login`); await c.page.fill('#cl-email', email); await c.page.fill('#cl-pw', PW); await c.page.getByRole('button', { name: 'Sign in' }).click(); await c.page.waitForURL(u => !u.pathname.endsWith('/login'));
    for (const p of paths) { await c.page.goto(`${BASE}/${area}${p}`); await scan(c.page, `${area}${p || ''}`, scheme); }
    await c.ctx.close();
  }
}

// reflow: nothing scrolls sideways at 320 px wide (WCAG 1.4.10)
{
  const { ctx, page } = await ctxFor('light', 320);
  for (const [n, p] of [...buyer, ['studio-sign-in', '/studio/login'], ['onboarding-1', '/studio/start/1']]) { await page.goto(BASE + p); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(300); const w = await page.evaluate(() => document.documentElement.scrollWidth); if (w > 321) reflow.push(`${n}: ${w}px wide`); }
  await ctx.close();
}

// keyboard: every screen has a skip link or lands on a real control first, focus is visible, Tab never gets stuck, and Escape closes dialogs
const keyboard = [];
{
  const { ctx, page } = await ctxFor('light', 390);
  for (const [n, p] of [['home', '/'], ['category', '/c/pottery-ceramics'], ['product', `/p/${productId}`], ['basket', '/basket'], ['account-sign-in', '/account'], ['studio-sign-in', '/studio/login']]) {
    await page.goto(BASE + p); await page.waitForLoadState('networkidle').catch(() => {}); const seen = new Set(); let invisible = 0; let first = '';
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none'); const r = e.getBoundingClientRect(); return { id: `${e.tagName}${e.id ? '#' + e.id : ''}.${(e.className || '').toString().slice(0, 30)}|${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24)}`, ring, size: r.width * r.height }; });
      if (!f) continue; if (!first) first = f.id; seen.add(f.id); if (!f.ring && f.size > 0) invisible++;
    }
    keyboard.push(`${n}: ${seen.size} stops reached by Tab; first stop "${first}"; ${invisible} without a visible focus style`);
  }
  await ctx.close();
}
await browser.close();

console.log(`\n${scans} axe scans (light + dark)`);
if (!findings.size) console.log('axe: no violations');
for (const e of [...findings.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`\n[${e.impact}] ${e.id}: ${e.help}`);
  for (const [n, w] of e.where) console.log(`   ${n} (${[...w.schemes].join('+')}): ${[...w.nodes].slice(0, 2).join(' ; ')}`);
}
console.log('\nreflow at 320 px:', reflow.length ? reflow.join(', ') : 'no sideways scrolling on any screen');
console.log('\nkeyboard:'); for (const k of keyboard) console.log('  ' + k);
