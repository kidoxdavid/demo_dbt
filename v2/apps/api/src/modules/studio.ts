import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, q, tx, type Client } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { requireFlag } from '../settings.js';
import { requireUser } from '../guards.js';
import { canForSeller, isSellerRole, type SellerPermission, type SessionUser } from '../permissions.js';
import { hashPassword, passwordProblem } from '../security.js';
import { openSession } from '../session.js';
import { freeSlug } from '../lib/slug.js';
import { storeUpload } from '../lib/media.js';
import { sendMedia } from './catalogue.js';

export interface SellerCtx { user: SessionUser; sellerId: string; shopId: string }
/** The seller (and shop) the signed-in studio user works for, checked against the permission needed. A user with several sellers uses the first (multi-shop is out of scope). */
export async function sellerCtx(req: any, perm: SellerPermission): Promise<SellerCtx> {
  const user = requireUser(req); const grant = user.roles.find(r => isSellerRole(r.role)); if (!grant?.sellerId) throw new HttpError(403, 'no_shop');
  if (!canForSeller(user, perm, grant.sellerId)) throw new HttpError(403, 'forbidden');
  const shop = (await q('SELECT id FROM shops WHERE seller_id=$1', [grant.sellerId])).rows[0]; if (!shop) throw new HttpError(403, 'no_shop');
  return { user, sellerId: grant.sellerId, shopId: shop.id };
}
const email = z.string().trim().toLowerCase().email().max(254);
const POLICY_TEMPLATES = {
  standard: 'Returns accepted within 14 days of delivery if the item is unused and in its original packaging. Buyer pays return shipping unless the item arrived damaged or not as described.',
  final_sale: 'All sales are final. If your item arrives damaged or not as described, message me within 7 days and I will make it right.',
  custom: '',
};
const policiesIn = z.object({
  returns: z.object({ template: z.enum(['standard', 'final_sale', 'custom']), text: z.string().max(1500).optional(), days: z.number().int().min(0).max(60).optional() }).strict(),
  pickup: z.object({ enabled: z.boolean(), address: z.string().max(200).optional() }).strict(), destinations: z.array(z.string().length(2)).max(20),
}).partial().strict();

export function registerStudio(app: FastifyInstance) {
  const authLimit = { config: (app as any).authLimit };
  // Raw upload bodies (no multipart dependency). The real type is decided by the first bytes, not this header.
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'], { parseAs: 'buffer', bodyLimit: config.maxVideoBytes }, (_r, body, done) => done(null, body));

  /** Seller sign-up: the person, the seller, the draft shop and the studio session in one step. "What do you sell?" pre-fills everything else. */
  app.post('/api/studio/signup', authLimit, async (req, reply) => {
    const b = z.object({ email, password: z.string().min(1).max(200), fullName: z.string().trim().min(1).max(120), categories: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).max(8), shopName: z.string().trim().min(1).max(80).optional() }).strict().parse(req.body);
    await requireFlag('maker_signups', 'signups_closed', 403);
    const problem = passwordProblem(b.password, b.email); if (problem) throw new HttpError(400, `weak_password:${problem}`); const hash = await hashPassword(b.password);
    const out = await tx(async c => {
      const cats = (await c.query(`SELECT id FROM categories WHERE slug = ANY($1) AND status='active'`, [b.categories])).rows; if (cats.length !== new Set(b.categories).size) throw new HttpError(422, 'unknown_category');
      const u = await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id', [b.email, hash, b.fullName]); if (!u.rowCount) throw new HttpError(409, 'email_in_use');
      const name = b.shopName ?? `${b.fullName.split(' ')[0]}'s shop`; const seller = (await c.query('INSERT INTO sellers(legal_name) VALUES ($1) RETURNING id', [b.fullName])).rows[0];
      const slug = await freeSlug(c, name); const shop = (await c.query('INSERT INTO shops(seller_id,slug,name) VALUES ($1,$2,$3) RETURNING id, slug, name', [seller.id, slug, name])).rows[0];
      await c.query(`INSERT INTO user_roles(user_id,role,seller_id) VALUES ($1,'seller_owner',$2)`, [u.rows[0].id, seller.id]);
      for (const cat of cats) await c.query('INSERT INTO seller_categories(seller_id,category_id) VALUES ($1,$2)', [seller.id, cat.id]);
      await c.query(`INSERT INTO shipping_profiles(seller_id,name,is_default,base_cents,transit_days_min,transit_days_max) VALUES ($1,'Standard shipping',true,900,5,8)`, [seller.id]);        // a sensible default so a first product can be published straight away
      await audit(c, { actor: u.rows[0].id, area: 'studio', action: 'seller.signup', entityType: 'seller', entityId: seller.id, next: { shop: shop.slug, categories: b.categories }, ip: req.ip });
      return { userId: u.rows[0].id as string, sellerId: seller.id as string, shop };
    });
    await openSession(reply, out.userId, 'studio', req.ip, req.headers['user-agent']);
    return reply.code(201).send({ user: { id: out.userId, email: b.email, fullName: b.fullName }, sellerId: out.sellerId, shop: out.shop });
  });

  const shopView = async (c: Client | typeof pool, sellerId: string) => {
    const s = (await c.query(`SELECT s.*, se.verification_tier FROM shops s JOIN sellers se ON se.id=s.seller_id WHERE s.seller_id=$1`, [sellerId])).rows[0];
    const cats = (await c.query(`SELECT c.slug, c.name, c.tile_name, c.seller_tips, c.photo_guide, c.restricted FROM seller_categories sc JOIN categories c ON c.id=sc.category_id WHERE sc.seller_id=$1 ORDER BY c.sort`, [sellerId])).rows;
    const counts = (await c.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='published')::int AS published FROM products WHERE seller_id=$1`, [sellerId])).rows[0];
    return { id: s.id, slug: s.slug, name: s.name, tagline: s.tagline, story: s.story, city: s.city, region: s.region, look: s.look, status: s.status, vacation: s.vacation_mode, processing: { minDays: s.processing_days_min, maxDays: s.processing_days_max },
      logo: s.logo_media_id ? `/api/studio/media/${s.logo_media_id}/w320` : null, banner: s.banner_media_id ? `/api/studio/media/${s.banner_media_id}/w1280` : null, policies: s.policies, badges: s.badges, verificationTier: s.verification_tier,
      categories: cats.map(x => ({ slug: x.slug, name: x.name, tile: x.tile_name, sellerTips: x.seller_tips, photoGuide: x.photo_guide, restricted: x.restricted })), products: counts, policyTemplates: POLICY_TEMPLATES };
  };
  app.get('/api/studio/shop', async (req) => { const s = await sellerCtx(req, 'seller.products.read'); return shopView(pool, s.sellerId); });
  app.patch('/api/studio/shop', async (req) => {
    const s = await sellerCtx(req, 'seller.shop.write');
    const b = z.object({ name: z.string().trim().min(1).max(80), tagline: z.string().trim().max(140).nullable(), story: z.string().trim().max(4000).nullable(), city: z.string().trim().max(60).nullable(), region: z.string().trim().max(40).nullable(),
      look: z.enum(['atelier', 'noir', 'sage', 'blush', 'sky']), slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).min(2).max(50), logoMediaId: z.string().uuid().nullable(), bannerMediaId: z.string().uuid().nullable(),
      processingDaysMin: z.number().int().min(0).max(60), processingDaysMax: z.number().int().min(0).max(60), vacation: z.boolean(), policies: policiesIn, badges: z.array(z.enum(['handmade', 'made_in_canada', 'small_batch'])).max(3) }).partial().strict().parse(req.body);
    return tx(async c => {
      const prev = (await c.query('SELECT * FROM shops WHERE id=$1 FOR UPDATE', [s.shopId])).rows[0];
      for (const [k, kind] of [['logoMediaId', 'image'], ['bannerMediaId', 'image']] as const) { const id = b[k]; if (id && !(await c.query('SELECT 1 FROM media WHERE id=$1 AND seller_id=$2 AND kind=$3', [id, s.sellerId, kind])).rowCount) throw new HttpError(422, `${k}_invalid`); }
      const min = b.processingDaysMin ?? prev.processing_days_min, max = b.processingDaysMax ?? prev.processing_days_max; if (max < min) throw new HttpError(422, 'processing_range_invalid');
      if (b.slug && b.slug !== prev.slug && ['admin', 'api', 'studio', 'support', 'finance', 'marketing', 'shop', 'basket', 'account'].includes(b.slug)) throw new HttpError(409, 'slug_unavailable');
      const pol = b.policies ? { ...prev.policies, ...b.policies } : null; if (pol?.returns?.template && pol.returns.template !== 'custom' && !pol.returns.text) pol.returns.text = POLICY_TEMPLATES[pol.returns.template as 'standard' | 'final_sale'];
      await c.query(`UPDATE shops SET name=coalesce($2,name), tagline=CASE WHEN $3::boolean THEN $4 ELSE tagline END, story=CASE WHEN $5::boolean THEN $6 ELSE story END, city=CASE WHEN $7::boolean THEN $8 ELSE city END, region=CASE WHEN $9::boolean THEN $10 ELSE region END,
        look=coalesce($11,look), slug=coalesce($12,slug), logo_media_id=CASE WHEN $13::boolean THEN $14::uuid ELSE logo_media_id END, banner_media_id=CASE WHEN $15::boolean THEN $16::uuid ELSE banner_media_id END,
        processing_days_min=$17, processing_days_max=$18, vacation_mode=coalesce($19,vacation_mode), policies=coalesce($20::jsonb,policies), badges=coalesce($21,badges) WHERE id=$1`,
        [s.shopId, b.name ?? null, 'tagline' in b, b.tagline ?? null, 'story' in b, b.story ?? null, 'city' in b, b.city ?? null, 'region' in b, b.region ?? null, b.look ?? null, b.slug ?? null, 'logoMediaId' in b, b.logoMediaId ?? null, 'bannerMediaId' in b, b.bannerMediaId ?? null,
         min, max, b.vacation ?? null, pol ? JSON.stringify(pol) : null, b.badges ?? null]).catch(e => { if (e.code === '23505') throw new HttpError(409, 'slug_unavailable'); throw e; });
      if ('look' in b) await c.query('UPDATE shops SET look_chosen=true WHERE id=$1', [s.shopId]);
      await audit(c, { actor: s.user.id, area: 'studio', action: 'shop.update', entityType: 'shop', entityId: s.shopId, prev: { name: prev.name, slug: prev.slug, look: prev.look, vacation: prev.vacation_mode }, next: b, ip: req.ip });
      return shopView(c, s.sellerId);
    });
  });

  // ---- Media
  const uploadLimit = { config: { rateLimit: { max: config.uploadRateLimitMax, timeWindow: '1 minute' } } };
  app.post('/api/studio/media', uploadLimit, async (req, reply) => {
    const s = await sellerCtx(req, 'seller.products.write'); const body = req.body as Buffer; if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'empty_upload');
    const n = Number((await q('SELECT count(*) n FROM media WHERE seller_id=$1', [s.sellerId])).rows[0].n); if (n >= 2000) throw new HttpError(409, 'media_limit');
    const m = await tx(c => storeUpload(c, { sellerId: s.sellerId, userId: s.user.id, buf: body, name: String((req.query as any)?.name ?? '') }));
    return reply.code(201).send({ ...m, urls: m.kind === 'image' ? { w320: `/api/studio/media/${m.id}/w320`, w640: `/api/studio/media/${m.id}/w640`, w1280: `/api/studio/media/${m.id}/w1280` } : { video: `/api/studio/media/${m.id}/video`, poster: `/api/studio/media/${m.id}/poster` } });
  });
  app.get('/api/studio/media/:id/:label', async (req, reply) => {
    const s = await sellerCtx(req, 'seller.products.read'); const { id, label } = z.object({ id: z.string().uuid(), label: z.enum(['w320', 'w640', 'w1280', 'video', 'poster']) }).parse(req.params);
    if (!(await q('SELECT 1 FROM media WHERE id=$1 AND seller_id=$2', [id, s.sellerId])).rowCount) throw new HttpError(404, 'not_found');
    return sendMedia(req, reply, id, label);
  });
}
