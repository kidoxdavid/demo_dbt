// Builds ONE complete, lived-in store through the real API so you can see how a store looks and operates: products with photos, options and stock levels,
// a made-to-order item with a customer question, delivery rules, discount codes, customers with accounts, paid/fulfilled/refunded orders, reviews with a seller reply,
// counter sales, and the Professional trial. Product photos are generated placeholder illustrations, NOT real photography. Development only.
// Usage (API on :3000 running): node e2e/seed-showcase.cjs        Optional: set MIGRATION_DATABASE_URL to spread the orders over the last four weeks.
const fs = require('node:fs');
const { chromium } = require('playwright');
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const src = fs.readFileSync(`${__dirname}/seed-demo.cjs`, 'utf8');
const art = new Function(`${src.slice(src.indexOf('const P = '), src.indexOf('const STORES'))}; return art;`)();   // reuse the illustration generator

const SFX = process.env.SEED_SUFFIX ?? '';           // lets you build a second copy in the same database
const SLUG = `northern-hearth${SFX}`; const PW = 'demo-password-123';
const SELLER = { email: `showcase-owner${SFX}@eazystores.test`, name: 'Hannah Ellis' };
const PRODUCTS = [
  { n: 'Cedar & Smoke Candle', d: 'Hand-poured soy wax with cedarwood, smoked vanilla and a hint of black pepper. 45 to 60 hours.', a: { wax: 'Soy', burn_time: '45 to 60 hours', scent: 'Cedar, smoked vanilla' }, art: ['candle', 'amber', 'noir'], v: [['8 oz', 3400, 1100, 24, 340], ['12 oz', 4800, 1500, 16, 520]] },
  { n: 'Winter Pine Candle', d: 'Crisp pine needle and cold air. Our winter favourite.', a: { wax: 'Soy', burn_time: '45 hours', scent: 'Pine, frost' }, art: ['candle', 'sage', 'mint'], v: [['8 oz', 3400, 1100, 3, 340]] },
  { n: 'Birch Limited Candle', d: 'A limited autumn batch. When it is gone, it is gone.', a: { wax: 'Soy', scent: 'Birch, honey' }, art: ['candle', 'sand', 'clay'], v: [['8 oz', 3600, 1200, 0, 340]] },
  { n: 'Speckled Stoneware Mug', d: 'Wheel-thrown stoneware with a speckled glaze. Dishwasher safe.', a: { material: 'Stoneware', capacity: '350 ml', dishwasher_safe: true }, art: ['mug', 'clay', 'sand'], v: [['Oat', 3200, 1000, 18, 420], ['Charcoal', 3200, 1000, 11, 420]] },
  { n: 'Personalised Mug', d: 'A mug with a name or short message, made after you order. Allow 3 to 5 days.', mto: true, a: { material: 'Stoneware', production_time: '3 to 5 days' }, cf: [{ label: 'Name or message', type: 'text', required: true, maxLength: 20 }], art: ['mug', 'rose', 'plum'], v: [['350 ml', 3900, 1300, 0, 430]] },
  { n: 'Merino Throw Scarf', d: 'A generous, soft merino scarf that doubles as a shawl.', a: { fabric: 'Merino wool', length: '190 cm' }, art: ['scarf', 'coral', 'clay'], v: [['Rust', 6400, 2100, 12, 260], ['Fog', 6400, 2100, 9, 260]] },
  { n: 'Market Tote', d: 'Heavy canvas tote with an inner pocket. Holds a week of groceries.', a: { fabric: 'Canvas', capacity: '18 L' }, art: ['tote', 'olive', 'sand'], v: [['One size', 2800, 800, 30, 380]] },
  { n: 'Self-watering Planter', d: 'A two-part planter with a hidden reservoir. Forgiving for forgetful plant parents.', a: { material: 'Ceramic', capacity: '350 ml' }, art: ['planter', 'clay', 'sage'], v: [['Small', 2400, 600, 15, 700], ['Large', 3600, 950, 8, 1300]] },
  { n: 'Beeswax Hand Balm', d: 'A rich balm for winter hands. Beeswax, shea and sweet almond oil.', a: { size: '60 ml', ingredients: 'Beeswax, shea butter, sweet almond oil' }, art: ['jar', 'gold', 'amber'], v: [['60 ml', 1800, 500, 40, 120]] },
  { n: 'Cozy Night Gift Box', d: 'A candle, a balm and a mug, boxed and ready to give.', a: { includes: 'Candle, balm, mug', gift_ready: true }, art: ['giftbox', 'gold', 'noir'], v: [['Box', 8900, 3600, 6, 1300]] },
];
// who bought what: [customer, [[product, option, qty]...], code, delivery region or null, final status, days ago, review [rating, title, text] for the first item]
const ORDERS = [
  [0, [[0, 1, 1], [8, 0, 2]], 'WELCOME10', null, 'completed', 27, [5, 'Smells like a cabin', 'The 12 oz fills the whole room. Burns evenly all the way down.']],
  [1, [[3, 0, 2]], null, 'AB', 'completed', 25, [5, 'Beautiful glaze', 'Even nicer in person. Arrived well wrapped.']],
  [2, [[9, 0, 1]], null, 'ON', 'completed', 22, [4, 'Lovely gift', 'Gave it as a gift and it was a hit. Wish the candle were bigger.']],
  [3, [[5, 1, 1], [6, 0, 1]], 'WELCOME10', null, 'completed', 20, [5, 'So soft', 'The scarf is gorgeous and the tote is sturdier than I expected.']],
  [4, [[7, 0, 2]], null, 'AB', 'completed', 18, [3, 'Nice, small', 'Works well but smaller than the photos suggest.']],
  [0, [[4, 0, 1]], null, null, 'completed', 15, [5, 'Perfect personalised mug', 'Name printed exactly as I asked. Fast.'], { 'Name or message': 'Hannah' }],
  [5, [[0, 0, 2], [1, 0, 1]], null, 'BC', 'shipped', 9, null],
  [1, [[6, 0, 3]], 'FREESHIP', 'BC', 'ready', 6, null],
  [2, [[8, 0, 4], [3, 1, 1]], null, null, 'processing', 3, null],
  [3, [[9, 0, 1], [0, 0, 1]], null, 'AB', 'paid', 1, null],
  [4, [[5, 0, 1]], null, null, 'paid', 0, null],
  [5, [[1, 0, 1]], null, null, 'refunded', 12, null],
];
const POS = [[0, 0, 1, 'cash', 5], [8, 0, 2, 'card_terminal', 4], [6, 0, 1, 'cash', 2], [3, 0, 1, 'e_transfer', 1], [0, 1, 1, 'card_terminal', 0]];

// Photos. Put your own real photos in e2e/photos/ named after the product, e.g. cedar-and-smoke-candle-1.jpg, cedar-and-smoke-candle-2.jpg (see photos/README.md).
// Or run with PHOTOS=download to fetch random keyword-matched Creative Commons photos from loremflickr.com (needs internet; they may not match well; demo only).
// With neither, generated illustrations are used. Run `node e2e/seed-showcase.cjs --photos` on an existing showcase store to swap its pictures.
const slugify = n => n.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const KW = ['candle', 'candle', 'candle', 'ceramic,mug', 'ceramic,mug', 'scarf,wool', 'tote,bag', 'planter,plant', 'balm,skincare', 'gift,box'];
async function photosFor(p, idx) {
  const out = []; const dir = `${__dirname}/photos`;
  for (let i = 1; i <= 4; i++) for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const f = `${dir}/${slugify(p.n)}-${i}.${ext}`; if (fs.existsSync(f)) { out.push({ buf: fs.readFileSync(f), type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }); break; }
  }
  if (!out.length && process.env.PHOTOS === 'download') for (let i = 1; i <= 2; i++) {
    try { const r = await fetch(`https://loremflickr.com/800/800/${KW[idx]}?lock=${idx * 10 + i}`, { redirect: 'follow' }); const t = r.headers.get('content-type') ?? '';
      if (r.ok && t.startsWith('image/jpeg')) out.push({ buf: Buffer.from(await r.arrayBuffer()), type: 'image/jpeg' }); } catch { /* fall back below */ }
  }
  return out;
}
const jar = {};
async function call(who, path, { method = 'GET', body, raw, type } = {}, tries = 0) {
  const res = await fetch(API + path, { method, headers: { ...(jar[who] && { cookie: jar[who] }), ...(body && { 'content-type': 'application/json' }), ...(type && { 'content-type': type }) }, body: raw ?? (body && JSON.stringify(body)) });
  if (res.status === 429 && tries < 3) { const wait = Number(/(\d+) second/.exec(JSON.stringify(await res.clone().json().catch(() => ({}))))?.[1] ?? 30); console.log(`Rate limited, waiting ${wait}s...`); await new Promise(r => setTimeout(r, (wait + 1) * 1000)); return call(who, path, { method, body, raw, type }, tries + 1); }
  const sc = res.headers.getSetCookie?.()[0]; if (sc) jar[who] = sc.split(';')[0];
  const data = await res.json().catch(() => ({})); return { status: res.status, data };
}
const must = (r, what) => { if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

async function swapPhotos() {
  must(await call('s', '/api/auth/login', { method: 'POST', body: { email: SELLER.email, password: PW } }), 'login');
  const list = (await call('s', '/api/seller/products')).data; let changed = 0;
  for (const [idx, p] of PRODUCTS.entries()) {
    const row = list.find(x => x.name === p.n); if (!row) continue; const real = await photosFor(p, idx); if (!real.length) { console.log(`no photos found for ${p.n}, left as is`); continue; }
    for (const im of row.images ?? []) await call('s', `/api/seller/images/${im.id}`, { method: 'DELETE' });
    for (const ph of real) must(await call('s', `/api/seller/products/${row.id}/images`, { method: 'POST', raw: ph.buf, type: ph.type }), 'photo'); changed++;
  }
  console.log(`Replaced the pictures on ${changed} product(s).`);
}
(async () => {
  if (process.argv.includes('--photos')) return swapPhotos();
  const su = await call('s', '/api/auth/signup', { method: 'POST', body: { email: SELLER.email, password: PW, fullName: SELLER.name, businessName: 'Northern Hearth', storeSlug: SLUG } });
  if (su.status === 409) { console.log(`Already there: the showcase store exists. Log in as ${SELLER.email}. (To rebuild it, use a fresh database.)`); return; }
  must(su, 'seller signup');
  must(await call('s', '/api/seller/business', { method: 'PATCH', body: { category: 'Home & Gifts', description: 'Candles, ceramics and cozy things, made in small batches in Calgary.', city: 'Calgary', region: 'AB', country: 'CA', contactPhone: '403-555-0142', taxFederal: true, fulfilment: { pickup: true, delivery: true, shipping: false } } }), 'business');
  must(await call('s', '/api/seller/store', { method: 'PATCH', body: { tagline: 'Candles, ceramics and cozy things, made in small batches.', deliveryFeeCents: 800, theme: { accent: '#8a4b2a', hero: 'dark', layout: 'spacious' } } }), 'store');

  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  const render = async svg => { await page.setContent(`<body style="margin:0">${svg}</body>`); return page.screenshot({ type: 'jpeg', quality: 88 }); };
  const ids = [];
  for (const p of PRODUCTS) {
    const r = must(await call('s', '/api/seller/products', { method: 'POST', body: { name: p.n, description: p.d, brand: 'Northern Hearth', attributes: p.a, madeToOrder: !!p.mto, customFields: p.cf ?? [], status: 'active',
      variants: p.v.map(([title, price, cost, stock, weight]) => ({ title, priceCents: price, costCents: cost, stock, weightGrams: weight })) } }), `product ${p.n}`);
    const real = await photosFor(p, PRODUCTS.indexOf(p));
    if (real.length) for (const ph of real) must(await call('s', `/api/seller/products/${r.id}/images`, { method: 'POST', raw: ph.buf, type: ph.type }), 'photo');
    else for (const pal of [p.art[1], p.art[2]]) must(await call('s', `/api/seller/products/${r.id}/images`, { method: 'POST', raw: await render(art(p.art[0], pal)), type: 'image/jpeg' }), 'image');
    ids.push(r.id);
  }
  await browser.close();
  const list = (await call('s', '/api/seller/products')).data; const variant = (pi, vi) => list.find(x => x.id === ids[pi]).variants[vi].id;

  must(await call('s', '/api/seller/shipping-rules', { method: 'PUT', body: { rules: [
    { name: 'Free delivery in Alberta over $75', regions: ['AB'], minSubtotalCents: 7500, priceCents: 0 },
    { name: 'Alberta delivery', regions: ['AB'], priceCents: 800 },
    { name: 'Heavy parcel across Canada', regions: [], minWeightG: 2000, priceCents: 2200 },
    { name: 'Canada-wide delivery', regions: [], priceCents: 1400 }] } }), 'shipping rules');
  must(await call('s', '/api/seller/discounts', { method: 'POST', body: { code: 'WELCOME10', kind: 'percent', value: 10, maxUsesPerEmail: 1 } }), 'discount');
  must(await call('s', '/api/seller/discounts', { method: 'POST', body: { code: 'FREESHIP', kind: 'free_shipping', minSubtotalCents: 5000 } }), 'discount');
  must(await call('s', '/api/seller/billing/change', { method: 'POST', body: { plan: 'professional', interval: 'monthly' } }), 'plan trial');   // unlocks counter sales (simulated)
  must(await call('s', '/api/seller/store/publish', { method: 'POST', body: {} }), 'publish');

  const NAMES = ['Maya Chen', 'Jordan Reid', 'Priya Nair', 'Luc Tremblay', 'Sofia Alvarez', 'Ben Okafor'];
  NAMES.forEach((_, i) => { /* sessions are created below */ });
  for (const [i, n] of NAMES.entries()) must(await call(`c${i}`, '/api/auth/signup-customer', { method: 'POST', body: { email: `shopper${i + 1}${SFX}@eazystores.test`, password: PW, fullName: n } }), 'customer');

  const detail = async pi => (await call('x', `/api/public/stores/${SLUG}/products/${ids[pi]}`)).data; const keys = {}; keys[4] = (await detail(4)).customFields[0].key; const fieldKey = pi => keys[pi];
  const made = [];                                                                                     // [orderNumber, days ago, channel]
  const bySellerOrder = async number => (await call('s', '/api/seller/orders?limit=100')).data.find(o => Number(o.number) === number);
  for (const [ci, items, code, region, status, days, review, custom] of ORDERS) {
    const body = { items: items.map(([pi, vi, q]) => ({ variantId: variant(pi, vi), quantity: q, ...(custom && PRODUCTS[pi].cf ? { customizations: { [fieldKey(pi)]: custom[PRODUCTS[pi].cf[0].label] } } : {})})),
      email: `shopper${ci + 1}${SFX}@eazystores.test`, name: NAMES[ci], fulfilment: region ? 'delivery' : 'pickup', ...(code ? { discountCode: code } : {}),
      ...(region ? { address: { line1: `${100 + ci} Maple Street`, city: region === 'AB' ? 'Calgary' : region === 'ON' ? 'Toronto' : 'Vancouver', region, postalCode: region === 'AB' ? 'T2P1J9' : region === 'ON' ? 'M5V2T6' : 'V6B1A1', country: 'CA' } } : {}) };
    const o = must(await call(`c${ci}`, `/api/public/stores/${SLUG}/checkout`, { method: 'POST', body }), 'checkout');
    must(await call('x', `/api/public/payments/${o.paymentId}/simulate`, { method: 'POST', body: { outcome: 'succeeded' } }), 'payment');
    const row = await bySellerOrder(o.orderNumber); made.push([o.orderNumber, days, 'online']);
    const path = { processing: ['processing'], ready: ['processing', 'ready'], shipped: ['processing', 'shipped'], completed: region ? ['processing', 'shipped', 'completed'] : ['processing', 'ready', 'completed'], refunded: ['processing', 'ready', 'completed'] }[status] ?? [];
    for (const st of path) must(await call('s', `/api/seller/orders/${row.id}/status`, { method: 'POST', body: { status: st } }), `status ${st}`);
    if (status === 'refunded') must(await call('s', `/api/seller/orders/${row.id}/refunds`, { method: 'POST', body: { amountCents: row.total_cents, reason: 'Arrived damaged, replacement not wanted', restock: false } }), 'refund');
    if (review) must(await call(`c${ci}`, `/api/public/stores/${SLUG}/products/${ids[items[0][0]]}/reviews`, { method: 'PUT', body: { rating: review[0], title: review[1], body: review[2] } }), 'review');
  }
  for (const [pi, vi, q, method, days] of POS) {
    const s = must(await call('s', '/api/seller/pos/sales', { method: 'POST', body: { items: [{ variantId: variant(pi, vi), quantity: q }], paymentMethod: method, ...(method === 'cash' ? { tenderedCents: 20000 } : {}) } }), 'pos sale'); made.push([s.number, days, 'pos']);
  }
  const revs = (await call('s', '/api/seller/reviews')).data;
  const reply = (text, match) => { const r = revs.find(x => x.title === match); return r && call('s', `/api/seller/reviews/${r.id}/reply`, { method: 'POST', body: { reply: text } }); };
  await reply('Thank you Maya! So glad it suits the room.', 'Smells like a cabin'); await reply('Thanks for the honest note. We are adding size photos with a coin for scale.', 'Nice, small');

  if (process.env.MIGRATION_DATABASE_URL || true) {                                                      // spread orders over the last weeks so charts and "Insights" have something to show
    try {
      const { Client } = require('../../api/node_modules/pg');
      const c = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://eazy_owner:owner_pw@localhost:5432/eazystores' }); await c.connect();
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.platform_admin','on',true)`);
      for (const [num, days] of made) await c.query(`UPDATE orders SET created_at = now() - ($2 || ' days')::interval - interval '3 hours', updated_at = now() - ($2 || ' days')::interval WHERE number=$1 AND tenant_id=(SELECT tenant_id FROM stores WHERE slug=$3)`, [num, String(days), SLUG]);
      await c.query('COMMIT'); await c.end(); console.log('Orders spread over the last four weeks.');
    } catch (e) { console.log('Left all orders dated today (could not reach the database to backdate them:', e.message.split('\n')[0] + ')'); }
  }
  console.log(`\nDone. Visit /store/${SLUG}\nSeller login:  ${SELLER.email} / ${PW}   (open /login, you land on /dashboard)\nCustomer login: shopper1${SFX}@eazystores.test / ${PW}   (lands on /account)\nDiscount codes to try at checkout: WELCOME10, FREESHIP (needs $50+, delivery)`);
})().catch(e => { console.error(e.message); process.exit(1); });
