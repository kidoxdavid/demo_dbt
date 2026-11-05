import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, q } from '../db.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../guards.js';
import { CATEGORIES, allPrefs, readUnsubscribeToken } from '../lib/notify.js';
import { pushConfigured, pushKeys } from '../lib/push.js';
import { config } from '../config.js';

const b64u = /^[A-Za-z0-9_-]+$/;
const sub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().regex(b64u).max(200), auth: z.string().regex(b64u).max(100) }).strict() }).strict();
/** A browser push address must be https (plain http only to localhost while developing) and the keys must be the shapes a browser makes: a 65-byte P-256 point and a 16-byte secret. */
function checkSubscription(s: z.infer<typeof sub>) {
  const u = new URL(s.endpoint); const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !config.production)) throw new HttpError(422, 'invalid_endpoint');
  const p = Buffer.from(s.keys.p256dh, 'base64url'), a = Buffer.from(s.keys.auth, 'base64url'); if (p.length !== 65 || p[0] !== 4 || a.length !== 16) throw new HttpError(422, 'invalid_keys');
}
const view = (r: any) => ({ id: Number(r.id), kind: r.kind, category: r.category, title: r.title, body: r.body, url: r.url, read: !!r.read_at, createdAt: r.created_at });

/** The same inbox, settings and device list for buyers (/api/me) and makers (/api/studio): one person, one email address, one set of choices. */
export function registerNotifications(app: FastifyInstance) {
  const limit = { config: (app as any).authLimit };
  app.get('/api/push/key', async () => ({ publicKey: pushConfigured() ? pushKeys().publicKey : null }));

  // ---- a signed link in every optional email; works without signing in, and as a one-click POST for mail apps
  const unsub = async (token: string) => {
    const t = readUnsubscribeToken(token); if (!t) throw new HttpError(400, 'invalid_link');
    await q(`INSERT INTO notification_prefs(email,category,email_enabled) VALUES ($1,$2,false) ON CONFLICT (email,category) DO UPDATE SET email_enabled=false, updated_at=now()`, [t.email, t.category]);
    await audit(pool, { area: 'shop', action: 'notifications.unsubscribe', entityType: 'email', entityId: t.email.replace(/^(.).*(@.*)$/, '$1***$2'), next: { category: t.category } }); return { unsubscribed: true, category: t.category };
  };
  app.post('/api/unsubscribe', limit, async req => unsub(z.object({ token: z.string().min(10).max(500) }).strict().parse(req.body).token));
  app.post('/api/unsubscribe/:token', limit, async req => unsub(z.object({ token: z.string().min(10).max(500) }).parse(req.params).token));
  app.get('/api/unsubscribe/:token', async req => { const t = readUnsubscribeToken(z.object({ token: z.string().max(500) }).parse(req.params).token); if (!t) throw new HttpError(400, 'invalid_link'); return { category: t.category, label: CATEGORIES.find(c => c.key === t.category)!.label }; });

  for (const P of ['/api/me', '/api/studio']) {
    app.get(`${P}/notifications`, async req => {
      const u = requireUser(req); const f = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
      const rows = (await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3', [u.id, f.limit, f.offset])).rows; const unread = Number((await q('SELECT count(*) n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [u.id])).rows[0].n);
      return { unread, items: rows.map(view) };
    });
    app.get(`${P}/notifications/unread-count`, async req => { const u = requireUser(req); return { unread: Number((await q('SELECT count(*) n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [u.id])).rows[0].n) }; });
    app.post(`${P}/notifications/read-all`, async req => { const u = requireUser(req); await q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [u.id]); return { unread: 0 }; });
    app.post(`${P}/notifications/:id/read`, async req => { const u = requireUser(req); const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params); const r = await q('UPDATE notifications SET read_at=coalesce(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id', [id, u.id]); if (!r.rowCount) throw new HttpError(404, 'not_found'); return { id }; });

    app.get(`${P}/notification-prefs`, async req => {
      const u = requireUser(req); const devices = Number((await q('SELECT count(*) n FROM push_subscriptions WHERE user_id=$1', [u.id])).rows[0].n);
      return { email: u.email, categories: await allPrefs(pool, u.email), push: { configured: pushConfigured(), devices } };
    });
    app.put(`${P}/notification-prefs`, async req => {
      const u = requireUser(req); const b = z.object({ category: z.enum(['orders', 'messages', 'reviews']), email: z.boolean().optional(), push: z.boolean().optional() }).strict().parse(req.body);
      if (b.email === false && CATEGORIES.find(c => c.key === b.category)!.transactional) throw new HttpError(422, 'transactional_email_always_sent');
      const cur = (await allPrefs(pool, u.email)).find(c => c.key === b.category)!;
      await q(`INSERT INTO notification_prefs(email,category,email_enabled,push_enabled) VALUES ($1,$2,$3,$4) ON CONFLICT (email,category) DO UPDATE SET email_enabled=EXCLUDED.email_enabled, push_enabled=EXCLUDED.push_enabled, updated_at=now()`, [u.email, b.category, b.email ?? cur.email, b.push ?? cur.push]);
      return { categories: await allPrefs(pool, u.email) };
    });

    app.post(`${P}/push`, limit, async (req, reply) => {
      const u = requireUser(req); if (!pushConfigured()) throw new HttpError(503, 'push_not_configured'); const s = sub.parse(req.body); checkSubscription(s);
      await q(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent`, [u.id, s.endpoint, s.keys.p256dh, s.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200)]);
      await q(`DELETE FROM push_subscriptions WHERE user_id=$1 AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10)`, [u.id]);          // at most ten devices each
      return reply.code(201).send({ devices: Number((await q('SELECT count(*) n FROM push_subscriptions WHERE user_id=$1', [u.id])).rows[0].n) });
    });
    app.delete(`${P}/push`, async req => { const u = requireUser(req); const b = z.object({ endpoint: z.string().url().max(1000) }).strict().parse(req.body); await q('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [u.id, b.endpoint]); return { devices: Number((await q('SELECT count(*) n FROM push_subscriptions WHERE user_id=$1', [u.id])).rows[0].n) }; });
    /** "Send me a test": goes through the real inbox and push queue, so it proves the whole path for this device. */
    app.post(`${P}/push/test`, limit, async req => {
      const u = requireUser(req); const devices = Number((await q('SELECT count(*) n FROM push_subscriptions WHERE user_id=$1', [u.id])).rows[0].n); if (!pushConfigured()) throw new HttpError(503, 'push_not_configured'); if (!devices) throw new HttpError(409, 'no_device');
      await q(`INSERT INTO notifications(user_id,category,kind,title,body,url) VALUES ($1,'messages','test','Notifications are working','This is a test from eazystores.','${P === '/api/studio' ? '/studio/notifications' : '/account/notifications'}')`, [u.id]);
      await q('INSERT INTO push_outbox(user_id,payload) VALUES ($1,$2)', [u.id, JSON.stringify({ title: 'Notifications are working', body: 'This is a test from eazystores.', url: P === '/api/studio' ? '/studio/notifications' : '/account/notifications', tag: 'test' })]); return { queued: true, devices };
    });
  }
}
