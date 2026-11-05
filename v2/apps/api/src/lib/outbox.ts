import type { Client } from '../db.js';
import { pool } from '../db.js';
import { dollars } from './money.js';
import { TEMPLATE_CATEGORY, prefFor, unsubscribeToken } from './notify.js';
import nodemailer, { type Transporter } from 'nodemailer';

type Data = Record<string, any>;
const esc = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ');
/** Plain templates (staff can edit them in a later phase). Subjects are one line: header injection is impossible. */
export const TEMPLATES: Record<string, (d: Data) => { subject: string; body: string }> = {
  order_confirmation: d => ({ subject: `Order #${d.number} confirmed`, body: `Thank you, ${esc(d.name)}.\n\n${(d.sellers as any[]).map(s => `${s.shop}: ${s.lines.map((l: any) => `${l.quantity} x ${l.title}`).join(', ')}  (arrives ${s.eta})`).join('\n')}\n\nTotal ${dollars(d.totalCents)} CAD (GST ${dollars(d.taxCents)} included in the total).\nTrack it: ${d.url}` }),
  seller_new_order: d => ({ subject: `New order #${d.number}: ${dollars(d.totalCents)}`, body: `You have a new order from ${esc(d.buyer)}.\n\n${(d.lines as any[]).map(l => `${l.quantity} x ${l.title}${l.variant ? ` (${l.variant})` : ''}`).join('\n')}\n\nShip by ${d.shipBy}.${d.gift ? `\nThis is a gift. Message: ${esc(d.gift)}` : ''}\nOpen it: ${d.url}` }),
  order_shipped: d => ({ subject: `Your order #${d.number} from ${esc(d.shop)} has shipped`, body: `${esc(d.shop)} shipped your order with ${esc(d.carrier)}.\nTracking number: ${esc(d.trackingNumber)}\n${d.trackingUrl ? `Track it: ${d.trackingUrl}\n` : ''}Order: ${d.url}` }),
  refund_issued: d => ({ subject: `Refund of ${dollars(d.amountCents)} for order #${d.number}`, body: `${esc(d.shop)} refunded ${dollars(d.amountCents)} CAD for order #${d.number}. It can take a few business days to appear on your statement.\nReason: ${esc(d.reason)}` }),
  review_request: d => ({ subject: `How was your order from ${esc(d.shop)}?`, body: `Your order #${d.number} from ${esc(d.shop)} has been delivered.\n\nA short review helps the maker and other shoppers: ${esc(d.url)}` }),
  new_message: d => ({ subject: `New message from ${esc(d.from)}`, body: `${esc(d.from)} wrote${d.about ? ` about ${esc(d.about)}` : ''}:\n\n${String(d.preview ?? '').slice(0, 300)}\n\nReply here: ${esc(d.url)}` }),
  new_review: d => ({ subject: `New ${d.rating}-star review on ${esc(d.product)}`, body: `${esc(d.author)} left a review of ${esc(d.product)}:\n\n${String(d.preview ?? '').slice(0, 300)}\n\nRead it and reply: ${esc(d.url)}` }),
  review_reply: d => ({ subject: `${esc(d.shop)} replied to your review`, body: `${esc(d.shop)} replied to your review of ${esc(d.product)}:\n\n${String(d.preview ?? '').slice(0, 300)}\n\nSee it: ${esc(d.url)}` }),
  order_cancelled: d => ({ subject: `Order #${d.number} was cancelled`, body: `Your order #${d.number} was cancelled and any payment has been refunded.` }),
};
/** Queue an email. Anything that is not a receipt or order update is skipped if the person turned that kind off (by account or by an unsubscribe link). Returns whether it was queued. */
export async function enqueue(c: Client | typeof pool, to: string, template: keyof typeof TEMPLATES, data: Data) {
  const k = TEMPLATE_CATEGORY[template]; if (k && !k.transactional && !(await prefFor(c, to, k.category)).email) return false;
  await c.query('INSERT INTO outbox_emails(to_email,template,data) VALUES ($1,$2,$3)', [to, template, JSON.stringify(data)]); return true;
}
const BASE = () => process.env.PUBLIC_URL ?? 'http://localhost:5180';
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain text to a small, safe HTML email: every character escaped first, then links and paragraphs added. */
export function toHtml(body: string, footer?: string) {
  const paras = body.split(/\n{2,}/).map(p => `<p style="margin:0 0 14px;line-height:1.5">${escHtml(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#faf7f2;font-family:Arial,Helvetica,sans-serif;color:#1f1b16"><div style="max-width:560px;margin:0 auto;padding:28px 20px"><div style="font-family:Georgia,serif;font-size:22px;font-weight:600;margin-bottom:18px">eazy<span style="color:#a9532d">stores</span></div><div style="background:#fff;border:1px solid #e9e2d6;border-radius:14px;padding:22px">${paras}</div>${footer ? `<p style="font-size:12px;color:#6f675c;margin:14px 4px">${footer}</p>` : ''}</div></body></html>`;
}
export type Sender = (m: { to: string; subject: string; body: string; html?: string; headers?: Record<string, string> }) => Promise<void>;
/** Used when no mail server is configured (development, tests): nothing leaves the machine. */
export const simulatedSender: Sender = async () => {};
/** The real thing: set SMTP_URL (for example smtps://user:pass@smtp.example.com:465) and EMAIL_FROM. One connection pool is reused. */
let transport: Transporter | null = null;
export function makeSender(): Sender {
  const url = process.env.SMTP_URL; if (!url) return simulatedSender; transport ??= nodemailer.createTransport(`${url}${url.includes('?') ? '&' : '?'}pool=true&maxConnections=3`); const from = process.env.EMAIL_FROM ?? 'eazystores <no-reply@localhost>';
  return async m => { await transport!.sendMail({ from, to: m.to, subject: m.subject, text: m.body, html: m.html, headers: m.headers }); };
}
export const closeMailer = () => { transport?.close(); transport = null; };
/** Send what is due, up to 5 attempts with growing delays. Safe to run from several processes (rows are claimed with SKIP LOCKED). */
export async function processOutbox(send: Sender = makeSender(), limit = 50) {
  let sent = 0, failed = 0; const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const rows = (await c.query(`SELECT * FROM outbox_emails WHERE status='pending' AND send_after <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    for (const r of rows) {
      const t = TEMPLATES[r.template]; if (!t) { await c.query(`UPDATE outbox_emails SET status='failed', error='unknown_template' WHERE id=$1`, [r.id]); failed++; continue; }
      const m = t(r.data); const k = TEMPLATE_CATEGORY[r.template]; let body = m.body; let footer: string | undefined; let headers: Record<string, string> | undefined;
      if (k && !k.transactional) {                                                              // optional mail always carries a working way out
        const link = `${BASE()}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(r.to_email, k.category))}`; footer = `You get this because of your notification settings. <a href="${escHtml(link)}">Unsubscribe from these emails</a>.`; body = `${m.body}\n\n--\nUnsubscribe from these emails: ${link}`;
        headers = { 'List-Unsubscribe': `<${BASE()}/api/unsubscribe/${encodeURIComponent(unsubscribeToken(r.to_email, k.category))}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
      }
      try { await send({ to: r.to_email, subject: m.subject, body, html: toHtml(body.replace(/\n\n--\nUnsubscribe from these emails: .*$/, ''), footer), headers }); await c.query(`UPDATE outbox_emails SET status='sent', sent_at=now(), attempts=attempts+1, subject=$2, body=$3, error=NULL WHERE id=$1`, [r.id, m.subject, body]); sent++; }
      catch (e: any) { const dead = r.attempts + 1 >= 5; await c.query(`UPDATE outbox_emails SET status=$2, attempts=attempts+1, error=$3, send_after=now() + ($4 || ' minutes')::interval WHERE id=$1`, [r.id, dead ? 'failed' : 'pending', String(e?.message ?? e).slice(0, 200), String(2 ** (r.attempts + 1))]); failed++; }
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  return { sent, failed };
}
