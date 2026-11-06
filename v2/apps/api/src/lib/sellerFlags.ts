import { q } from '../db.js';
import { HttpError } from '../errors.js';

/** Switches the admin can flip for ONE maker. A maker with no row has everything on. */
export const SELLER_FLAG_META = {
  ads: { label: 'Run paid ads', help: 'Off: this maker\'s ad campaigns stop showing and they cannot start new ones.' },
  store_promotions: { label: 'Store promotion', help: 'Off: this maker\'s store-page promotion is hidden and they cannot change it.' },
  publishing: { label: 'Publish new listings', help: 'Off: this maker can keep editing drafts but cannot put new listings live. Live listings stay.' },
} as const;
export type SellerFlagKey = keyof typeof SELLER_FLAG_META;
export const SELLER_FLAGS = Object.keys(SELLER_FLAG_META) as SellerFlagKey[];

export async function sellerFlags(sellerId: string): Promise<Record<SellerFlagKey, boolean>> {
  const rows = (await q('SELECT key, enabled FROM seller_flags WHERE seller_id=$1', [sellerId])).rows as { key: SellerFlagKey; enabled: boolean }[]; const m = new Map(rows.map(r => [r.key, r.enabled]));
  return Object.fromEntries(SELLER_FLAGS.map(k => [k, m.get(k) ?? true])) as Record<SellerFlagKey, boolean>;
}
/** Stop a maker's request when staff switched this feature off for them. */
export async function requireSellerFlag(sellerId: string, key: SellerFlagKey): Promise<void> { if (!(await sellerFlags(sellerId))[key]) throw new HttpError(403, 'paused_by_staff'); }
/** SQL that is true for a seller (column or expression `col`) who has NOT been switched off for `key`. */
export const sellerOnSql = (col: string, key: SellerFlagKey) => `NOT EXISTS (SELECT 1 FROM seller_flags sf WHERE sf.seller_id=${col} AND sf.key='${key}' AND NOT sf.enabled)`;
