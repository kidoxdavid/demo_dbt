// Opens every page of every portal the way a person would reach it (by following links), and reports anything a person would trip on:
// console errors, failed requests, blank pages, dead ends ("coming soon", "not found"), sideways scrolling, broken pictures, controls with no name.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/e2e/crawl.mjs   (web on :5180 proxying the API; the database needs an admin, a maker with a shop, and one published piece)
import { chromium } from 'playwright';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180';
const who = k => ({ email: process.env[`${k}_EMAIL`], pw: process.env[`${k}_PW`] });
// Sign-ins come from the environment only (never written in this file): ADMIN_EMAIL/ADMIN_PW, SUPPORT_*, FINANCE_*, MARKETING_*, MAKER_*.
// On the demo data every demo account has the password printed by `npm run seed:demo`. Emails default to the demo staff addresses.
const need = k => { const v = process.env[k]; if (!v) { console.error(`Set ${k} before running the crawl (see the comment at the top of this file).`); process.exit(2); } return v; };
const ACCOUNTS = { admin: { email: process.env.ADMIN_EMAIL ?? 'admin@eazystores.test', pw: need('ADMIN_PW') }, support: { email: process.env.SUPPORT_EMAIL ?? 'support@eazystores.test', pw: need('SUPPORT_PW') }, finance: { email: process.env.FINANCE_EMAIL ?? 'finance@eazystores.test', pw: need('FINANCE_PW') }, marketing: { email: process.env.MARKETING_EMAIL ?? 'marketing@eazystores.test', pw: need('MARKETING_PW') }, studio: { email: process.env.MAKER_EMAIL, pw: process.env.MAKER_PW } };
void who;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const DEAD = /coming soon|not available yet|later release|we could not find|something went wrong|undefined|\[object Object\]|\bNaN\b|\bnull\b/i;
const issues = []; let visited = 0;

async function crawl(label, ctxOpts, starts, signIn) {
  const mobile = (ctxOpts.viewport?.width ?? 1280) < 600;
  const ctx = await browser.newContext({ locale: 'en-CA', ...ctxOpts }); const page = await ctx.newPage();
  let here = ''; const log = (kind, msg) => issues.push({ label, url: here, kind, msg });
  page.on('console', c => { if (c.type() === 'error' && !/status of 401/.test(c.text())) log('console', c.text().slice(0, 160)); });
  page.on('pageerror', e => log('pageerror', e.message.slice(0, 160)));
  page.on('response', r => { const u = r.url().replace(BASE, ''); if (r.status() >= 400 && !(r.status() === 401 && /\/api\/(me|admin\/me|studio\/me|support\/me|finance\/me|marketing\/me)$/.test(u))) log('http', `${r.status()} ${r.request().method()} ${u.slice(0, 100)}`); });
  if (signIn) await signIn(page);
  const seen = new Set(); const queue = [...starts]; const limit = 70;
  while (queue.length && seen.size < limit) {
    const path = queue.shift(); if (seen.has(path)) continue; seen.add(path); here = path; visited++;
    try { await page.goto(BASE + path, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(250); } catch (e) { log('navigation', e.message.split('\n')[0]); continue; }
    const info = await page.evaluate(() => {
      const text = document.body.innerText.trim(); const links = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && h.startsWith('/') && !h.startsWith('//') && !/^\/(api|assets|fonts)\//.test(h) && !/\.(png|jpg|svg|csv|json|pdf)(\?|$)/.test(h));
      const nameless = [...document.querySelectorAll('button, a, input, select, textarea')].filter(e => { const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false; const n = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || '').trim() || (e.id && document.querySelector(`label[for="${e.id}"]`)) || e.closest('label') || (e.getAttribute('aria-labelledby')); return !n && e.type !== 'hidden'; }).map(e => `${e.tagName.toLowerCase()}.${(e.className || '').toString().slice(0, 30)}`);
      const broken = [...document.images].filter(i => i.complete && i.naturalWidth === 0 && i.getBoundingClientRect().width > 0).map(i => i.src.slice(-60));
      const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const eff = e => { const r = e.getBoundingClientRect(); let w = r.width, h = r.height; const a = getComputedStyle(e, '::after'); if (a.content !== 'none' && a.position === 'absolute') { const t = parseFloat(a.top), b = parseFloat(a.bottom), l = parseFloat(a.left), rr = parseFloat(a.right); if (t < 0) h += -t; if (b < 0) h += -b; if (l < 0) w += -l; if (rr < 0) w += -rr; } return { w, h }; };
      const where = e => `${e.tagName.toLowerCase()}${e.className ? '.' + e.className.toString().split(' ')[0] : ''} in ${(e.parentElement?.tagName || '').toLowerCase()}${e.parentElement?.className ? '.' + e.parentElement.className.toString().split(' ')[0] : ''}`;
      const smallTargets = [...document.querySelectorAll('a[href], button, [role=button], [role=switch], select, input:not([type=hidden]), summary')].filter(vis).filter(e => { const z = eff(e); const inline = e.tagName === 'A' && getComputedStyle(e).display === 'inline' && e.closest('p, li, div.muted, span'); const inSearchPill = e.tagName === 'INPUT' && e.closest('form.search');      // the whole pill focuses the field when tapped
      return !inline && !inSearchPill && (z.h < 40 || z.w < 40) && !(e.tagName === 'INPUT' && ['checkbox', 'radio'].includes(e.type)); }).map(e => `${where(e)} "${(e.getAttribute('aria-label') || e.innerText || '').toString().trim().slice(0, 20)}" ${Math.round(eff(e).w)}x${Math.round(eff(e).h)}`);
      const smallInputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')].filter(vis).filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).map(e => `${e.tagName.toLowerCase()}#${e.id || e.getAttribute('aria-label') || ''} ${getComputedStyle(e).fontSize}`);
      const tiny = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && (e.textContent || '').trim().length > 2 && vis(e) && parseFloat(getComputedStyle(e).fontSize) < 10).map(e => `"${e.textContent.trim().slice(0, 20)}" ${getComputedStyle(e).fontSize}`);
      const exits = document.querySelectorAll('nav.tabbar a, .dhead a, .dnav a, a[href="/"], .backbtn, a.crumbs, .cons-top a, .sd-side a, .cons-menu, nav.cons-nav a').length;
      return { exits, smallTargets, smallInputs, tiny, text, len: text.length, links: [...new Set(links)], overflow: document.documentElement.scrollWidth - window.innerWidth, nameless, broken, h1: document.querySelectorAll('h1').length, title: document.title };
    });
    if (info.len < 25) log('blank', `only ${info.len} characters on the page`);
    const m = info.text.match(DEAD); if (m) log('dead-end?', `page says "${m[0]}"`);
    if (info.overflow > 1) log('overflow', `${info.overflow}px wider than the screen`);
    if (info.broken.length) log('picture', `broken: ${info.broken.slice(0, 2).join(', ')}`);
    if (info.nameless.length) log('unnamed-control', info.nameless.slice(0, 3).join(', '));
    if (mobile && info.smallTargets.length) log('small-tap-target', `${info.smallTargets.length} under 40px, e.g. ${info.smallTargets.slice(0, 3).join('; ')}`);
    if (mobile && info.smallInputs.length) log('small-input-text', `${info.smallInputs.length} fields under 16px (iPhone zooms in), e.g. ${info.smallInputs.slice(0, 2).join('; ')}`);
    if (mobile && info.tiny.length) log('tiny-text', `${info.tiny.length} texts under 10px, e.g. ${info.tiny.slice(0, 3).join('; ')}`);
    if (info.exits === 0 && !path.startsWith('/_')) log('no-way-out', 'no link to the home page, menu or tab bar, so Back is the only exit');
    if (info.h1 === 0 && info.len >= 25) log('no-heading', 'no h1 on the page');
    for (const l of info.links) if (!seen.has(l) && !queue.includes(l)) queue.push(l);
  }
  await ctx.close(); return seen.size;
}
const consoleSignIn = (area, a) => async page => { await page.goto(`${BASE}/${area}/login`); await page.fill('#cl-email', a.email); await page.fill('#cl-pw', a.pw); await page.getByRole('button', { name: 'Sign in' }).click(); await page.waitForSelector('.sd-side, .cons-top', { timeout: 15000 }); };
const phone = { viewport: { width: 390, height: 798 } }; const laptop = { viewport: { width: 1280, height: 900 } };
const counts = {};
counts['shop phone'] = await crawl('shop phone', phone, ['/', '/c/pottery-ceramics', '/search?q=mug', '/basket', '/account', '/saved', '/guides', '/makers']);
counts['shop laptop'] = await crawl('shop laptop', laptop, ['/', '/c/pottery-ceramics', '/search?q=mug', '/basket', '/account']);
if (ACCOUNTS.studio.email) { const a = ACCOUNTS.studio; const si = async page => { await page.goto(`${BASE}/studio/login`); await page.fill('#sl-email', a.email); await page.fill('#sl-pw', a.pw); await page.getByRole('button', { name: 'Sign in' }).click(); await page.waitForSelector('.sd-side, .tabbar', { timeout: 15000 }); };
  counts['studio laptop'] = await crawl('studio laptop', laptop, ['/studio', '/studio/orders', '/studio/products', '/studio/products/new', '/studio/shop', '/studio/shipping', '/studio/messages', '/studio/reviews', '/studio/notifications', '/studio/ads', '/studio/promotions', '/studio/insights', '/studio/payouts'], si);
  counts['studio phone'] = await crawl('studio phone', phone, ['/studio', '/studio/orders', '/studio/products', '/studio/shop', '/studio/ads', '/studio/promotions'], si); }
for (const [k, starts] of [['admin', ['', '/users', '/sellers', '/moderation', '/promotions', '/roles', '/emails', '/pages', '/branding', '/settings', '/audit']], ['support', ['', '/users', '/audit']], ['finance', ['', '/sellers', '/orders', '/reports', '/audit']], ['marketing', ['', '/ads', '/promotions', '/synonyms']]]) {
  counts[`${k} laptop`] = await crawl(`${k} laptop`, laptop, starts.map(p => `/${k}${p}`), consoleSignIn(k, ACCOUNTS[k]));
  counts[`${k} phone`] = await crawl(`${k} phone`, phone, starts.slice(0, 4).map(p => `/${k}${p}`), consoleSignIn(k, ACCOUNTS[k])); }
await browser.close();
const uniq = new Map(); for (const i of issues) { const key = `${i.label}|${i.kind}|${i.msg.replace(/\"[^\"]*\"/g, '"…"').replace(/\d+/g, '#')}`; if (!uniq.has(key)) uniq.set(key, { ...i, n: 0, urls: [] }); const u = uniq.get(key); u.n++; if (u.urls.length < 3) u.urls.push(i.url); }
console.log(`Visited ${visited} pages: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(uniq.size ? `\n${uniq.size} distinct issues:` : '\nNo issues found.');
for (const u of uniq.values()) console.log(`- [${u.label}] ${u.kind}: ${u.msg}  (${u.n}x, e.g. ${u.urls.join(' ')})`);
process.exit(uniq.size ? 1 : 0);
