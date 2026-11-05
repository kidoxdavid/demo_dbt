import type { Client } from '../db.js';
import { hashPassword } from '../security.js';

/**
 * DEV ONLY. The fixed demo catalogue from the design brief (Part 2, section 5), so every screen can be built and checked against the mockups.
 * Shop ratings are seeded aggregates (reviews arrive in the engagement phase). Product "photos" are the illustrated placeholders (art_kind, art_tone).
 */
interface Shop { slug: string; name: string; city: string; region: string; tagline: string; tier?: 'verified_maker'; rating?: [number, number]; look?: string; story?: string; badges?: string[] }
const SHOPS: Shop[] = [
  { slug: 'clay-ember', name: 'Clay & Ember', city: 'Calgary', region: 'AB', tagline: 'Wheel-thrown stoneware from Calgary', tier: 'verified_maker', rating: [4.9, 128], badges: ['handmade', 'small_batch'],
    story: 'Small-batch pottery, thrown and glazed by hand in my garage studio. Every piece is food-safe and one of a kind.' },
  { slug: 'harper-pine', name: 'Harper & Pine', city: 'Vancouver', region: 'BC', tagline: 'Limited-run prints of the Canadian landscape', rating: [4.8, 61] },
  { slug: 'ember-lane', name: 'Ember Lane', city: 'Halifax', region: 'NS', tagline: 'Hand-poured candles', rating: [4.9, 212], badges: ['handmade', 'small_batch'] },
  { slug: 'layer-lab', name: 'Layer Lab', city: 'Edmonton', region: 'AB', tagline: 'Practical 3D-printed goods', rating: [4.7, 94] },
  { slug: 'crown-hair-co', name: 'Crown Hair Co.', city: 'Toronto', region: 'ON', tagline: 'Hair extensions and wigs', rating: [4.8, 340] },
  { slug: 'maison-nuit', name: 'Maison Nuit', city: 'Montreal', region: 'QC', tagline: 'Small-batch fragrance', rating: [4.9, 77] },
  { slug: 'kiln-co', name: 'Kiln & Co.', city: 'Winnipeg', region: 'MB', tagline: 'Everyday ceramics', rating: [4.8, 156], badges: ['handmade'] },
  { slug: 'studio-marlow', name: 'Studio Marlow', city: 'Victoria', region: 'BC', tagline: 'Considered tableware', rating: [4.7, 83] },
];
interface Prod { shop: string; title: string; cat: string; extra?: string[]; price: number; was?: number; chip?: string; art: [string, string]; ooak?: boolean; handmade?: boolean; madeIn?: string; hoursAgo: number; desc: string; attrs?: Record<string, unknown>; stock?: number; sales?: number }
const PRODUCTS: Prod[] = [
  // Home (newest first): the phone shows the first four; the desktop row shows Amber & oud in the fourth slot (see docs/DECISIONS.md)
  { shop: 'harper-pine', title: 'Dusk over the hills, A4 print', cat: 'art-prints', price: 3800, chip: 'Limited', art: ['print', 'warm'], hoursAgo: 1, desc: 'A limited run of 100 giclée prints on 280 gsm cotton paper. Signed and numbered.', attrs: { original_or_print: 'print', width_cm: 21, height_cm: 29.7, framed: false, edition_size: 100 }, stock: 40, sales: 31 },
  { shop: 'ember-lane', title: 'Cedar & fig soy candle', cat: 'candles-home-fragrance', price: 2600, handmade: true, art: ['candle', 'sand'], hoursAgo: 2, desc: 'Cedarwood and ripe fig in a hand-poured soy blend. 200 g, about 45 hours.', attrs: { wax: 'soy', scent: 'Cedar and fig', burn_time_h: 45, weight_g: 200 }, stock: 60, sales: 190 },
  { shop: 'layer-lab', title: 'Geometric desk planter', cat: '3d-printing', extra: ['plants-planters'], price: 2400, art: ['print3d', 'sky'], hoursAgo: 3, desc: 'A faceted desk planter printed in recycled PLA. Drainage insert included.', attrs: { material: 'pla', print_to_order: false, finish: 'sanded', width_cm: 10, height_cm: 9, depth_cm: 10 }, stock: 35, sales: 44 },
  { shop: 'crown-hair-co', title: 'Body wave bundle, 18 in', cat: 'hair-wigs', price: 11800, was: 14000, art: ['hair', 'stone'], hoursAgo: 4, desc: 'Double-drawn body wave bundle, 18 inch, 100 g. Can be coloured and heat styled.', attrs: { length_in: 18, texture: 'body-wave', hair_type: 'human', origin: 'Ethically sourced, Vietnam', weight_g: 100, sold_as_set: false }, stock: 18, sales: 120 },
  { shop: 'maison-nuit', title: 'Amber & oud eau de parfum, 50 ml', cat: 'perfume-fragrance', price: 9600, was: 11000, art: ['perfume', 'butter'], hoursAgo: 5, desc: 'Warm amber over smoked oud with a trace of vanilla. 50 ml.', attrs: { volume_ml: 50, concentration: 'eau-de-parfum', fragrance_family: 'amber', notes: 'Oud, amber, vanilla', flammable: true }, stock: 22, sales: 58 },
  // The basket mockup has Clay & Ember selling a candle too (poured in their own seconds): a second, older product so the basket shows two makers
  { shop: 'clay-ember', title: 'Cedar & fig candle', cat: 'candles-home-fragrance', price: 2600, handmade: true, art: ['candle', 'sand'], hoursAgo: 30, desc: 'Cedar and fig, poured into a small stoneware pot. 200 g.', attrs: { wax: 'soy', scent: 'Cedar and fig', burn_time_h: 40, weight_g: 200 }, stock: 20 },
  // Category page: Pottery & ceramics (these six lead the listing, in this order)
  { shop: 'clay-ember', title: 'Speckled stoneware mug', cat: 'pottery-ceramics', price: 3400, ooak: true, art: ['pottery', 'blush'], hoursAgo: 10, desc: 'A wheel-thrown mug with a speckled oatmeal glaze. 350 ml. No two are alike.', attrs: { technique: 'wheel-thrown', dishwasher_safe: true, microwave_safe: true, height_cm: 9, width_cm: 8 }, stock: 1, madeIn: 'Alberta', handmade: true },
  { shop: 'kiln-co', title: 'Tall bud vase, matte glaze', cat: 'pottery-ceramics', price: 4800, art: ['pottery', 'sand'], hoursAgo: 11, desc: 'A tall, narrow vase with a soft matte glaze for a single stem.', attrs: { technique: 'wheel-thrown', height_cm: 24, width_cm: 8 }, stock: 9 },
  { shop: 'clay-ember', title: 'Hand-built planter', cat: 'pottery-ceramics', extra: ['plants-planters'], price: 4200, handmade: true, art: ['planter', 'sage'], hoursAgo: 12, desc: 'A hand-built planter with a drainage hole and saucer.', attrs: { technique: 'hand-built', height_cm: 14, width_cm: 15 }, stock: 7, madeIn: 'Alberta' },
  { shop: 'studio-marlow', title: 'Serving bowl, ash glaze', cat: 'pottery-ceramics', price: 6400, art: ['pottery', 'warm'], hoursAgo: 13, desc: 'A generous serving bowl in a natural ash glaze.', attrs: { technique: 'wheel-thrown', dishwasher_safe: true, height_cm: 10, width_cm: 26 }, stock: 5 },
  { shop: 'kiln-co', title: 'Trinket dish set of 3', cat: 'pottery-ceramics', price: 2900, was: 3600, art: ['pottery', 'stone'], hoursAgo: 14, desc: 'Three small dishes for rings, pins and keys.', attrs: { technique: 'slip-cast', dishwasher_safe: true }, stock: 14 },
  { shop: 'studio-marlow', title: 'Espresso cup pair', cat: 'pottery-ceramics', price: 4400, art: ['pottery', 'butter'], hoursAgo: 15, desc: 'Two espresso cups with a warm butter glaze.', attrs: { technique: 'wheel-thrown', dishwasher_safe: true, microwave_safe: true }, stock: 8 },
];
const FILLER_SHOPS = 35, FILLER_PRODUCTS = 405;       // 6 listed + the product-page vase + 405 = 412 pottery pieces; 3 + 35 = 38 makers
const FILLER_WORDS = { a: ['Speckled', 'Glazed', 'Hand-pinched', 'Matte', 'Ash-glazed', 'Celadon', 'Raw clay', 'Satin', 'Reactive', 'Wood-fired'], b: ['mug', 'bowl', 'vase', 'plate', 'jug', 'planter', 'dish', 'cup', 'teapot', 'tumbler', 'platter', 'salt cellar'], tone: ['warm', 'sand', 'blush', 'sage', 'stone', 'butter'] };

const BUD_VASE = { shop: 'clay-ember', title: 'Tall bud vase in terracotta glaze', cat: 'pottery-ceramics', handmade: true, madeIn: 'Alberta', hoursAgo: 20 };

export async function seedDemoCatalogue(c: Client, password: string) {
  if ((await c.query(`SELECT 1 FROM shops WHERE slug='clay-ember'`)).rowCount) return false;                          // already seeded
  const hash = await hashPassword(password); const cats = new Map((await c.query('SELECT id, slug FROM categories')).rows.map(r => [r.slug as string, r.id as string]));
  const shopIds = new Map<string, { shop: string; seller: string }>();
  const mkShop = async (s: Shop, owner?: string) => {
    const seller = (await c.query(`INSERT INTO sellers(legal_name, verification_tier) VALUES ($1,$2) RETURNING id`, [s.name, s.tier ?? 'basic'])).rows[0].id;
    const shop = (await c.query(`INSERT INTO shops(seller_id,slug,name,tagline,story,city,region,look,status,badges,rating_avg,rating_count,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'live',$9,$10,$11,now()) RETURNING id`,
      [seller, s.slug, s.name, s.tagline, s.story ?? null, s.city, s.region, s.look ?? 'atelier', s.badges ?? [], s.rating?.[0] ?? null, s.rating?.[1] ?? 0])).rows[0].id;
    await c.query(`UPDATE shops SET policies=$2 WHERE id=$1`, [shop, JSON.stringify({ returns: { template: 'standard', text: 'Returns accepted within 14 days of delivery if the item is unused and in its original packaging.' } })]);
    if (owner) { const u = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id', [owner.split('|')[0], hash, owner.split('|')[1]])).rows[0].id;
      await c.query(`INSERT INTO user_roles(user_id,role,seller_id) VALUES ($1,'seller_owner',$2) ON CONFLICT DO NOTHING`, [u, seller]); }
    // Shipping and processing times for the brief's two featured shops; everyone else gets a $9.00 flat default.
    const feat: Record<string, { free: number | null; tmin: number; tmax: number; pmin: number; pmax: number }> = { 'clay-ember': { free: null, tmin: 5, tmax: 8, pmin: 2, pmax: 3 }, 'harper-pine': { free: 3500, tmin: 5, tmax: 7, pmin: 1, pmax: 2 } };
    const f = feat[s.slug] ?? { free: null, tmin: 5, tmax: 8, pmin: 2, pmax: 3 };
    await c.query(`INSERT INTO shipping_profiles(seller_id,name,is_default,base_cents,free_over_cents,transit_days_min,transit_days_max) VALUES ($1,'Standard shipping',true,900,$2,$3,$4)`, [seller, f.free, f.tmin, f.tmax]);
    await c.query('UPDATE shops SET processing_days_min=$2, processing_days_max=$3 WHERE id=$1', [shop, f.pmin, f.pmax]);
    shopIds.set(s.slug, { shop, seller }); return { shop, seller };
  };
  await mkShop(SHOPS[0], 'amara@clayember.test|Amara Okafor'); for (const s of SHOPS.slice(1)) await mkShop(s);

  const insertProduct = async (shopSlug: string, o: { title: string; cat: string; extra?: string[]; desc?: string; handmade?: boolean; madeIn?: string; ooak?: boolean; chip?: string; art: [string, string]; hoursAgo: number; sales?: number; attrs?: Record<string, unknown> }) => {
    const { shop, seller } = shopIds.get(shopSlug)!;
    const p = (await c.query(`INSERT INTO products(shop_id,seller_id,title,description,category_id,handmade,made_in,one_of_a_kind,chip_override,art_kind,art_tone,status,published_at,created_at,updated_at,sales_count,dangerous_goods)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'published', now() - ($12 || ' hours')::interval, now() - ($12 || ' hours')::interval, now() - ($12 || ' hours')::interval, $13, $14) RETURNING id`,
      [shop, seller, o.title, o.desc ?? '', cats.get(o.cat)!, !!o.handmade, o.madeIn ?? null, !!o.ooak, o.chip ?? null, o.art[0], o.art[1], String(o.hoursAgo), o.sales ?? 0, !!(o.attrs as any)?.flammable])).rows[0].id as string;
    for (const slug of new Set([o.cat, ...(o.extra ?? [])])) await c.query('INSERT INTO product_categories(product_id,category_id) VALUES ($1,$2)', [p, cats.get(slug)!]);
    for (const [k, v] of Object.entries(o.attrs ?? {})) await c.query('INSERT INTO product_attribute_values(product_id,key,value) VALUES ($1,$2,$3)', [p, k, JSON.stringify(v)]);
    return p;
  };
  const addVariant = (p: string, price: number, stock: number, was?: number, options: Record<string, string> = {}, position = 0) =>
    c.query('INSERT INTO variants(product_id,position,options,price_cents,compare_at_cents,stock_on_hand) VALUES ($1,$2,$3,$4,$5,$6)', [p, position, JSON.stringify(options), price, was ?? null, stock]);
  const VARIANT_LABELS: Record<string, Record<string, string>> = { 'Dusk over the hills, A4 print': { Size: 'A4 print', Frame: 'Unframed' }, 'Cedar & fig soy candle': { Size: '200 g' }, 'Cedar & fig candle': { Size: '200 g' } };
  for (const o of PRODUCTS) {
    const p = await insertProduct(o.shop, { ...o, handmade: o.handmade, madeIn: o.madeIn }); const opts = VARIANT_LABELS[o.title];
    if (opts) for (const [i, [name, value]] of Object.entries(opts).entries()) { const oid = (await c.query(`INSERT INTO product_options(product_id,position,name) VALUES ($1,$2,$3) RETURNING id`, [p, i, name])).rows[0].id; await c.query('INSERT INTO product_option_values(option_id,position,value,is_default) VALUES ($1,0,$2,true)', [oid, value]); }
    await addVariant(p, o.price, o.stock ?? 5, o.was, opts ?? {});
  }

  // The product-page hero: sizes x glazes, Medium + Terracotta pre-selected, one variant running low (the studio "1 left" card)
  const vase = await insertProduct(BUD_VASE.shop, { ...BUD_VASE, art: ['pottery', 'blush'], desc: 'A tall, slender bud vase thrown on the wheel and finished in a warm terracotta glaze. Made to hold a single stem or a small handful of dried flowers. Watertight, with a glazed interior.',
    attrs: { technique: 'wheel-thrown', glaze: 'Terracotta', dishwasher_safe: false, microwave_safe: false, height_cm: 24, width_cm: 9 }, sales: 12 });
  const sizes = [['Small', 4200], ['Medium', 4800], ['Large', 5600]] as const; const glazes = [['Terracotta', '#b8704a'], ['Oat', '#e8dccb'], ['Forest', '#3d5a4b'], ['Charcoal', '#2c2620']] as const;
  const so = (await c.query(`INSERT INTO product_options(product_id,position,name) VALUES ($1,0,'Size') RETURNING id`, [vase])).rows[0].id; const go = (await c.query(`INSERT INTO product_options(product_id,position,name) VALUES ($1,1,'Glaze') RETURNING id`, [vase])).rows[0].id;
  for (const [i, [v]] of sizes.entries()) await c.query('INSERT INTO product_option_values(option_id,position,value,is_default) VALUES ($1,$2,$3,$4)', [so, i, v, v === 'Medium']);
  for (const [i, [v, sw]] of glazes.entries()) await c.query('INSERT INTO product_option_values(option_id,position,value,swatch,is_default) VALUES ($1,$2,$3,$4,$5)', [go, i, v, sw, v === 'Terracotta']);
  let pos = 0; for (const [sz, price] of sizes) for (const [gl] of glazes) await addVariant(vase, price, sz === 'Large' && gl === 'Charcoal' ? 1 : 6, undefined, { Size: sz, Glaze: gl }, pos++);

  // Pottery & ceramics reaches 412 pieces from 38 makers (the numbers on the category mockup): filler makers and pieces, older than the six above
  const wordsA = FILLER_WORDS.a, wordsB = FILLER_WORDS.b;
  for (let i = 1; i <= FILLER_SHOPS; i++) { const n = String(i).padStart(2, '0'); await mkShop({ slug: `ceramics-maker-${n}`, name: `Ceramics Maker ${n}`, city: ['Calgary', 'Toronto', 'Halifax', 'Ottawa', 'Regina'][i % 5], region: ['AB', 'ON', 'NS', 'ON', 'SK'][i % 5], tagline: 'Small-batch ceramics', rating: [4.5 + (i % 5) / 10, 5 + i] }); }
  for (let i = 0; i < FILLER_PRODUCTS; i++) {
    const slug = `ceramics-maker-${String((i % FILLER_SHOPS) + 1).padStart(2, '0')}`; const title = `${wordsA[i % wordsA.length]} ${wordsB[(i * 7) % wordsB.length]} ${Math.floor(i / 12) + 1}`;
    const p = await insertProduct(slug, { title, cat: 'pottery-ceramics', handmade: i % 3 === 0, art: ['pottery', FILLER_WORDS.tone[i % 6]], hoursAgo: 100 + i, sales: i % 17, attrs: { material: ['stoneware', 'porcelain', 'earthenware', 'terracotta'][i % 4], size: ['small', 'medium', 'large'][i % 3], technique: ['wheel-thrown', 'hand-built', 'slip-cast'][i % 3], dishwasher_safe: i % 2 === 0 } });
    await addVariant(p, 1800 + ((i * 137) % 9000), 3 + (i % 9));
  }
  // Curated home: phones show the first four newest, the desktop row swaps the hair bundle for the perfume (the two mockups differ), and the spotlight is Clay & Ember.
  const idOf = async (t: string) => (await c.query('SELECT id FROM products WHERE title=$1', [t])).rows[0].id as string; const titles = { dusk: 'Dusk over the hills, A4 print', cedar: 'Cedar & fig soy candle', planter: 'Geometric desk planter', hair: 'Body wave bundle, 18 in', perfume: 'Amber & oud eau de parfum, 50 ml' };
  const [d, ce, pl, h, pf] = await Promise.all(Object.values(titles).map(idOf)); const put = (k: string, v: unknown) => c.query(`INSERT INTO app_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, JSON.stringify(v)]);
  await put('home_picks_phone', [d, ce, pl, h]); await put('home_picks_desktop', [d, ce, pl, pf]);
  await put('home_spotlight', { shop: 'clay-ember', art: { kind: 'pottery', tone: 'warm' }, quote: '\u201cI started throwing pots in my garage during winter. Now every mug I make finds a home somewhere in Canada.\u201d Amara, Calgary' });
  return true;
}
