import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, pool, q, tx, type Client } from '../db.js';
import { HttpError } from '../errors.js';
import { requirePerm } from '../guards.js';
import { pickAds, readClick, sellerOwed, tokenId } from '../lib/ads.js';
import { VISIBLE, CARD_FROM } from '../lib/cards.js';
import { allFlags, allSettings } from '../settings.js';
import { sellerCtx } from './studio.js';

const uuid = z.string().uuid(); const idp = z.object({ id: uuid });
const flag = async () => { if (!(await allFlags()).ads) throw new HttpError(404, 'feature_off'); };
const kw = z.string().trim().toLowerCase().min(2).max(40);
const campaignIn = z.object({ name: z.string().trim().min(1).max(80), productIds: z.array(uuid).min(1).max(20), bidCents: z.number().int().min(1).max(5000), dailyBudgetCents: z.number().int().min(1).max(100_000), totalBudgetCents: z.number().int().min(1).max(10_000_000).nullable(),
  categories: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(10), keywords: z.array(kw).max(10) }).strict();

/** Per-campaign numbers plus a plain-language reason when it is not serving. */
async function campaignRows(where: string, params: unknown[]) {
  const rows = (await pool.query(`SELECT c.*, se.legal_name, (SELECT name FROM shops WHERE seller_id=se.id LIMIT 1) AS shop,
      coalesce((SELECT sum(impressions) FROM ad_daily d WHERE d.campaign_id=c.id),0)::int AS impressions, coalesce((SELECT sum(clicks) FROM ad_daily d WHERE d.campaign_id=c.id),0)::int AS clicks, coalesce((SELECT sum(spend_cents) FROM ad_daily d WHERE d.campaign_id=c.id),0)::int AS spend,
      coalesce((SELECT sum(spend_cents) FROM ad_daily d WHERE d.campaign_id=c.id AND d.day=current_date),0)::int AS spend_today,
      coalesce((SELECT json_agg(json_build_object('id',p.id,'title',p.title,'status',p.status) ORDER BY p.title) FROM ad_products ap JOIN products p ON p.id=ap.product_id WHERE ap.campaign_id=c.id),'[]') AS products,
      coalesce((SELECT array_agg(value ORDER BY value) FROM ad_targets t WHERE t.campaign_id=c.id AND kind='category'),'{}') AS categories, coalesce((SELECT array_agg(value ORDER BY value) FROM ad_targets t WHERE t.campaign_id=c.id AND kind='keyword'),'{}') AS keywords
    FROM ad_campaigns c JOIN sellers se ON se.id=c.seller_id ${where} ORDER BY c.created_at DESC`, params)).rows;
  const owed = new Map<string, number>(); for (const r of rows) if (!owed.has(r.seller_id)) owed.set(r.seller_id, await sellerOwed(r.seller_id));
  return rows.map(r => { const o = owed.get(r.seller_id) ?? 0;
    const serving = r.status === 'blocked' ? 'blocked' : r.status === 'paused' ? 'paused' : r.status === 'ended' ? 'ended' : r.total_budget_cents !== null && r.spend + r.bid_cents > r.total_budget_cents ? 'budget_reached' : r.spend_today + r.bid_cents > r.daily_budget_cents ? 'daily_budget_reached' : o < r.bid_cents ? 'low_balance' : 'serving';
    return { id: r.id, name: r.name, status: r.status, serving, blockedReason: r.blocked_reason, bidCents: r.bid_cents, dailyBudgetCents: r.daily_budget_cents, totalBudgetCents: r.total_budget_cents, impressions: r.impressions, clicks: r.clicks, spendCents: r.spend, spendTodayCents: r.spend_today, ctr: r.impressions ? Math.round((r.clicks / r.impressions) * 1000) / 10 : 0,
      products: r.products, categories: r.categories, keywords: r.keywords, createdAt: r.created_at, sellerId: r.seller_id, seller: r.legal_name, shop: r.shop }; });
}
async function checkProducts(c: Client | typeof pool, sellerId: string, ids: string[]) {
  const ok = (await c.query(`SELECT p.id FROM products p WHERE p.id = ANY($1::uuid[]) AND p.seller_id=$2 AND p.status='published' AND p.moderation_status<>'removed' AND NOT EXISTS (SELECT 1 FROM product_categories pc JOIN categories cg ON cg.id=pc.category_id WHERE pc.product_id=p.id AND cg.restricted)`, [ids, sellerId])).rows.length;
  if (ok !== new Set(ids).size) throw new HttpError(422, 'product_not_eligible');
}
async function checkTargets(c: Client | typeof pool, cats: string[]) { if (cats.length && Number((await c.query(`SELECT count(*) n FROM categories WHERE slug = ANY($1) AND status='active'`, [cats])).rows[0].n) !== new Set(cats).size) throw new HttpError(422, 'category_not_found'); }
async function setLists(c: Client, id: string, b: { productIds?: string[]; categories?: string[]; keywords?: string[] }) {
  if (b.productIds) { await c.query('DELETE FROM ad_products WHERE campaign_id=$1', [id]); for (const p of new Set(b.productIds)) await c.query('INSERT INTO ad_products(campaign_id,product_id) VALUES ($1,$2)', [id, p]); }
  if (b.categories || b.keywords) { if (b.categories) await c.query(`DELETE FROM ad_targets WHERE campaign_id=$1 AND kind='category'`, [id]); if (b.keywords) await c.query(`DELETE FROM ad_targets WHERE campaign_id=$1 AND kind='keyword'`, [id]);
    for (const v of new Set(b.categories ?? [])) await c.query(`INSERT INTO ad_targets(campaign_id,kind,value) VALUES ($1,'category',$2)`, [id, v]); for (const v of new Set(b.keywords ?? [])) await c.query(`INSERT INTO ad_targets(campaign_id,kind,value) VALUES ($1,'keyword',$2)`, [id, v]); }
}

export function registerAds(app: FastifyInstance) {
  // ---- what shoppers see
  app.get('/api/ads', async req => {
    if (!(await allFlags()).ads) return { items: [] }; const f = z.object({ placement: z.enum(['category', 'search']), category: z.string().regex(/^[a-z0-9-]+$/).optional(), q: z.string().trim().max(80).optional() }).parse(req.query);
    return { items: await pickAds({ placement: f.placement, category: f.category, q: f.q }) };
  });
  /** A shopper opens a sponsored piece. The signed token proves the ad was served, works once, and sets the price. Own-team and repeat clicks are free. */
  app.post('/api/ads/click', async (req, reply) => {
    await flag(); const b = z.object({ token: z.string().min(20).max(600) }).strict().parse(req.body); const t = readClick(b.token); if (!t) throw new HttpError(400, 'invalid_token'); const id = tokenId(b.token);
    const out = await tx(async c => {
      const camp = (await c.query('SELECT * FROM ad_campaigns WHERE id=$1 FOR UPDATE', [t.c])).rows[0]; if (!camp) throw new HttpError(400, 'invalid_token');
      const fresh = (await c.query('INSERT INTO ad_clicks(token_id,campaign_id,product_id,price_cents,charged,ip,user_id) VALUES ($1,$2,$3,$4,false,$5,$6) ON CONFLICT DO NOTHING RETURNING token_id', [id, t.c, t.p, t.k, req.ip, req.user?.id ?? null])).rowCount; if (!fresh) return { charged: false, reason: 'already_used' };
      const no = async (reason: string) => { await c.query('UPDATE ad_clicks SET reason=$2 WHERE token_id=$1', [id, reason]); return { charged: false, reason }; };
      const sid = camp.seller_id as string; if (req.user && (await c.query('SELECT 1 FROM user_roles WHERE user_id=$1 AND seller_id=$2', [req.user.id, sid])).rowCount) return no('own_team');
      if ((await c.query(`SELECT 1 FROM ad_clicks WHERE campaign_id=$1 AND ip=$2 AND charged AND created_at > now() - interval '30 minutes'`, [t.c, req.ip])).rowCount) return no('repeat_click');
      if (camp.status !== 'active') return no('campaign_not_active'); const spent = (await c.query(`SELECT coalesce(sum(spend_cents) FILTER (WHERE day=current_date),0)::int AS today, coalesce(sum(spend_cents),0)::int AS total FROM ad_daily WHERE campaign_id=$1`, [t.c])).rows[0];
      if (spent.today + t.k > camp.daily_budget_cents || (camp.total_budget_cents !== null && spent.total + t.k > camp.total_budget_cents)) return no('budget_reached');
      await c.query('SELECT 1 FROM sellers WHERE id=$1 FOR UPDATE', [sid]); if ((await sellerOwed(sid, c)) < t.k) return no('low_balance');
      const txn = randomUUID(); await c.query(`INSERT INTO ledger_entries(txn_id,seller_id,account,amount_cents,memo) VALUES ($1,$2,'seller_payable',$3,'ad click'),($1,$2,'ad_revenue',$4,'ad click')`, [txn, sid, t.k, -t.k]);     // seller owes less, the platform earns it: sums to zero
      await c.query('UPDATE ad_clicks SET charged=true WHERE token_id=$1', [id]); await c.query(`INSERT INTO ad_daily(campaign_id,product_id,day,clicks,spend_cents) VALUES ($1,$2,current_date,1,$3) ON CONFLICT (campaign_id,product_id,day) DO UPDATE SET clicks=ad_daily.clicks+1, spend_cents=ad_daily.spend_cents+$3`, [t.c, t.p, t.k]);
      return { charged: true, reason: null };
    });
    return reply.send({ charged: out.charged, reason: out.reason, productId: t.p });
  });

  // ---- studio: sellers run their own campaigns
  app.get('/api/studio/ads', async req => {
    await flag(); const s = await sellerCtx(req, 'seller.shop.write'); const st = await allSettings();
    return { minBidCents: st.ads_min_bid_cents, slotsPerPage: st.ads_slots_per_page, owedCents: await sellerOwed(s.sellerId), campaigns: await campaignRows('WHERE c.seller_id=$1', [s.sellerId]) };
  });
  app.get('/api/studio/ads/:id', async req => {
    await flag(); const s = await sellerCtx(req, 'seller.shop.write'); const { id } = idp.parse(req.params); const c = (await campaignRows('WHERE c.id=$1 AND c.seller_id=$2', [id, s.sellerId]))[0]; if (!c) throw new HttpError(404, 'not_found');
    const daily = (await q(`SELECT d::date AS day, coalesce(sum(a.impressions),0)::int AS impressions, coalesce(sum(a.clicks),0)::int AS clicks, coalesce(sum(a.spend_cents),0)::int AS spend FROM generate_series(current_date - 13, current_date, '1 day') d LEFT JOIN ad_daily a ON a.day=d::date AND a.campaign_id=$1 GROUP BY d ORDER BY d`, [id])).rows;
    return { ...c, daily };
  });
  app.post('/api/studio/ads', async (req, reply) => {
    await flag(); const s = await sellerCtx(req, 'seller.shop.write'); const b = campaignIn.parse(req.body); const min = Number((await allSettings()).ads_min_bid_cents);
    if (b.bidCents < min) throw new HttpError(422, 'bid_too_low', { minBidCents: min }); if (b.dailyBudgetCents < b.bidCents) throw new HttpError(422, 'budget_below_bid');
    const id = await tx(async c => { await checkProducts(c, s.sellerId, b.productIds); await checkTargets(c, b.categories);
      const r = (await c.query('INSERT INTO ad_campaigns(seller_id,name,bid_cents,daily_budget_cents,total_budget_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id', [s.sellerId, b.name, b.bidCents, b.dailyBudgetCents, b.totalBudgetCents])).rows[0]; await setLists(c, r.id, b);
      await audit(c, { actor: s.user.id, area: 'studio', action: 'ad.create', entityType: 'ad_campaign', entityId: r.id, next: { bidCents: b.bidCents, dailyBudgetCents: b.dailyBudgetCents, products: b.productIds.length }, ip: req.ip }); return r.id as string; });
    return reply.code(201).send((await campaignRows('WHERE c.id=$1', [id]))[0]);
  });
  app.patch('/api/studio/ads/:id', async req => {
    await flag(); const s = await sellerCtx(req, 'seller.shop.write'); const { id } = idp.parse(req.params); const b = campaignIn.partial().extend({ status: z.enum(['active', 'paused', 'ended']) }).partial().strict().parse(req.body); const min = Number((await allSettings()).ads_min_bid_cents);
    await tx(async c => {
      const cur = (await c.query('SELECT * FROM ad_campaigns WHERE id=$1 AND seller_id=$2 FOR UPDATE', [id, s.sellerId])).rows[0]; if (!cur) throw new HttpError(404, 'not_found');
      if (cur.status === 'blocked') throw new HttpError(409, 'blocked_by_staff'); if (cur.status === 'ended') throw new HttpError(409, 'campaign_ended');
      const bid = b.bidCents ?? cur.bid_cents, daily = b.dailyBudgetCents ?? cur.daily_budget_cents; if (b.bidCents !== undefined && bid < min) throw new HttpError(422, 'bid_too_low', { minBidCents: min }); if (daily < bid) throw new HttpError(422, 'budget_below_bid');
      if (b.productIds) await checkProducts(c, s.sellerId, b.productIds); if (b.categories) await checkTargets(c, b.categories);
      await c.query('UPDATE ad_campaigns SET name=coalesce($2,name), bid_cents=$3, daily_budget_cents=$4, total_budget_cents=CASE WHEN $5::boolean THEN $6 ELSE total_budget_cents END, status=coalesce($7,status), updated_at=now() WHERE id=$1', [id, b.name ?? null, bid, daily, 'totalBudgetCents' in b, b.totalBudgetCents ?? null, b.status ?? null]);
      await setLists(c, id, b); await audit(c, { actor: s.user.id, area: 'studio', action: b.status ? `ad.${b.status === 'active' ? 'resume' : b.status}` : 'ad.update', entityType: 'ad_campaign', entityId: id, prev: { bidCents: cur.bid_cents, dailyBudgetCents: cur.daily_budget_cents, status: cur.status }, next: { bidCents: bid, dailyBudgetCents: daily, status: b.status ?? cur.status }, ip: req.ip });
    });
    return (await campaignRows('WHERE c.id=$1', [id]))[0];
  });

  // ---- marketing: staff see every campaign and can stop one that breaks the rules
  app.get('/api/marketing/ads', async req => { requirePerm(req, 'marketing.write'); const f = z.object({ status: z.enum(['active', 'paused', 'ended', 'blocked']).optional() }).parse(req.query); return campaignRows(`WHERE ($1::text IS NULL OR c.status=$1)`, [f.status ?? null]); });
  app.post('/api/marketing/ads/:id/block', async req => {
    const a = requirePerm(req, 'marketing.write'); const { id } = idp.parse(req.params); const b = z.object({ reason: z.string().trim().min(3).max(300) }).strict().parse(req.body);
    return tx(async c => { const cur = (await c.query('SELECT status FROM ad_campaigns WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!cur) throw new HttpError(404, 'not_found'); if (cur.status === 'blocked') throw new HttpError(409, 'already_blocked');
      await c.query(`UPDATE ad_campaigns SET status='blocked', blocked_reason=$2, updated_at=now() WHERE id=$1`, [id, b.reason]); await audit(c, { actor: a.id, area: 'marketing', action: 'ad.block', entityType: 'ad_campaign', entityId: id, prev: { status: cur.status }, reason: b.reason, ip: req.ip }); return { id, status: 'blocked' }; });
  });
  app.post('/api/marketing/ads/:id/unblock', async req => {
    const a = requirePerm(req, 'marketing.write'); const { id } = idp.parse(req.params); const b = z.object({ reason: z.string().trim().min(3).max(300) }).strict().parse(req.body);
    return tx(async c => { const r = await c.query(`UPDATE ad_campaigns SET status='paused', blocked_reason=NULL, updated_at=now() WHERE id=$1 AND status='blocked' RETURNING id`, [id]); if (!r.rowCount) throw new HttpError(409, 'not_blocked');
      await audit(c, { actor: a.id, area: 'marketing', action: 'ad.unblock', entityType: 'ad_campaign', entityId: id, reason: b.reason, ip: req.ip }); return { id, status: 'paused' }; });
  });
}
void VISIBLE; void CARD_FROM;
