import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, q } from '../db.js';
import { sellerCtx } from './studio.js';

/** Words that point at a category even when its name does not contain them ("vase" means pottery). */
const HINTS: Record<string, string[]> = { 'pottery-ceramics': ['mug', 'vase', 'bowl', 'plate', 'cup', 'teapot', 'stoneware', 'glaze', 'dish', 'jug', 'tumbler', 'planter', 'porcelain'], 'candles-home-fragrance': ['candle', 'wax', 'diffuser', 'incense', 'melt', 'soy'], 'art-prints': ['print', 'painting', 'poster', 'illustration', 'drawing', 'canvas', 'giclee'], jewellery: ['ring', 'necklace', 'earring', 'bracelet', 'pendant', 'brooch'],
  'hair-wigs': ['hair', 'wig', 'bundle', 'extension', 'weave', 'lace'], 'perfume-fragrance': ['perfume', 'parfum', 'cologne', 'oud', 'eau'], 'toys-games': ['toy', 'game', 'puzzle', 'doll', 'plush', 'blocks'], '3d-printing': ['3d', 'printed', 'pla', 'resin', 'filament'], 'clothing-accessories': ['scarf', 'hat', 'shirt', 'dress', 'bag', 'sock', 'mitten', 'toque', 'apron'], 'home-decor': ['decor', 'cushion', 'pillow', 'frame', 'wall', 'throw', 'rug'], 'stationery-paper': ['card', 'notebook', 'journal', 'sticker', 'planner'], 'plants-planters': ['plant', 'succulent', 'terrarium', 'seed'] };
const NOT_UNPAID = `so.status NOT IN ('awaiting_payment','cancelled')`;
/** The studio home: what needs doing today, how the week is going, how far set-up has got. Numbers come straight from orders, stock and page views. */
export function registerStudioDashboard(app: FastifyInstance) {
  app.get('/api/studio/dashboard', async (req) => {
    const s = await sellerCtx(req, 'seller.products.read'); const sid = s.sellerId;
    const [toShip, low, week, prev, daily, visits, recent, shop, profile] = await Promise.all([
      q(`SELECT count(*)::int n, min(ship_by) AS earliest FROM seller_orders WHERE seller_id=$1 AND status IN ('new','accepted')`, [sid]),
      q(`SELECT p.id, p.title, v.options, (v.stock_on_hand - v.stock_reserved)::int AS left FROM products p JOIN variants v ON v.product_id=p.id AND v.status='active' AND v.tracks_stock WHERE p.seller_id=$1 AND p.status='published' AND v.stock_on_hand - v.stock_reserved BETWEEN 1 AND 2 ORDER BY 4, p.title LIMIT 3`, [sid]),
      q(`SELECT coalesce(sum(items_cents + shipping_cents),0)::int AS sales, count(*)::int AS orders FROM seller_orders so WHERE seller_id=$1 AND ${NOT_UNPAID} AND created_at >= now() - interval '7 days'`, [sid]),
      q(`SELECT coalesce(sum(items_cents + shipping_cents),0)::int AS sales FROM seller_orders so WHERE seller_id=$1 AND ${NOT_UNPAID} AND created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days'`, [sid]),
      q(`SELECT d::date AS day, coalesce(sum(so.items_cents + so.shipping_cents),0)::int AS cents FROM generate_series(current_date - 6, current_date, '1 day') d LEFT JOIN seller_orders so ON so.seller_id=$1 AND ${NOT_UNPAID} AND so.created_at::date = d::date GROUP BY d ORDER BY d`, [sid]),
      q(`SELECT coalesce(sum(views),0)::int AS n FROM shop_views WHERE shop_id=$1 AND day >= current_date - 6`, [s.shopId]),
      q(`SELECT so.id, so.status, (so.items_cents + so.shipping_cents) AS sales_cents, so.ship_by, so.created_at, o.number, o.buyer_name, o.ship_to->>'city' AS city, (SELECT l.title || CASE WHEN count(*) OVER() > 1 THEN '' ELSE '' END FROM order_lines l WHERE l.seller_order_id=so.id ORDER BY l.id LIMIT 1) AS title,
          (SELECT coalesce(sum(quantity),0)::int FROM order_lines l WHERE l.seller_order_id=so.id) AS qty, (SELECT l.variant_label FROM order_lines l WHERE l.seller_order_id=so.id ORDER BY l.id LIMIT 1) AS variant, (SELECT l.art_kind FROM order_lines l WHERE l.seller_order_id=so.id ORDER BY l.id LIMIT 1) AS art_kind, (SELECT l.art_tone FROM order_lines l WHERE l.seller_order_id=so.id ORDER BY l.id LIMIT 1) AS art_tone,
          (SELECT l.image_media_id FROM order_lines l WHERE l.seller_order_id=so.id ORDER BY l.id LIMIT 1) AS image
        FROM seller_orders so JOIN orders o ON o.id=so.order_id WHERE so.seller_id=$1 AND so.status<>'awaiting_payment' ORDER BY so.created_at DESC LIMIT 5`, [sid]),
      q(`SELECT s.name, s.slug, s.status, s.look, s.look_chosen, (SELECT count(*) FROM products p WHERE p.shop_id=s.id AND p.status='published')::int AS published FROM shops s WHERE s.id=$1`, [s.shopId]),
      q(`SELECT bool_or(free_over_cents IS NOT NULL OR base_cents = 0) AS free FROM shipping_profiles WHERE seller_id=$1 AND is_default`, [sid]),
    ]);
    const sales = week.rows[0].sales as number, before = prev.rows[0].sales as number; const sh = shop.rows[0];
    return {
      firstName: s.user.fullName.split(' ')[0], shop: { name: sh.name, slug: sh.slug, status: sh.status, look: sh.look },
      tasks: { ordersToShip: toShip.rows[0].n, shipBy: toShip.rows[0].earliest, messagesToAnswer: Number((await q(`SELECT count(*) n FROM threads WHERE seller_id=$1 AND last_sender='buyer'`, [sid])).rows[0].n), lowStock: low.rows.map(r => ({ productId: r.id, title: r.title, variant: Object.values(r.options as Record<string, string>).join(' · ') || null, left: r.left })) },
      week: { salesCents: sales, orders: week.rows[0].orders, visits: visits.rows[0].n, changePct: before > 0 ? Math.round(((sales - before) / before) * 100) : null, daily: daily.rows.map(r => ({ day: r.day, cents: r.cents })) },
      checklist: [{ key: 'shop', label: 'Create your shop', done: true }, { key: 'product', label: 'Add your first product', done: sh.published > 0 || (await q('SELECT 1 FROM products WHERE seller_id=$1 LIMIT 1', [sid])).rowCount! > 0 },
        { key: 'look', label: 'Choose your shop look', done: sh.look_chosen }, { key: 'payouts', label: 'Set up payouts', done: false /* payouts connect to a payment provider, which is not built yet */ }, { key: 'freeShipping', label: 'Offer free shipping', done: !!profile.rows[0]?.free }],
      recent: recent.rows.map(r => ({ id: r.id, number: Number(r.number), title: r.title, variant: r.variant, shipBy: r.ship_by, qty: r.qty, buyerName: r.buyer_name, city: r.city, createdAt: r.created_at, salesCents: r.sales_cents, status: r.status, art: r.art_kind ? { kind: r.art_kind, tone: r.art_tone ?? 'warm' } : null, image: r.image ? `/api/studio/media/${r.image}/w320` : null })),
    };
  });

  /** "Pottery & ceramics · suggested": the seller's own categories ranked by words in the title. Never invents a category they did not pick. */
  app.get('/api/studio/suggest-category', async (req) => {
    const s = await sellerCtx(req, 'seller.products.read'); const { title } = z.object({ title: z.string().trim().max(140).default('') }).parse(req.query);
    const cats = (await q(`SELECT c.slug, c.name, c.tile_name FROM seller_categories sc JOIN categories c ON c.id=sc.category_id WHERE sc.seller_id=$1 ORDER BY c.sort`, [s.sellerId])).rows; if (!cats.length) return { slug: null, name: null, suggested: false };
    const stem = (w: string) => w.replace(/s$/, ''); const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2).map(stem);
    const score = (c: any) => { const own = `${c.name} ${c.tile_name ?? ''} ${c.slug}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2).map(stem); const hints = (HINTS[c.slug] ?? []).map(stem); return words.filter(w => own.includes(w) || hints.includes(w)).length; };
    const ranked = cats.map(c => ({ c, n: score(c) })).sort((a, b) => b.n - a.n); const top = ranked[0]; return { slug: top.c.slug, name: top.c.name, suggested: top.n > 0 || cats.length === 1 };
  });
}
void pool;
