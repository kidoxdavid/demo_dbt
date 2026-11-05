import { randomUUID } from 'node:crypto';
import type { Client } from '../db.js';
export type Account = 'cash' | 'seller_payable' | 'commission_revenue' | 'tax_payable';
export interface Entry { account: Account; amountCents: number }
/** Post one balanced transaction. Debits positive, credits negative; the database rejects it at commit if it does not sum to zero. */
export async function postTxn(c: Client, o: { orderId: string; sellerOrderId: string; sellerId: string; memo: string; entries: Entry[] }) {
  const txn = randomUUID(); if (o.entries.reduce((n, e) => n + e.amountCents, 0) !== 0) throw new Error('ledger_unbalanced');
  for (const e of o.entries) if (e.amountCents !== 0) await c.query('INSERT INTO ledger_entries(txn_id,order_id,seller_order_id,seller_id,account,amount_cents,memo) VALUES ($1,$2,$3,$4,$5,$6,$7)', [txn, o.orderId, o.sellerOrderId, o.sellerId, e.account, e.amountCents, o.memo]);
  return txn;
}
/** Payment received for a seller order: cash in; the seller is owed items + shipping - commission; the platform earns commission; GST is held for the tax authority. */
export const saleEntries = (so: { total_cents: number; commission_cents: number; tax_cents: number; items_cents: number; shipping_cents: number }): Entry[] => [
  { account: 'cash', amountCents: so.total_cents }, { account: 'seller_payable', amountCents: -(so.items_cents + so.shipping_cents - so.commission_cents) },
  { account: 'commission_revenue', amountCents: -so.commission_cents }, { account: 'tax_payable', amountCents: -so.tax_cents }];
