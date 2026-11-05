import type { Client } from '../db.js';

/** DEV ONLY. Many shops and pieces, made in a few SQL statements, to see how listings and search behave at scale. Titles are two real-ish words and a number so searches have something to find. */
export async function seedLoadData(c: Client, products = 20000, shops = 300) {
  const cats = (await c.query(`SELECT id, slug FROM categories WHERE status='active' AND parent_id IS NULL AND NOT restricted ORDER BY sort`)).rows as { id: string; slug: string }[]; if (!cats.length) throw new Error('run migrations and the base seed first');
  const have = Number((await c.query(`SELECT count(*) n FROM shops WHERE slug LIKE 'load-shop-%'`)).rows[0].n); if (have) return false;
  await c.query(`CREATE TEMP TABLE _l_sellers ON COMMIT DROP AS SELECT gen_random_uuid() AS sid, gen_random_uuid() AS shid, g AS n FROM generate_series(1,$1::int) g`, [shops]);
  await c.query(`INSERT INTO sellers(id, legal_name) SELECT sid, 'Load Seller ' || n FROM _l_sellers`);
  await c.query(`INSERT INTO shops(id, seller_id, slug, name, tagline, city, region, status, rating_avg, rating_count, published_at) SELECT shid, sid, 'load-shop-' || n, 'Load Shop ' || n, 'Made for load tests', 'Calgary', 'AB', 'live', 4.5, 10, now() FROM _l_sellers`);
  await c.query(`CREATE TEMP TABLE _l_prod ON COMMIT DROP AS SELECT gen_random_uuid() AS pid, g AS n, (ARRAY['Speckled','Glazed','Matte','Hand-pinched','Celadon','Woven','Carved','Painted','Dipped','Pressed'])[1 + g % 10] AS a, (ARRAY['mug','bowl','vase','plate','candle','print','ring','scarf','planter','dish','tote','jar'])[1 + (g * 7) % 12] AS b FROM generate_series(1,$1::int) g`, [products]);
  await c.query(`INSERT INTO products(id, shop_id, seller_id, title, description, category_id, handmade, status, moderation_status, published_at, created_at, updated_at, sales_count, tags)
    SELECT p.pid, s.shid, s.sid, p.a || ' ' || p.b || ' ' || p.n, 'A ' || lower(p.a) || ' ' || p.b || ' made in small batches for the load test, number ' || p.n, (SELECT id FROM (SELECT id, row_number() OVER (ORDER BY sort) r FROM categories WHERE status='active' AND parent_id IS NULL AND NOT restricted) x WHERE r = 1 + p.n % $1::int), p.n % 3 = 0, 'published', 'approved', now() - (p.n || ' minutes')::interval, now() - (p.n || ' minutes')::interval, now(), p.n % 50, ARRAY[lower(p.b), lower(p.a)]
    FROM _l_prod p JOIN _l_sellers s ON s.n = 1 + p.n % $2::int`, [cats.length, shops]);
  await c.query(`INSERT INTO product_categories(product_id, category_id) SELECT id, category_id FROM products WHERE title ~ '^[A-Z]' AND category_id IS NOT NULL AND id IN (SELECT pid FROM _l_prod)`);
  await c.query(`INSERT INTO variants(product_id, position, options, price_cents, stock_on_hand) SELECT pid, 0, '{}', 1500 + (n * 37) % 9000, 5 + n % 20 FROM _l_prod`);
  return true;
}
