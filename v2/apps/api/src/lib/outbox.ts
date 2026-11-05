import type { Client } from '../db.js';
import { pool } from '../db.js';
import { dollars } from './money.js';

type Data = Record<string, any>;
const esc = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ');
/** Plain templates (staff can edit them in a later phase). Subjects are one line: header injection is impossible. */
export const TEMPLATES: Record<string, (d: Data) => { subject: string; body: string }> = {
  order_confirmation: d => ({ subject: `Order #${d.number} confirmed`, body: `Thank you, ${esc(d.name)}.\n\n${(d.sellers as any[]).map(s => `${s.shop}: ${s.lines.map((l: any) => `${l.quantity} x ${l.title}`).join(', ')}  (arrives ${s.eta})`).join('\n')}\n\nTotal ${dollars(d.totalCents)} CAD (GST ${dollars(d.taxCents)} included in the total).\nTrack it: ${d.url}` }),
  seller_new_order: d => ({ subject: `New order #${d.number}: ${dollars(d.totalCents)}`, body: `You have a new order from ${esc(d.buyer)}.\n\n${(d.lines as any[]).map(l => `${l.quantity} x ${l.title}${l.variant ? ` (${l.variant})` : ''}`).join('\n')}\n\nShip by ${d.shipBy}.${d.gift ? `\nThis is a gift. Message: ${esc(d.gift)}` : ''}\nOpen it: ${d.url}` }),
  order_shipped: d => ({ subject: `Your order #${d.number} from ${esc(d.shop)} has shipped`, body: `${esc(d.shop)} shipped your order with ${esc(d.carrier)}.\nTracking number: ${esc(d.trackingNumber)}\n${d.trackingUrl ? `Track it: ${d.trackingUrl}\n` : ''}Order: ${d.url}` }),
  refund_issued: d => ({ subject: `Refund of ${dollars(d.amountCents)} for order #${d.number}`, body: `${esc(d.shop)} refunded ${dollars(d.amountCents)} CAD for order #${d.number}. It can take a few business days to appear on your statement.\nReason: ${esc(d.reason)}` }),
  order_cancelled: d => ({ subject: `Order #${d.number} was cancelled`, body: `Your order #${d.number} was cancelled and any payment has been refunded.` }),
};
export async function enqueue(c: Client | typeof pool, to: string, template: keyof typeof TEMPLATES, data: Data) {
  await c.query('INSERT INTO outbox_emails(to_email,template,data) VALUES ($1,$2,$3)', [to, template, JSON.stringify(data)]);
}
export type Sender = (m: { to: string; subject: string; body: string }) => Promise<void>;
/** The built-in sender records the rendered message and sends nothing (simulated). A real SMTP or API sender plugs into the same signature in the notifications phase. */
export const simulatedSender: Sender = async () => {};
/** Send what is due, up to 5 attempts with growing delays. Safe to run from several processes (rows are claimed with SKIP LOCKED). */
export async function processOutbox(send: Sender = simulatedSender, limit = 50) {
  let sent = 0, failed = 0; const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const rows = (await c.query(`SELECT * FROM outbox_emails WHERE status='pending' AND send_after <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    for (const r of rows) {
      const t = TEMPLATES[r.template]; if (!t) { await c.query(`UPDATE outbox_emails SET status='failed', error='unknown_template' WHERE id=$1`, [r.id]); failed++; continue; }
      const m = t(r.data);
      try { await send({ to: r.to_email, subject: m.subject, body: m.body }); await c.query(`UPDATE outbox_emails SET status='sent', sent_at=now(), attempts=attempts+1, subject=$2, body=$3, error=NULL WHERE id=$1`, [r.id, m.subject, m.body]); sent++; }
      catch (e: any) { const dead = r.attempts + 1 >= 5; await c.query(`UPDATE outbox_emails SET status=$2, attempts=attempts+1, error=$3, send_after=now() + ($4 || ' minutes')::interval WHERE id=$1`, [r.id, dead ? 'failed' : 'pending', String(e?.message ?? e).slice(0, 200), String(2 ** (r.attempts + 1))]); failed++; }
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  return { sent, failed };
}
