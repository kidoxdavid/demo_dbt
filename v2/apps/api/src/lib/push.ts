import webpush from 'web-push';
import { pool } from '../db.js';

export const pushKeys = () => ({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null, privateKey: process.env.VAPID_PRIVATE_KEY ?? null, subject: process.env.VAPID_SUBJECT ?? 'mailto:support@eazystores.ca' });
export const pushConfigured = () => { const k = pushKeys(); return !!(k.publicKey && k.privateKey); };
export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
export type PushTransport = (sub: PushSub, payload: string) => Promise<void>;
/** The real sender: the payload is encrypted for the browser (RFC 8291) and signed with the server's VAPID key (RFC 8292). */
export const webPushTransport: PushTransport = async (sub, payload) => { const k = pushKeys(); await webpush.sendNotification(sub, payload, { vapidDetails: { subject: k.subject, publicKey: k.publicKey!, privateKey: k.privateKey! }, TTL: 60 * 60 * 24, urgency: 'normal' }); };

/** Send what is due. A device the browser has forgotten (404 or 410) is removed; other failures retry with growing delays and give up after 5 tries. */
export async function processPush(send: PushTransport = webPushTransport, limit = 50) {
  let sent = 0, failed = 0, removed = 0; const c = await pool.connect();
  try {
    await c.query('BEGIN'); const rows = (await c.query(`SELECT * FROM push_outbox WHERE status='pending' AND send_after <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    for (const r of rows) {
      const subs = (await c.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1', [r.user_id])).rows; if (!subs.length) { await c.query(`UPDATE push_outbox SET status='no_device' WHERE id=$1`, [r.id]); continue; }
      let ok = 0; let lastErr = '';
      for (const s of subs) {
        try { await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(r.payload)); ok++; await c.query('UPDATE push_subscriptions SET last_ok_at=now() WHERE id=$1', [s.id]); }
        catch (e: any) { if ([404, 410].includes(e?.statusCode)) { await c.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]); removed++; } else lastErr = String(e?.message ?? e).slice(0, 200); }
      }
      if (ok || !lastErr) { await c.query(`UPDATE push_outbox SET status=$2, attempts=attempts+1 WHERE id=$1`, [r.id, ok ? 'sent' : 'no_device']); if (ok) sent++; }
      else { const dead = r.attempts + 1 >= 5; await c.query(`UPDATE push_outbox SET status=$2, attempts=attempts+1, error=$3, send_after=now() + ($4 || ' minutes')::interval WHERE id=$1`, [r.id, dead ? 'failed' : 'pending', lastErr, String(2 ** r.attempts)]); if (dead) failed++; }
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  return { sent, failed, removed };
}
