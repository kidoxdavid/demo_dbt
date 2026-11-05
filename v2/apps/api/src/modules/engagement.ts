import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, q, tx, type Client } from '../db.js';
import { HttpError } from '../errors.js';
import { requirePerm, requireUser } from '../guards.js';
import { CARD_COLUMNS, CARD_FROM, VISIBLE, toCard } from '../lib/cards.js';
import { mediaUrl } from '../lib/media.js';
import { enqueue } from '../lib/outbox.js';
import { recomputeShopRating } from '../lib/reviews.js';
import { notifyUsers, sellerUserIds } from '../lib/notify.js';
import { allFlags } from '../settings.js';
import { sellerCtx } from './studio.js';

const uuid = z.string().uuid(); const idp = z.object({ id: uuid }); const body = z.string().trim().min(1).max(2000);
const pageQ = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10), offset: z.coerce.number().int().min(0).default(0) });
const flag = async (k: 'reviews' | 'order_chat') => { if (!(await allFlags())[k]) throw new HttpError(404, 'feature_off'); };
const base = () => process.env.PUBLIC_URL ?? 'http://localhost:5180';
/** "Bea Buyer" becomes "Bea B." so a review never shows a full name. */
const shortName = (n: string) => { const p = n.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0]; };

async function orderByToken(token: string) {
  const o = (await q(`SELECT * FROM orders WHERE public_token=$1 AND status<>'awaiting_payment'`, [token])).rows[0]; if (!o) throw new HttpError(404, 'not_found'); return o;
}
const reviewItem = (r: any) => ({ id: r.id, rating: r.rating, title: r.title, body: r.body, authorName: r.author_name, createdAt: r.created_at, reply: r.seller_reply ? { body: r.seller_reply, at: r.replied_at } : null, ...(r.product_title ? { productTitle: r.product_title, productId: r.product_id } : {}) });
async function summary(col: 'product_id' | 'shop_id', id: string) {
  const rows = (await q(`SELECT rating, count(*)::int n FROM reviews WHERE ${col}=$1 AND status='published' GROUP BY rating`, [id])).rows; const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; for (const r of rows) dist[r.rating] = r.n;
  const count = Object.values(dist).reduce((a, b) => a + b, 0); const total = Object.entries(dist).reduce((a, [k, v]) => a + Number(k) * v, 0); return { count, avg: count ? Math.round((total / count) * 10) / 10 : null, distribution: dist };
}
const sellerEmails = async (c: Client, sellerId: string) => (await c.query(`SELECT DISTINCT u.email FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.seller_id=$1 AND r.role IN ('seller_owner','seller_manager') AND u.status='active'`, [sellerId])).rows.map(r => r.email as string);

/** Add a message and tell the other side by email, at most one pending email per conversation so a chatty thread does not flood an inbox. */
async function addMessage(c: Client, t: any, sender: 'buyer' | 'seller', authorId: string | null, text: string) {
  const recent = Number((await c.query(`SELECT count(*) n FROM messages WHERE thread_id=$1 AND sender=$2 AND created_at > now() - interval '1 hour'`, [t.id, sender])).rows[0].n); if (recent >= 30) throw new HttpError(429, 'too_many_messages');
  const m = (await c.query('INSERT INTO messages(thread_id,sender,author_id,body) VALUES ($1,$2,$3,$4) RETURNING id, created_at', [t.id, sender, authorId, text])).rows[0];
  await c.query(`UPDATE threads SET last_message_at=now(), last_sender=$2, ${sender === 'buyer' ? 'buyer_read_at' : 'seller_read_at'}=now() WHERE id=$1`, [t.id, sender]);
  const shop = (await c.query('SELECT name FROM shops WHERE id=$1', [t.shop_id])).rows[0]; const about = t.product_id ? (await c.query('SELECT title FROM products WHERE id=$1', [t.product_id])).rows[0]?.title : t.seller_order_id ? `order #${(await c.query('SELECT o.number FROM seller_orders so JOIN orders o ON o.id=so.order_id WHERE so.id=$1', [t.seller_order_id])).rows[0]?.number}` : null;
  const targets = sender === 'buyer' ? await sellerEmails(c, t.seller_id) : [t.user_id ? (await c.query('SELECT email FROM users WHERE id=$1', [t.user_id])).rows[0]?.email : t.guest_email].filter(Boolean) as string[];
  for (const to of targets) { if ((await c.query(`SELECT 1 FROM outbox_emails WHERE status='pending' AND template='new_message' AND to_email=$1 AND data->>'threadId'=$2`, [to, t.id])).rowCount) continue;
    await enqueue(c, to, 'new_message', { threadId: t.id, from: sender === 'buyer' ? t.buyer_name : shop.name, about, preview: text, url: sender === 'buyer' ? `${base()}/studio/messages/${t.id}` : t.seller_order_id ? `${base()}/account/messages/${t.id}` : `${base()}/account/messages/${t.id}` }); }
  await notifyUsers(c, sender === 'buyer' ? await sellerUserIds(c, t.seller_id) : [t.user_id], { category: 'messages', kind: 'message', title: `New message from ${sender === 'buyer' ? t.buyer_name : shop.name}`, body: text.slice(0, 60), url: sender === 'buyer' ? `/studio/messages/${t.id}` : `/account/messages/${t.id}` });
  return { id: Number(m.id), createdAt: m.created_at };
}
const msgView = (r: any) => ({ id: Number(r.id), sender: r.sender, body: r.body, createdAt: r.created_at });
const threadMessages = async (id: string) => (await q('SELECT id, sender, body, created_at FROM messages WHERE thread_id=$1 ORDER BY id', [id])).rows.map(msgView);

export function registerEngagement(app: FastifyInstance) {
  const limit = { config: (app as any).authLimit };
  // ================================================== reviews (public)
  app.get('/api/products/:id/reviews', async req => {
    await flag('reviews'); const { id } = idp.parse(req.params); const f = pageQ.parse(req.query); if (!(await pool.query(`SELECT 1 ${CARD_FROM} WHERE ${VISIBLE} AND p.id=$1`, [id])).rowCount) throw new HttpError(404, 'not_found');
    const items = (await q(`SELECT * FROM reviews WHERE product_id=$1 AND status='published' ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [id, f.limit, f.offset])).rows.map(reviewItem); return { ...(await summary('product_id', id)), items };
  });
  app.get('/api/shops/:slug/reviews', async req => {
    await flag('reviews'); const { slug } = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/) }).parse(req.params); const f = pageQ.parse(req.query); const s = (await q(`SELECT s.id FROM shops s JOIN sellers se ON se.id=s.seller_id WHERE s.slug=$1 AND s.status='live' AND se.status='active'`, [slug])).rows[0]; if (!s) throw new HttpError(404, 'not_found');
    const items = (await q(`SELECT r.*, p.title AS product_title FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.shop_id=$1 AND r.status='published' ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [s.id, f.limit, f.offset])).rows.map(reviewItem); return { ...(await summary('shop_id', s.id)), items };
  });
  /** Only someone who received the piece can review it, once per order: the order link (or their account) is the proof. */
  app.post('/api/orders/by-token/:token/reviews', limit, async (req, reply) => {
    await flag('reviews'); const { token } = z.object({ token: z.string().min(20).max(64) }).parse(req.params);
    const b = z.object({ productId: uuid, rating: z.number().int().min(1).max(5), title: z.string().trim().max(100).optional(), body }).strict().parse(req.body); const o = await orderByToken(token);
    const r = await tx(async c => {
      const so = (await c.query(`SELECT so.id, so.seller_id, so.shop_id, so.status FROM seller_orders so JOIN order_lines l ON l.seller_order_id=so.id WHERE so.order_id=$1 AND l.product_id=$2 LIMIT 1`, [o.id, b.productId])).rows[0]; if (!so) throw new HttpError(404, 'not_in_order');
      if (so.status !== 'delivered') throw new HttpError(409, 'not_delivered_yet');
      const row = (await c.query(`INSERT INTO reviews(product_id,shop_id,seller_id,seller_order_id,user_id,author_name,rating,title,body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [b.productId, so.shop_id, so.seller_id, so.id, o.user_id, shortName(o.buyer_name), b.rating, b.title || null, b.body])
        .catch(e => { if (e.code === '23505') throw new HttpError(409, 'already_reviewed'); throw e; })).rows[0];
      const pt = (await c.query('SELECT title FROM products WHERE id=$1', [b.productId])).rows[0]?.title ?? 'a piece'; await notifyUsers(c, await sellerUserIds(c, so.seller_id), { category: 'reviews', kind: 'review', title: `New ${b.rating}-star review of ${pt}`, body: b.body.slice(0, 80), url: '/studio/reviews' });
      for (const to of await sellerEmails(c, so.seller_id)) await enqueue(c, to, 'new_review', { rating: b.rating, product: pt, author: shortName(o.buyer_name), preview: b.body, url: `${base()}/studio/reviews` });
      await recomputeShopRating(c, so.shop_id); await audit(c, { actor: o.user_id, area: 'shop', action: 'review.create', entityType: 'review', entityId: row.id, next: { rating: b.rating }, ip: req.ip }); return row;
    });
    return reply.code(201).send({ id: r.id });
  });

  // ================================================== reviews (studio and staff)
  app.get('/api/studio/reviews', async req => {
    const s = await sellerCtx(req, 'seller.products.read'); const f = pageQ.extend({ unanswered: z.enum(['true']).optional() }).parse(req.query);
    const rows = (await q(`SELECT r.*, p.title AS product_title, count(*) OVER()::int AS total FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.seller_id=$1 AND ($2::boolean IS NOT TRUE OR (r.seller_reply IS NULL AND r.status='published')) ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`, [s.sellerId, f.unanswered === 'true', f.limit, f.offset])).rows;
    return { total: rows[0]?.total ?? 0, items: rows.map(r => ({ ...reviewItem(r), status: r.status, reported: r.report_status === 'open', reportStatus: r.report_status })) };
  });
  app.post('/api/studio/reviews/:id/reply', async req => {
    const s = await sellerCtx(req, 'seller.messages.write'); const { id } = idp.parse(req.params); const b = z.object({ body: z.string().trim().min(1).max(1000) }).strict().parse(req.body);
    const r = await q(`UPDATE reviews SET seller_reply=$3, replied_at=now() WHERE id=$1 AND seller_id=$2 AND status='published' RETURNING id`, [id, s.sellerId, b.body]); if (!r.rowCount) throw new HttpError(404, 'not_found');
    const rv = (await q(`SELECT r.user_id, o.email, o.public_token, p.title, s2.name AS shop FROM reviews r JOIN seller_orders so ON so.id=r.seller_order_id JOIN orders o ON o.id=so.order_id JOIN products p ON p.id=r.product_id JOIN shops s2 ON s2.id=r.shop_id WHERE r.id=$1`, [id])).rows[0];
    if (rv) await tx(async c => { await notifyUsers(c, [rv.user_id], { category: 'reviews', kind: 'review_reply', title: `${rv.shop} replied to your review`, body: b.body.slice(0, 80), url: `/orders/${rv.public_token}` }); await enqueue(c, rv.email, 'review_reply', { shop: rv.shop, product: rv.title, preview: b.body, url: `${base()}/orders/${rv.public_token}` }); });
    await audit(pool, { actor: s.user.id, area: 'studio', action: 'review.reply', entityType: 'review', entityId: id, ip: req.ip }); return { id, reply: { body: b.body } };
  });
  app.post('/api/studio/reviews/:id/report', async req => {
    const s = await sellerCtx(req, 'seller.messages.write'); const { id } = idp.parse(req.params); const b = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    const r = await q(`UPDATE reviews SET reported_at=now(), report_reason=$3, report_status='open' WHERE id=$1 AND seller_id=$2 AND status='published' AND report_status IS DISTINCT FROM 'open' AND report_status IS DISTINCT FROM 'kept' RETURNING id`, [id, s.sellerId, b.reason]); if (!r.rowCount) throw new HttpError(409, 'cannot_report');
    await audit(pool, { actor: s.user.id, area: 'studio', action: 'review.report', entityType: 'review', entityId: id, reason: b.reason, ip: req.ip }); return { id, reported: true };
  });
  app.get('/api/admin/reviews/reported', async req => {
    requirePerm(req, 'catalogue.moderate');
    return (await q(`SELECT r.id, r.rating, r.title, r.body, r.author_name AS "authorName", r.created_at AS "createdAt", r.report_reason AS "reportReason", r.reported_at AS "reportedAt", p.title AS "productTitle", s.name AS shop, r.seller_reply AS reply FROM reviews r JOIN products p ON p.id=r.product_id JOIN shops s ON s.id=r.shop_id WHERE r.report_status='open' ORDER BY r.reported_at`)).rows;
  });
  app.post('/api/admin/reviews/:id', async req => {
    const a = requirePerm(req, 'catalogue.moderate'); const { id } = idp.parse(req.params); const b = z.object({ decision: z.enum(['keep', 'hide']), reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    return tx(async c => {
      const r = (await c.query('SELECT id, shop_id, status, report_status FROM reviews WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!r) throw new HttpError(404, 'not_found'); if (r.report_status !== 'open') throw new HttpError(409, 'not_reported');
      await c.query(`UPDATE reviews SET report_status=$2, status=$3 WHERE id=$1`, [id, b.decision === 'keep' ? 'kept' : 'hidden', b.decision === 'keep' ? 'published' : 'hidden']); await recomputeShopRating(c, r.shop_id);
      await audit(c, { actor: a.id, area: 'admin', action: b.decision === 'keep' ? 'review.keep' : 'review.hide', entityType: 'review', entityId: id, reason: b.reason, ip: req.ip }); return { id, decision: b.decision };
    });
  });

  // ================================================== messages: buyer side
  const threadList = (rows: any[], viewer: 'buyer' | 'seller') => rows.map(r => ({ id: r.id, shop: { name: r.shop_name, slug: r.shop_slug }, buyerName: r.buyer_name, about: r.product_title ?? (r.order_number ? `Order #${r.order_number}` : null), productId: r.product_id, orderNumber: r.order_number ? Number(r.order_number) : null, lastMessage: r.last_body, lastAt: r.last_message_at, lastSender: r.last_sender,
    unread: viewer === 'buyer' ? r.last_sender === 'seller' && (!r.buyer_read_at || r.buyer_read_at < r.last_message_at) : r.last_sender === 'buyer' && (!r.seller_read_at || r.seller_read_at < r.last_message_at) }));
  const THREAD_SELECT = `SELECT t.*, s.name AS shop_name, s.slug AS shop_slug, p.title AS product_title, o.number AS order_number, (SELECT m.body FROM messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_body
    FROM threads t JOIN shops s ON s.id=t.shop_id LEFT JOIN products p ON p.id=t.product_id LEFT JOIN seller_orders so ON so.id=t.seller_order_id LEFT JOIN orders o ON o.id=so.order_id`;
  /** Ask a maker a question about a piece or their shop. Needs an account so the reply has somewhere to go. */
  app.post('/api/shops/:slug/messages', limit, async (req, reply) => {
    await flag('order_chat'); const u = requireUser(req); const { slug } = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/) }).parse(req.params); const b = z.object({ productId: uuid.optional(), body }).strict().parse(req.body);
    const out = await tx(async c => {
      const s = (await c.query(`SELECT s.id, s.seller_id FROM shops s JOIN sellers se ON se.id=s.seller_id WHERE s.slug=$1 AND s.status='live' AND se.status='active'`, [slug])).rows[0]; if (!s) throw new HttpError(404, 'not_found');
      if (b.productId && !(await c.query('SELECT 1 FROM products WHERE id=$1 AND shop_id=$2', [b.productId, s.id])).rowCount) throw new HttpError(404, 'product_not_in_shop');
      if ((await c.query('SELECT 1 FROM user_roles WHERE user_id=$1 AND seller_id=$2', [u.id, s.seller_id])).rowCount) throw new HttpError(409, 'own_shop');          // the shop window hides seller roles, so ask the database
      let t = (await c.query(`SELECT * FROM threads WHERE user_id=$1 AND shop_id=$2 AND seller_order_id IS NULL AND product_id IS NOT DISTINCT FROM $3 FOR UPDATE`, [u.id, s.id, b.productId ?? null])).rows[0];
      if (!t) t = (await c.query(`INSERT INTO threads(shop_id,seller_id,user_id,buyer_name,product_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [s.id, s.seller_id, u.id, shortName(u.fullName), b.productId ?? null])).rows[0];
      await addMessage(c, t, 'buyer', u.id, b.body); return t.id as string;
    });
    return reply.code(201).send({ threadId: out });
  });
  app.get('/api/me/threads', async req => { await flag('order_chat'); const u = requireUser(req); return threadList((await q(`${THREAD_SELECT} WHERE t.user_id=$1 ORDER BY t.last_message_at DESC LIMIT 100`, [u.id])).rows, 'buyer'); });
  app.get('/api/me/threads/:id', async req => {
    await flag('order_chat'); const u = requireUser(req); const { id } = idp.parse(req.params); const t = (await q(`${THREAD_SELECT} WHERE t.id=$1 AND t.user_id=$2`, [id, u.id])).rows[0]; if (!t) throw new HttpError(404, 'not_found');
    await q('UPDATE threads SET buyer_read_at=now() WHERE id=$1', [id]); return { ...threadList([t], 'buyer')[0], unread: false, messages: await threadMessages(id) };
  });
  app.post('/api/me/threads/:id/messages', limit, async (req, reply) => {
    await flag('order_chat'); const u = requireUser(req); const { id } = idp.parse(req.params); const b = z.object({ body }).strict().parse(req.body);
    await tx(async c => { const t = (await c.query('SELECT * FROM threads WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, u.id])).rows[0]; if (!t) throw new HttpError(404, 'not_found'); await addMessage(c, t, 'buyer', u.id, b.body); }); return reply.code(201).send({ threadId: id });
  });
  /** Order chat through the private order link, so guests can write to the maker too. */
  const orderThread = async (token: string, sellerOrderId: string) => {
    const o = await orderByToken(token); const so = (await q(`SELECT so.id, so.shop_id, so.seller_id, s.name FROM seller_orders so JOIN shops s ON s.id=so.shop_id WHERE so.id=$1 AND so.order_id=$2 AND so.status<>'awaiting_payment'`, [sellerOrderId, o.id])).rows[0]; if (!so) throw new HttpError(404, 'not_found'); return { o, so };
  };
  app.get('/api/orders/by-token/:token/messages/:sellerOrderId', async req => {
    await flag('order_chat'); const p = z.object({ token: z.string().min(20).max(64), sellerOrderId: uuid }).parse(req.params); const { so } = await orderThread(p.token, p.sellerOrderId); const t = (await q('SELECT id FROM threads WHERE seller_order_id=$1', [so.id])).rows[0];
    if (t) await q('UPDATE threads SET buyer_read_at=now() WHERE id=$1', [t.id]); return { threadId: t?.id ?? null, shop: so.name, messages: t ? await threadMessages(t.id) : [] };
  });
  app.post('/api/orders/by-token/:token/messages/:sellerOrderId', limit, async (req, reply) => {
    await flag('order_chat'); const p = z.object({ token: z.string().min(20).max(64), sellerOrderId: uuid }).parse(req.params); const b = z.object({ body }).strict().parse(req.body); const { o, so } = await orderThread(p.token, p.sellerOrderId);
    await tx(async c => { let t = (await c.query('SELECT * FROM threads WHERE seller_order_id=$1 FOR UPDATE', [so.id])).rows[0];
      if (!t) t = (await c.query(`INSERT INTO threads(shop_id,seller_id,user_id,guest_email,buyer_name,seller_order_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (seller_order_id) WHERE seller_order_id IS NOT NULL DO UPDATE SET shop_id=threads.shop_id RETURNING *`, [so.shop_id, so.seller_id, o.user_id, o.user_id ? null : o.email, shortName(o.buyer_name), so.id])).rows[0];
      await addMessage(c, t, 'buyer', o.user_id, b.body); }); return reply.code(201).send({ ok: true });
  });

  // ================================================== messages: studio side
  app.get('/api/studio/threads', async req => {
    await flag('order_chat'); const s = await sellerCtx(req, 'seller.messages.write'); const f = z.object({ unread: z.enum(['true']).optional() }).parse(req.query);
    const rows = threadList((await q(`${THREAD_SELECT} WHERE t.seller_id=$1 ORDER BY t.last_message_at DESC LIMIT 100`, [s.sellerId])).rows, 'seller'); return { unread: rows.filter(r => r.unread).length, items: f.unread ? rows.filter(r => r.unread) : rows };
  });
  app.get('/api/studio/threads/:id', async req => {
    await flag('order_chat'); const s = await sellerCtx(req, 'seller.messages.write'); const { id } = idp.parse(req.params); const t = (await q(`${THREAD_SELECT} WHERE t.id=$1 AND t.seller_id=$2`, [id, s.sellerId])).rows[0]; if (!t) throw new HttpError(404, 'not_found');
    await q('UPDATE threads SET seller_read_at=now() WHERE id=$1', [id]); return { ...threadList([t], 'seller')[0], unread: false, sellerOrderId: t.seller_order_id, messages: await threadMessages(id) };
  });
  app.post('/api/studio/threads/:id/messages', async (req, reply) => {
    await flag('order_chat'); const s = await sellerCtx(req, 'seller.messages.write'); const { id } = idp.parse(req.params); const b = z.object({ body }).strict().parse(req.body);
    await tx(async c => { const t = (await c.query('SELECT * FROM threads WHERE id=$1 AND seller_id=$2 FOR UPDATE', [id, s.sellerId])).rows[0]; if (!t) throw new HttpError(404, 'not_found'); await addMessage(c, t, 'seller', s.user.id, b.body); }); return reply.code(201).send({ threadId: id });
  });

  // ================================================== following
  app.get('/api/me/following', async req => {
    const u = requireUser(req); const shops = (await q(`SELECT s.id, s.slug, s.name, s.tagline, s.logo_media_id FROM shop_follows f JOIN shops s ON s.id=f.shop_id JOIN sellers se ON se.id=s.seller_id WHERE f.user_id=$1 AND s.status='live' AND se.status='active' ORDER BY f.created_at DESC`, [u.id])).rows;
    return Promise.all(shops.map(async s => ({ slug: s.slug, name: s.name, tagline: s.tagline, logo: mediaUrl(s.logo_media_id, 'w320'), items: (await pool.query(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${VISIBLE} AND p.shop_id=$1 ORDER BY p.created_at DESC LIMIT 4`, [s.id])).rows.map(toCard) })));
  });
}
