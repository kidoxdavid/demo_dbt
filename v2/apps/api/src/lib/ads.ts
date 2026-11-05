import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { pool, q } from '../db.js';
import { config } from '../config.js';
import { CARD_COLUMNS, CARD_FROM, VISIBLE, toCard, type Card } from './cards.js';
import { allSettings } from '../settings.js';

/** What a seller still owes-to-them in the ledger: ad clicks can only be charged against money they have earned. */
export const sellerOwed = async (sellerId: string, c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> } = pool) => Number((await c.query(`SELECT coalesce(-sum(amount_cents),0)::bigint AS owed FROM ledger_entries WHERE account='seller_payable' AND seller_id=$1`, [sellerId])).rows[0].owed);

const b64 = (s: string) => Buffer.from(s).toString('base64url');
export function signClick(p: { c: string; p: string; k: number }) {
  const body = b64(JSON.stringify({ ...p, e: Date.now() + 30 * 60_000, n: randomBytes(6).toString('hex') })); return `${body}.${createHmac('sha256', config.adSecret).update(body).digest('base64url')}`;
}
export function readClick(token: string): { c: string; p: string; k: number; e: number; n: string } | null {
  const [body, sig] = token.split('.'); if (!body || !sig) return null; const want = createHmac('sha256', config.adSecret).update(body).digest(); let got: Buffer; try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null; try { const j = JSON.parse(Buffer.from(body, 'base64url').toString()); return j.e > Date.now() ? j : null; } catch { return null; }
}
export const tokenId = (token: string) => createHash('sha256').update(token).digest('hex');

export type SponsoredCard = Card & { sponsored: true; token: string };
interface Cand { campaignId: string; sellerId: string; bid: number; createdAt: Date; row: any }
/**
 * Pick sponsored pieces for a page. A piece qualifies only if it is for sale, in stock, not in a restricted category, its seller is active and has the money to pay for a click,
 * its campaign is running within its daily and total budgets, and it matches the page (category tree or search words). Highest bid wins; one ad per seller;
 * the winner pays one cent more than the next bid down, never less than the minimum and never more than its own bid.
 */
export async function pickAds(o: { placement: 'category' | 'search'; category?: string; q?: string; limit?: number }): Promise<SponsoredCard[]> {
  const s = await allSettings(); const slots = Math.min(o.limit ?? 4, Number(s.ads_slots_per_page)); const minBid = Number(s.ads_min_bid_cents); if (slots <= 0) return [];
  const rows = (await pool.query(`SELECT ${CARD_COLUMNS}, c.id AS campaign_id, c.seller_id, c.bid_cents, c.daily_budget_cents, c.total_budget_cents, c.created_at AS campaign_created, p.title AS ptitle, array_to_string(p.tags,' ') AS ptags,
      coalesce((SELECT sum(spend_cents) FROM ad_daily d WHERE d.campaign_id=c.id AND d.day=current_date),0)::int AS spent_today, coalesce((SELECT sum(spend_cents) FROM ad_daily d WHERE d.campaign_id=c.id),0)::int AS spent_total,
      coalesce((SELECT array_agg(cg.slug) FROM product_categories pc JOIN categories cg ON cg.id=pc.category_id WHERE pc.product_id=p.id),'{}') AS cats
    ${CARD_FROM} JOIN ad_products ap ON ap.product_id=p.id JOIN ad_campaigns c ON c.id=ap.campaign_id
    WHERE ${VISIBLE} AND c.status='active' AND NOT EXISTS (SELECT 1 FROM product_categories pc JOIN categories cg ON cg.id=pc.category_id WHERE pc.product_id=p.id AND cg.restricted)
      AND (NOT s.vacation_mode AND EXISTS (SELECT 1 FROM variants x WHERE x.product_id=p.id AND x.status='active' AND (NOT x.tracks_stock OR x.stock_on_hand - x.stock_reserved > 0)))`)).rows;
  if (!rows.length) return [];
  const ids = [...new Set(rows.map(r => r.campaign_id as string))]; const targets = (await q('SELECT campaign_id, kind, value FROM ad_targets WHERE campaign_id = ANY($1::uuid[])', [ids])).rows;
  const tgt = (id: string, kind: string) => targets.filter(t => t.campaign_id === id && t.kind === kind).map(t => t.value as string);
  // the page's category and its parents: a campaign aimed at "home" shows on "kitchen" pages inside it
  let page: string[] = []; if (o.placement === 'category' && o.category) page = (await q(`WITH RECURSIVE up AS (SELECT id, parent_id, slug FROM categories WHERE slug=$1 UNION ALL SELECT c.id, c.parent_id, c.slug FROM categories c JOIN up ON c.id=up.parent_id) SELECT slug FROM up`, [o.category])).rows.map(r => r.slug);
  let down: string[] = []; if (o.placement === 'category' && o.category) down = (await q(`WITH RECURSIVE tree AS (SELECT id, slug FROM categories WHERE slug=$1 UNION ALL SELECT c.id, c.slug FROM categories c JOIN tree t ON c.parent_id=t.id) SELECT slug FROM tree`, [o.category])).rows.map(r => r.slug);
  const words = (o.q ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);
  const owed = new Map<string, number>(); const cands: Cand[] = [];
  for (const r of rows) {
    if (r.spent_today + r.bid_cents > r.daily_budget_cents || (r.total_budget_cents !== null && r.spent_total + r.bid_cents > r.total_budget_cents)) continue;
    const cats = tgt(r.campaign_id, 'category'), keys = tgt(r.campaign_id, 'keyword'); let match = false;
    if (o.placement === 'category') match = cats.length ? cats.some(c => page.includes(c)) : (r.cats as string[]).some(c => down.includes(c));
    else match = keys.some(k => words.includes(k) || (o.q ?? '').toLowerCase().includes(k)) || (!keys.length && words.length > 0 && words.every(w => `${r.ptitle} ${r.ptags}`.toLowerCase().includes(w)));
    if (!match) continue;
    if (!owed.has(r.seller_id)) owed.set(r.seller_id, await sellerOwed(r.seller_id)); if ((owed.get(r.seller_id) ?? 0) < r.bid_cents) continue;
    cands.push({ campaignId: r.campaign_id, sellerId: r.seller_id, bid: r.bid_cents, createdAt: r.campaign_created, row: r });
  }
  cands.sort((a, b) => b.bid - a.bid || a.createdAt.getTime() - b.createdAt.getTime()); const bySeller: Cand[] = []; for (const c of cands) if (!bySeller.some(x => x.sellerId === c.sellerId)) bySeller.push(c);
  const out: SponsoredCard[] = [];
  for (const [i, c] of bySeller.slice(0, slots).entries()) {
    const next = bySeller[i + 1]?.bid; const price = Math.min(c.bid, Math.max(minBid, next !== undefined ? next + 1 : minBid)); if (c.row.spent_today + price > c.row.daily_budget_cents) continue;
    out.push({ ...toCard(c.row), sponsored: true, token: signClick({ c: c.campaignId, p: c.row.id, k: price }) });
    await q(`INSERT INTO ad_daily(campaign_id,product_id,day,impressions) VALUES ($1,$2,current_date,1) ON CONFLICT (campaign_id,product_id,day) DO UPDATE SET impressions=ad_daily.impressions+1`, [c.campaignId, c.row.id]);
  }
  return out;
}
