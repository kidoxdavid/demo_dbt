import { randomBytes } from 'node:crypto';
import { pool, q } from '../db.js';
import { checkout, settlePayment } from '../lib/orders.js';

/** DEV ONLY. A few paid orders and shop visits for Clay & Ember so the studio home has something to show (names and times follow the studio mockup). Goes through the real checkout and payment code. */
export async function seedDemoOrders(now = process.env.EAZY_FAKE_NOW ? new Date(process.env.EAZY_FAKE_NOW) : new Date()) {
  if ((await q(`SELECT 1 FROM orders o JOIN seller_orders so ON so.order_id=o.id JOIN shops s ON s.id=so.shop_id WHERE s.slug='clay-ember'`)).rowCount) return false;
  const variantOf = async (title: string, opts: Record<string, string> = {}) => (await q(`SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id WHERE p.title=$1 AND v.status='active' AND v.options @> $2::jsonb ORDER BY v.position LIMIT 1`, [title, JSON.stringify(opts)])).rows[0].id as string;
  const plan: { title: string; opts?: Record<string, string>; qty: number; who: string; city: string; region: string; postal: string; ago: number; state: string }[] = [
    { title: 'Tall bud vase in terracotta glaze', opts: { Size: 'Medium', Glaze: 'Terracotta' }, qty: 1, who: 'Maya R.', city: 'Edmonton', region: 'AB', postal: 'T5J 0N3', ago: 10 * 60_000, state: 'new' },
    { title: 'Cedar & fig candle', qty: 2, who: 'Jordan K.', city: 'Calgary', region: 'AB', postal: 'T2N 1N4', ago: 65 * 60_000, state: 'new' },
    { title: 'Speckled mug', qty: 1, who: 'Sofia L.', city: 'Toronto', region: 'ON', postal: 'M5V 2T6', ago: 20 * 3600_000, state: 'shipped' },
    { title: 'Hand-built planter', qty: 1, who: 'Priya N.', city: 'Winnipeg', region: 'MB', postal: 'R3C 0A5', ago: 50 * 3600_000, state: 'accepted' },
    { title: 'Hand-built planter', qty: 1, who: 'Chen W.', city: 'Victoria', region: 'BC', postal: 'V8W 1P6', ago: 76 * 3600_000, state: 'delivered' },
  ];
  for (const p of plan) {
    const cart = (await q('INSERT INTO carts(guest_hash) VALUES ($1) RETURNING id', [randomBytes(12).toString('hex')])).rows[0].id; await q('INSERT INTO cart_items(cart_id,variant_id,quantity) VALUES ($1,$2,$3)', [cart, await variantOf(p.title, p.opts), p.qty]);
    const o = await checkout({ cartId: cart, userId: null, email: `${p.who.split(' ')[0].toLowerCase()}@demo.test`, address: { name: p.who, line1: '100 Demo Street', city: p.city, region: p.region, postal: p.postal, country: 'CA' } });
    await settlePayment((o as any).payment.ref, 'succeeded'); const at = new Date(now.getTime() - p.ago);
    await q('UPDATE orders SET created_at=$2, paid_at=$2 WHERE id=$1', [o.orderId, at]); await q('UPDATE seller_orders SET created_at=$2::timestamptz, status=$3::text, tracking_carrier=CASE WHEN $3::text IN (\'shipped\',\'delivered\') THEN \'canada_post\' END, tracking_number=CASE WHEN $3::text IN (\'shipped\',\'delivered\') THEN \'1234567890AB\' END, shipped_at=CASE WHEN $3::text IN (\'shipped\',\'delivered\') THEN $2::timestamptz END, delivered_at=CASE WHEN $3::text = \'delivered\' THEN $2::timestamptz + interval \'1 day\' END WHERE order_id=$1', [o.orderId, at, p.state]);
  }
  const shop = (await q(`SELECT id FROM shops WHERE slug='clay-ember'`)).rows[0].id; const views = [150, 160, 170, 180, 190, 160, 190];       // about 1.2k visits this week
  for (const [i, n] of views.entries()) await q(`INSERT INTO shop_views(shop_id,day,views) VALUES ($1,($2::date - $3::int),$4) ON CONFLICT (shop_id,day) DO UPDATE SET views=EXCLUDED.views`, [shop, now.toISOString().slice(0, 10), 6 - i, n]);
  return true;
}
void pool;
