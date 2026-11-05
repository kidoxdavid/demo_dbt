import type { FastifyInstance } from 'fastify';
import { microcache } from '../lib/microcache.js';
import { pool } from '../db.js';
import { allSettings } from '../settings.js';
import { CARD_COLUMNS, CARD_FROM, VISIBLE, toCard } from '../lib/cards.js';
import { mediaUrl } from '../lib/media.js';

/** Everything the home page needs in one request. Curated picks (settings) win; with none set, the newest pieces are shown. */
export function registerHome(app: FastifyInstance) {
  app.get('/api/home', async (_req, reply) => { reply.header('cache-control', 'no-cache'); return microcache('home', homeData); });
  const homeData = async () => {
    const s = await allSettings(); const cards = async (ids: string[], n: number) => {
      const rows = ids.length ? (await pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${VISIBLE} AND p.id = ANY($1::uuid[])`, [ids])).rows : [];
      const by = new Map(rows.map(r => [r.id as string, r])); const picked = ids.map(i => by.get(i)).filter(Boolean);
      return (picked.length ? picked : (await pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${VISIBLE} ORDER BY p.created_at DESC, p.id LIMIT $1`, [n])).rows).slice(0, n).map(toCard);
    };
    const sp = s.home_spotlight as { shop: string; quote: string; art?: { kind: string; tone: string } } | null;
    const shop = sp ? (await pool.query(`SELECT s.name, s.slug, s.city, s.tagline, s.logo_media_id, s.banner_media_id FROM shops s JOIN sellers se ON se.id=s.seller_id WHERE s.slug=$1 AND s.status='live' AND se.status='active'`, [sp.shop])).rows[0] : null;
    const art = shop ? (await pool.query(`SELECT p.art_kind, p.art_tone FROM products p JOIN shops s ON s.id=p.shop_id WHERE s.slug=$1 AND p.status='published' AND p.art_kind IS NOT NULL ORDER BY p.created_at DESC LIMIT 1`, [shop.slug])).rows[0] : null;
    return { promoBar: s.promo_bar, categories: s.home_categories, phone: await cards(s.home_picks_phone as string[], 4), desktop: await cards(s.home_picks_desktop as string[], 4), sectionOrder: s.home_section_order, freeShippingCents: s.free_shipping_threshold_cents,
      spotlight: shop ? { shop: { name: shop.name, slug: shop.slug, city: shop.city, tagline: shop.tagline, logo: mediaUrl(shop.logo_media_id, 'w320'), banner: mediaUrl(shop.banner_media_id, 'w1280') }, quote: sp!.quote, art: sp!.art ?? (art ? { kind: art.art_kind, tone: art.art_tone ?? 'warm' } : null) } : null };
  };
}
