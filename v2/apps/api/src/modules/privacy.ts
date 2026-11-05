import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { audit, pool, q, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { cookieName, requireUser } from '../guards.js';
import { hashPassword, verifyPassword } from '../security.js';
import { allPrefs } from '../lib/notify.js';

/**
 * Your data, yours to take and to remove.
 * Export: everything we hold about you, as one file. Delete: personal details are removed or scrubbed; what the law makes us keep about a sale (amounts, GST, province, order numbers) stays, with no name, email or street address on it.
 */
export function registerPrivacy(app: FastifyInstance) {
  const limit = { config: (app as any).authLimit };
  app.get('/api/me/export', limit, async (req, reply) => {
    const u = requireUser(req); const id = u.id;
    const me = (await q('SELECT id, email, full_name AS "fullName", phone, created_at AS "createdAt", email_verified_at AS "emailVerifiedAt" FROM users WHERE id=$1', [id])).rows[0];
    const orders = (await q(`SELECT o.number, o.email, o.buyer_name AS "buyerName", o.ship_to AS "shipTo", o.items_cents AS "itemsCents", o.shipping_cents AS "shippingCents", o.tax_cents AS "taxCents", o.total_cents AS "totalCents", o.status, o.payment_status AS "paymentStatus", o.created_at AS "createdAt",
        coalesce((SELECT json_agg(json_build_object('title',l.title,'variant',l.variant_label,'quantity',l.quantity,'unitCents',l.unit_price_cents,'personalisation',l.personalisation) ORDER BY l.id) FROM order_lines l WHERE l.order_id=o.id),'[]') AS lines FROM orders o WHERE o.user_id=$1 AND o.status<>'awaiting_payment' ORDER BY o.created_at`, [id])).rows;
    const reviews = (await q(`SELECT r.rating, r.title, r.body, r.created_at AS "createdAt", p.title AS product FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.user_id=$1 ORDER BY r.created_at`, [id])).rows;
    const threads = (await q(`SELECT s.name AS shop, t.created_at AS "createdAt", (SELECT json_agg(json_build_object('from',m.sender,'body',m.body,'at',m.created_at) ORDER BY m.id) FROM messages m WHERE m.thread_id=t.id) AS messages FROM threads t JOIN shops s ON s.id=t.shop_id WHERE t.user_id=$1 ORDER BY t.created_at`, [id])).rows;
    const saved = (await q(`SELECT p.title, sp.created_at AS "savedAt" FROM saved_products sp JOIN products p ON p.id=sp.product_id WHERE sp.user_id=$1 ORDER BY sp.created_at`, [id])).rows;
    const follows = (await q(`SELECT s.name, f.created_at AS "followedAt" FROM shop_follows f JOIN shops s ON s.id=f.shop_id WHERE f.user_id=$1`, [id])).rows;
    const notifications = (await q('SELECT title, body, created_at AS "createdAt", read_at IS NOT NULL AS read FROM notifications WHERE user_id=$1 ORDER BY id', [id])).rows;
    const devices = Number((await q('SELECT count(*) n FROM push_subscriptions WHERE user_id=$1', [id])).rows[0].n); const sessions = (await q(`SELECT area, created_at AS "createdAt", last_seen_at AS "lastSeenAt", user_agent AS "userAgent" FROM sessions WHERE user_id=$1 ORDER BY created_at`, [id])).rows;
    await audit(pool, { actor: id, area: 'shop', action: 'account.export', entityType: 'user', entityId: id, ip: req.ip });
    return reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', 'attachment; filename="my-eazystores-data.json"').send({ exportedAt: new Date().toISOString(), profile: me, orders, reviews, conversations: threads, savedPieces: saved, followedShops: follows, notificationSettings: await allPrefs(pool, u.email), notifications, pushDevices: devices, signIns: sessions });
  });

  app.delete('/api/me', limit, async (req, reply) => {
    const u = requireUser(req); const b = z.object({ password: z.string().min(1).max(200) }).strict().parse(req.body);
    const row = (await q('SELECT password_hash, email FROM users WHERE id=$1', [u.id])).rows[0]; if (!row || !(await verifyPassword(b.password, row.password_hash))) throw new HttpError(403, 'wrong_password');
    await tx(async c => {
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [u.id]);
      if ((await c.query('SELECT 1 FROM user_roles WHERE user_id=$1', [u.id])).rowCount) throw new HttpError(409, 'has_roles');                       // staff and sellers are handed over or closed by an admin first
      if ((await c.query(`SELECT 1 FROM orders WHERE user_id=$1 AND status<>'cancelled' AND payment_status IN ('pending','paid','partially_refunded') AND EXISTS (SELECT 1 FROM seller_orders so WHERE so.order_id=orders.id AND so.status NOT IN ('delivered','cancelled'))`, [u.id])).rowCount) throw new HttpError(409, 'open_orders');
      const email = row.email as string; const gone = `deleted-${u.id}@deleted.invalid`;
      // sales records: keep amounts, tax, province and order numbers; remove who and where
      await c.query(`UPDATE orders SET user_id=NULL, email=$2, buyer_name='Deleted customer', ship_to=jsonb_build_object('region', ship_to->'region', 'country', ship_to->'country') WHERE user_id=$1`, [u.id, gone]);
      await c.query(`UPDATE order_lines SET personalisation='{}' WHERE order_id IN (SELECT id FROM orders WHERE email=$1)`, [gone]);
      await c.query(`UPDATE reviews SET user_id=NULL, author_name='Former customer' WHERE user_id=$1`, [u.id]);
      await c.query(`DELETE FROM threads WHERE user_id=$1 AND seller_order_id IS NULL`, [u.id]);                                                           // questions about pieces go entirely
      await c.query(`UPDATE threads SET user_id=NULL, guest_email=$2, buyer_name='Deleted customer' WHERE user_id=$1`, [u.id, gone]);                      // order chats stay for the maker's records, without the person
      await c.query('UPDATE messages SET author_id=NULL WHERE author_id=$1', [u.id]); await c.query('UPDATE ad_clicks SET user_id=NULL, ip=NULL WHERE user_id=$1', [u.id]);
      for (const t of ['saved_products', 'shop_follows', 'push_subscriptions', 'push_outbox', 'notifications', 'sessions', 'carts']) await c.query(`DELETE FROM ${t} WHERE user_id=$1`, [u.id]);
      await c.query('DELETE FROM notification_prefs WHERE email=$1', [email]); await c.query('DELETE FROM outbox_emails WHERE to_email=$1', [email]);
      await c.query(`UPDATE users SET email=$2, full_name='Deleted user', phone=NULL, password_hash=$3, status='disabled', email_verified_at=NULL, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1`, [u.id, gone, `deleted$${randomBytes(16).toString('hex')}`]);
      await audit(c, { actor: u.id, area: 'shop', action: 'account.delete', entityType: 'user', entityId: u.id, ip: req.ip });
    });
    for (const a of ['shop', 'studio', 'admin', 'support', 'finance', 'marketing'] as const) reply.clearCookie(cookieName(a), { path: '/' });
    return reply.send({ deleted: true });
  });
}
