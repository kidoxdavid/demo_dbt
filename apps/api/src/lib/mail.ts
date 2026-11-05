import nodemailer, { type Transporter } from 'nodemailer';
import type pg from 'pg';
import { withTx } from './db.js';
import { mailFrom, smtpUrl, publicUrl } from '../config.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Subjects and names go into headers: strip anything that could start a new header line. */
const oneLine = (s: unknown) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, 200);
const money = (cents: number, cur = 'CAD') => new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur }).format(cents / 100);

export interface Mail { subject: string; text: string; html: string }
type Data = Record<string, any>;

const shell = (title: string, bodyHtml: string, ctaUrl?: string, ctaLabel?: string) => `<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:Arial,Helvetica,sans-serif;color:#141414">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e3dd">
<tr><td style="padding:28px 32px 8px;font-size:20px;letter-spacing:-.02em">Eazy<i>Stores</i></td></tr>
<tr><td style="padding:8px 32px 0"><h1 style="font-size:22px;margin:0 0 12px;font-weight:600">${esc(title)}</h1>${bodyHtml}</td></tr>
${ctaUrl ? `<tr><td style="padding:12px 32px 8px"><a href="${esc(ctaUrl)}" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;padding:12px 22px;font-size:14px">${esc(ctaLabel ?? 'Open')}</a></td></tr>` : ''}
<tr><td style="padding:24px 32px 28px;font-size:12px;color:#77746e">This is a transactional message about your account or order. EazyStores development build.</td></tr>
</table></td></tr></table></body></html>`;

const lines = (items: { name: string; qty: number; unit: number }[], cur: string) => items.map(i => `${i.qty} × ${i.name}  ${money(i.unit * i.qty, cur)}`);
const itemsHtml = (items: { name: string; qty: number; unit: number }[], cur: string) =>
  `<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse">${items.map(i => `<tr><td style="padding:6px 0;border-top:1px solid #eee">${esc(i.qty)} × ${esc(i.name)}</td><td align="right" style="padding:6px 0;border-top:1px solid #eee">${esc(money(i.unit * i.qty, cur))}</td></tr>`).join('')}</table>`;
const totalsText = (d: Data) => [`Subtotal ${money(d.subtotal, d.currency)}`, ...(d.discount > 0 ? [`Discount -${money(d.discount, d.currency)}`] : []), `Delivery ${money(d.shipping, d.currency)}`, ...(d.taxLines ?? []).map((t: any) => `${t.name} ${money(t.cents, d.currency)}`), `Total ${money(d.total, d.currency)}`].join('\n');
const totalsHtml = (d: Data) => `<p style="font-size:14px;line-height:1.7;margin:12px 0">Subtotal ${esc(money(d.subtotal, d.currency))}<br>${d.discount > 0 ? `Discount -${esc(money(d.discount, d.currency))}<br>` : ''}Delivery ${esc(money(d.shipping, d.currency))}<br>${(d.taxLines ?? []).map((t: any) => `${esc(t.name)} ${esc(money(t.cents, d.currency))}<br>`).join('')}<b>Total ${esc(money(d.total, d.currency))}</b></p>`;

export const templates: Record<string, (d: Data) => Mail> = {
  verify_email: d => ({ subject: 'Confirm your email for EazyStores', text: `Confirm your email address to publish your store:\n${d.url}\n\nThis link works once and expires in 24 hours. If you did not create an account, ignore this email.`,
    html: shell('Confirm your email', `<p>Confirm your email address so you can publish your store.</p><p style="font-size:13px;color:#77746e">The link works once and expires in 24 hours. If you did not create an account, you can ignore this email.</p>`, d.url, 'Confirm email') }),
  reset_password: d => ({ subject: 'Reset your EazyStores password', text: `Use this link to choose a new password:\n${d.url}\n\nIt works once and expires in 60 minutes. If you did not ask for this, ignore this email: your password has not changed.`,
    html: shell('Reset your password', `<p>Someone asked to reset the password for this account. If that was you, choose a new one below.</p><p style="font-size:13px;color:#77746e">The link works once and expires in 60 minutes. If you did not ask for this, ignore this email: your password has not changed.</p>`, d.url, 'Choose a new password') }),
  password_changed: () => ({ subject: 'Your EazyStores password was changed', text: 'Your password was just changed and you were signed out everywhere. If this was not you, reset your password immediately and contact support.',
    html: shell('Your password was changed', `<p>Your password was just changed and you were signed out of every device.</p><p>If this was not you, reset your password immediately and contact support.</p>`) }),
  order_confirmation: d => ({ subject: `Order #${d.number} confirmed`, text: `Thank you, ${oneLine(d.customerName)}. Your order #${d.number} from ${oneLine(d.storeName)} is confirmed.\n\n${lines(d.items, d.currency).join('\n')}\n\n${totalsText(d)}\n\nTrack it: ${d.url}`,
    html: shell(`Order #${d.number} confirmed`, `<p>Thank you, ${esc(d.customerName)}. Your order from <b>${esc(d.storeName)}</b> is confirmed.</p>${itemsHtml(d.items, d.currency)}${totalsHtml(d)}`, d.url, 'View your order') }),
  order_new: d => ({ subject: `New order #${d.number}: ${money(d.total, d.currency)}`, text: `You have a new paid order #${d.number} from ${oneLine(d.customerName)}.\n\n${lines(d.items, d.currency).join('\n')}\n\nTotal ${money(d.total, d.currency)}\n\nManage it: ${d.url}`,
    html: shell(`New order #${d.number}`, `<p>${esc(d.customerName)} paid ${esc(money(d.total, d.currency))}.</p>${itemsHtml(d.items, d.currency)}`, d.url, 'Open order') }),
  order_status: d => ({ subject: `Order #${d.number} is ${d.statusLabel}`, text: `Your order #${d.number} from ${oneLine(d.storeName)} is now ${d.statusLabel}.\nTrack it: ${d.url}`,
    html: shell(`Your order is ${d.statusLabel}`, `<p>Order #${esc(d.number)} from <b>${esc(d.storeName)}</b> is now <b>${esc(d.statusLabel)}</b>.</p>`, d.url, 'View your order') }),
  refund_issued: d => ({ subject: `Refund of ${money(d.amount, d.currency)} for order #${d.number}`, text: `${oneLine(d.storeName)} refunded ${money(d.amount, d.currency)} for order #${d.number}. It may take a few business days to appear on your statement.\nDetails: ${d.url}`,
    html: shell('You have been refunded', `<p><b>${esc(d.storeName)}</b> refunded <b>${esc(money(d.amount, d.currency))}</b> for order #${esc(d.number)}.</p><p style="font-size:13px;color:#77746e">It may take a few business days to appear on your statement.</p>`, d.url, 'View your order') }),
  store_approved: d => ({ subject: 'Your store is live', text: `${oneLine(d.storeName)} was reviewed and approved. It is now visible to customers:\n${d.url}`,
    html: shell('Your store is live', `<p><b>${esc(d.storeName)}</b> was reviewed and approved. Customers can now find it.</p>`, d.url, 'View your store') }),
  store_rejected: d => ({ subject: 'Your store needs changes before it can go live', text: `${oneLine(d.storeName)} was not approved yet.\n\nReason from the reviewer:\n${d.reason}\n\nMake the changes and submit again:\n${d.url}`,
    html: shell('Your store needs changes', `<p><b>${esc(d.storeName)}</b> was not approved yet.</p><p style="background:#faf9f6;padding:12px;border-left:3px solid #141414">${esc(d.reason)}</p><p>Make the changes and submit it again.</p>`, d.url, 'Open settings') }),
  product_removed: d => ({ subject: `A product was removed: ${oneLine(d.name)}`, text: `${oneLine(d.name)} was removed from the marketplace by a moderator.\n\nReason:\n${d.reason}\n\nSee your products:\n${d.url}`,
    html: shell('A product was removed', `<p><b>${esc(d.name)}</b> was removed by a moderator.</p><p style="background:#faf9f6;padding:12px;border-left:3px solid #141414">${esc(d.reason)}</p>`, d.url, 'View products') }),
  verification_decided: d => ({ subject: d.decision === 'verified' ? 'You are now a verified seller' : 'Your verification request was not approved', text: d.decision === 'verified' ? `Your verification request was approved.\n${d.url}` : `Your verification request was not approved.\n\nReason:\n${d.reason}\n\nYou can update your details and request again:\n${d.url}`,
    html: shell(d.decision === 'verified' ? 'You are verified' : 'Verification not approved', d.decision === 'verified' ? '<p>Your verification request was approved. A verified badge now shows on your store.</p>' : `<p>Your request was not approved.</p><p style="background:#faf9f6;padding:12px;border-left:3px solid #141414">${esc(d.reason)}</p>`, d.url, 'Open settings') }),
  account_closed: () => ({ subject: 'Your EazyStores account was closed', text: 'Your store was closed and your personal details and product photos were removed. Orders, refunds and tax records are kept for the period the law requires. If you did not ask for this, contact support immediately.',
    html: shell('Your account was closed', '<p>Your store was closed and your personal details and product photos were removed.</p><p>Orders, refunds and tax records are kept for the period the law requires.</p><p>If you did not ask for this, contact support immediately.</p>') }),
  billing_receipt: d => ({ subject: `Receipt: ${oneLine(d.plan)} plan, ${money(d.amount, d.currency)}`, text: `We charged ${money(d.amount, d.currency)} for the ${oneLine(d.plan)} plan. It is paid through ${d.periodEnd}.\nBilling: ${d.url}`,
    html: shell('Payment received', `<p>We charged <b>${esc(money(d.amount, d.currency))}</b> for the <b>${esc(d.plan)}</b> plan, paid through ${esc(d.periodEnd)}.</p>`, d.url, 'View billing') }),
  billing_payment_failed: d => ({ subject: `We could not charge your ${oneLine(d.plan)} plan`, text: `The ${oneLine(d.plan)} plan payment of ${money(d.amount, d.currency)} did not go through. We will retry daily; if it is still unpaid after ${d.graceDays} days your store moves to the free Starter plan.\nBilling: ${d.url}`,
    html: shell('Payment did not go through', `<p>The <b>${esc(d.plan)}</b> plan payment of <b>${esc(money(d.amount, d.currency))}</b> did not go through.</p><p>We will retry daily. If it is still unpaid after ${esc(d.graceDays)} days, your store moves to the free Starter plan. Nothing is deleted.</p>`, d.url, 'Open billing') }),
  billing_downgraded: d => ({ subject: 'Your store moved to the Starter plan', text: `Your ${oneLine(d.plan)} plan could not be paid, so your store moved to the free Starter plan. Nothing was deleted; paid features are switched off and Starter limits apply to new products. You can upgrade again any time:\n${d.url}`,
    html: shell('Moved to the Starter plan', `<p>Your <b>${esc(d.plan)}</b> plan could not be paid, so your store moved to the free Starter plan.</p><p>Nothing was deleted. Paid features are switched off and Starter limits apply to new products.</p>`, d.url, 'Upgrade again') }),
  back_in_stock: d => ({ subject: `Back in stock: ${oneLine(d.name)}`, text: `${oneLine(d.name)} from ${oneLine(d.storeName)} is available again. You asked to be told. Stock can go quickly:\n${d.url}`,
    html: shell('Back in stock', `<p><b>${esc(d.name)}</b> from ${esc(d.storeName)} is available again. You asked us to tell you.</p><p style="font-size:13px;color:#77746e">Stock can go quickly.</p>`, d.url, 'Shop it now') }),
  drop_live: d => ({ subject: `It's live: ${oneLine(d.name)}`, text: `${oneLine(d.name)} from ${oneLine(d.storeName)} just dropped. You asked to be first to know:\n${d.url}`,
    html: shell('The drop is live', `<p><b>${esc(d.name)}</b> from ${esc(d.storeName)} just dropped. You asked to be first to know.</p>`, d.url, 'Shop the drop') }),
  new_drop: d => ({ subject: `New from ${oneLine(d.storeName)}: ${oneLine(d.name)}`, text: `${oneLine(d.storeName)}, a maker you follow, just released ${oneLine(d.name)}:\n${d.url}\n\nYou can unfollow any time from your account.`,
    html: shell('New from a maker you follow', `<p><b>${esc(d.storeName)}</b> just released <b>${esc(d.name)}</b>.</p><p style="font-size:13px;color:#77746e">You can unfollow any time from your account.</p>`, d.url, 'Take a look') }),
  low_stock: d => ({ subject: `Low stock: ${oneLine(d.name)}`, text: `${oneLine(d.name)} (${oneLine(d.variant)}) is down to ${d.available} available.\nRestock: ${d.url}`,
    html: shell('Low stock', `<p><b>${esc(d.name)}</b> (${esc(d.variant)}) is down to <b>${esc(d.available)}</b> available.</p>`, d.url, 'Manage products') }),
};

export const url = (path: string) => `${publicUrl}${path}`;

/** Record an email in the same transaction as the event that caused it, so it is never lost and never sent for a rolled-back event. */
export async function enqueue(c: pg.PoolClient, e: { tenantId?: string | null; to: string; template: keyof typeof templates; data: Data }) {
  const m = templates[e.template](e.data);
  await c.query(`INSERT INTO email_outbox(tenant_id,to_email,template,subject,text_body,html_body) VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.tenantId ?? null, e.to, e.template, oneLine(m.subject), m.text, m.html]);
}

export const ownerEmail = async (c: pg.PoolClient, tenantId: string) =>
  (await c.query(`SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.role='owner' LIMIT 1`, [tenantId])).rows[0]?.email as string | undefined;

let transport: Transporter | null = null;
export const mailMode = () => (smtpUrl() ? 'smtp' : 'simulated');
function getTransport() { const u = smtpUrl(); if (!u) return null; if (!transport) transport = nodemailer.createTransport(u); return transport; }
export const resetTransportForTests = () => { transport = null; };

const MAX_ATTEMPTS = 5;
/** Send due emails. Safe to run on several workers (SKIP LOCKED). Failures back off and eventually stop; nothing is retried forever. */
export async function processOutbox(limit = 20): Promise<{ sent: number; simulated: number; failed: number; retrying: number }> {
  const out = { sent: 0, simulated: 0, failed: 0, retrying: 0 };
  await withTx({ platform: true }, async c => {
    const due = (await c.query(`SELECT * FROM email_outbox WHERE status='pending' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    const t = getTransport();
    for (const m of due) {
      if (!t) { await c.query(`UPDATE email_outbox SET status='simulated', sent_at=now(), attempts=attempts+1 WHERE id=$1`, [m.id]); out.simulated++; continue; }
      try {
        await t.sendMail({ from: mailFrom, to: m.to_email, subject: m.subject, text: m.text_body, html: m.html_body });
        await c.query(`UPDATE email_outbox SET status='sent', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1`, [m.id]); out.sent++;
      } catch (e: any) {
        const attempts = m.attempts + 1; const final = attempts >= MAX_ATTEMPTS;
        await c.query(`UPDATE email_outbox SET attempts=$2, last_error=$3, status=$4, next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id=$1`,
          [m.id, attempts, String(e?.message ?? e).slice(0, 300), final ? 'failed' : 'pending', String(60 * 2 ** attempts)]);
        if (final) out.failed++; else out.retrying++;
      }
    }
  });
  return out;
}
