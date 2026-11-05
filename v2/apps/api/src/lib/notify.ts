import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { pool, type Client } from '../db.js';

export type Category = 'orders' | 'messages' | 'reviews';
/** Which preference each email template belongs to. Transactional ones (receipts, shipping, refunds, new orders for sellers) are always sent. */
export const TEMPLATE_CATEGORY: Record<string, { category: Category; transactional: boolean }> = {
  order_confirmation: { category: 'orders', transactional: true }, seller_new_order: { category: 'orders', transactional: true }, order_shipped: { category: 'orders', transactional: true }, refund_issued: { category: 'orders', transactional: true }, order_cancelled: { category: 'orders', transactional: true },
  review_request: { category: 'reviews', transactional: false }, new_review: { category: 'reviews', transactional: false }, review_reply: { category: 'reviews', transactional: false }, new_message: { category: 'messages', transactional: false },
};
export const CATEGORIES: { key: Category; label: string; description: string; transactional: boolean }[] = [
  { key: 'orders', label: 'Orders and shipping', description: 'Receipts, shipping updates, refunds and new orders. Emails about your orders are always sent.', transactional: true },
  { key: 'messages', label: 'Messages', description: 'When a buyer or maker writes to you.', transactional: false },
  { key: 'reviews', label: 'Reviews', description: 'Review requests, new reviews and replies.', transactional: false },
];
const DEFAULTS: Record<Category, { email: boolean; push: boolean }> = { orders: { email: true, push: true }, messages: { email: true, push: true }, reviews: { email: true, push: false } };

export async function prefFor(c: Client | typeof pool, email: string, category: Category) {
  const r = (await c.query('SELECT email_enabled, push_enabled FROM notification_prefs WHERE email=$1 AND category=$2', [email, category])).rows[0];
  return { email: r ? r.email_enabled : DEFAULTS[category].email, push: r ? r.push_enabled : DEFAULTS[category].push };
}
export const allPrefs = async (c: Client | typeof pool, email: string) => Promise.all(CATEGORIES.map(async x => ({ key: x.key, label: x.label, description: x.description, transactional: x.transactional, ...(await prefFor(c, email, x.key)), ...(x.transactional ? { email: true } : {}) })));

// ---- unsubscribe links: signed, so nobody can switch off someone else's mail by guessing an address
const sig = (body: string) => createHmac('sha256', config.notifySecret).update(body).digest('base64url');
export function unsubscribeToken(email: string, category: Category) { const b = Buffer.from(JSON.stringify({ e: email, c: category })).toString('base64url'); return `${b}.${sig(b)}`; }
export function readUnsubscribeToken(t: string): { email: string; category: Category } | null {
  const [b, s] = t.split('.'); if (!b || !s) return null; const want = Buffer.from(sig(b)); const got = Buffer.from(s); if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { const j = JSON.parse(Buffer.from(b, 'base64url').toString()); return CATEGORIES.some(x => x.key === j.c && !x.transactional) && typeof j.e === 'string' ? { email: j.e, category: j.c } : null; } catch { return null; }
}

/** The people on a seller's team who should hear about orders, messages and reviews. */
export const sellerUserIds = async (c: Client | typeof pool, sellerId: string) => (await c.query(`SELECT DISTINCT u.id FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.seller_id=$1 AND r.role IN ('seller_owner','seller_manager') AND u.status='active'`, [sellerId])).rows.map(r => r.id as string);
const hasPush = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
/**
 * Tell people something happened: always into their in-app inbox, and onto the phone as a push when they turned push on for that kind of thing,
 * have a device, and the server has push keys. Runs inside the caller's transaction, so a rolled-back event never notifies anyone.
 */
export async function notifyUsers(c: Client | typeof pool, userIds: (string | null | undefined)[], n: { category: Category; kind: string; title: string; body?: string; url: string }) {
  for (const id of new Set(userIds.filter(Boolean) as string[])) {
    const u = (await c.query('SELECT email FROM users WHERE id=$1 AND status=$2', [id, 'active'])).rows[0]; if (!u) continue; const body = (n.body ?? '').slice(0, 140);
    await c.query('INSERT INTO notifications(user_id,category,kind,title,body,url) VALUES ($1,$2,$3,$4,$5,$6)', [id, n.category, n.kind, n.title.slice(0, 200), body, n.url]);
    if (hasPush() && (await prefFor(c, u.email, n.category)).push && (await c.query('SELECT 1 FROM push_subscriptions WHERE user_id=$1 LIMIT 1', [id])).rowCount) await c.query('INSERT INTO push_outbox(user_id,payload) VALUES ($1,$2)', [id, JSON.stringify({ title: n.title.slice(0, 80), body, url: n.url, tag: n.kind })]);
  }
}
