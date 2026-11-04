export class ApiError extends Error {
  constructor(public status: number, public code: string, public issues?: { path: (string | number)[]; message: string }[]) { super(code); }
}
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'request_failed', data.issues);
  return data as T;
}
const MESSAGES: Record<string, string> = {
  email_in_use: 'That email already has an account.', slug_unavailable: 'That store address is taken. Try another.',
  invalid_credentials: 'Email or password is incorrect.', account_temporarily_locked: 'Too many attempts. Try again in 15 minutes.',
  out_of_stock: 'Sorry, one of these items just sold out or is reserved by another buyer. Please reduce the quantity.',
  duplicate_sku: 'That SKU is already used by another product.', plan_limit_active_products: 'You have reached your plan limit for active products.',
  fulfilment_not_offered: 'This store does not offer that delivery option.', address_required: 'Please enter a delivery address.',
  payments_not_configured: 'Payments are not configured yet.', store_suspended: 'This store is suspended.',
  item_unavailable: 'An item in your cart is no longer available.', cross_origin_blocked: 'Request blocked.',
  custom_unknown_field: 'This product changed. Please remove it from your cart and add it again.', restock_requires_full_refund: 'Restocking is only available when refunding the whole order.', idempotency_key_reused: 'That refund request was already used for another order.',
  invalid_path: 'That page cannot be shared.', not_your_store: 'You can only share your own store.', store_not_publishable: 'That store is not live.',
  terms_not_accepted: 'Please accept the seller agreement first.', removed_by_moderator: 'This product was removed by a moderator. Contact support if you think that was a mistake.',
  verification_pending: 'Your verification request is already being reviewed.', verification_verified: 'You are already verified.', not_pending_review: 'That store is no longer waiting for review.',
  unresolved_refunds: 'A customer is still owed a refund. Resolve it on your Overview page first.', no_orders_found: 'No orders were found for that email address.',
  invalid_code: 'That code is not right. Check your authenticator app and try again.', too_many_attempts: 'Too many wrong codes. Please sign in again.', invalid_challenge: 'That sign-in expired. Please sign in again.',
  invalid_or_expired_link: 'That link has expired or was already used. Request a new one.', email_not_verified: 'Please confirm your email address first. We sent you a link.',
  mfa_setup_required: 'Staff accounts need two-factor sign-in. Set it up to continue.', mfa_required: 'Please sign in again and enter your two-factor code.', mfa_required_for_staff: 'Two-factor sign-in cannot be turned off for staff accounts.',
  mfa_already_enabled: 'Two-factor is already on.', tax_region_unknown: 'We cannot work out tax for that province. Please choose a province from the list.',
  tax_needs_province: 'Choose your province in your business details before turning on sales tax.',
  image_too_large: 'That image is over 5 MB. Please use a smaller photo.', unsupported_image_type: 'Use a JPG, PNG or WebP image.', too_many_images: 'A product can have up to 8 photos.',
  stock_below_reserved_or_negative: 'Stock cannot go below zero or below units reserved by open checkouts.',
};
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.code.split(':')[0];
    const detail = e.code.split(':').slice(1).join(':');
    if (code === 'custom_required') return `Please fill in “${detail}”.`;
    if (code === 'custom_too_long') return `“${detail}” is too long.`;
    if (code === 'custom_invalid_choice') return `Please choose a valid option for “${detail}”.`;
    if (code === 'custom_invalid_upload') return `The photo for “${detail || 'this item'}” could not be used. Please upload it again.`;
    if (code === 'exceeds_refundable') return `That is more than can be refunded. The most you can refund is $${(Number(detail) / 100).toFixed(2)}.`;
    if (code === 'open_orders') return `You still have ${detail} open order(s). Finish or refund them first.`;
    if (code === 'no_provincial_tax') return `${detail} has no provincial sales tax to register for.`;
    if (code === 'not_refundable') return 'This order cannot be refunded in its current state.';
    if (e.code.startsWith('incomplete_profile:')) return `Before publishing, please fill in: ${e.code.split(':')[1].replace(/_/g, ' ')}.`;
    if (e.code === 'validation_failed') return 'Please check the highlighted fields: ' + (e.issues ?? []).map(i => `${i.path.join('.')} ${i.message}`).join('; ');
    return MESSAGES[e.code] ?? `Something went wrong (${e.code}).`;
  }
  return 'Network error. Please try again.';
}
/** Like api(), but also returns the X-Total-Count header (for paged lists). */
export async function apiWithTotal<T = any>(path: string): Promise<{ data: T; total: number }> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? 'request_failed', (data as any).issues);
  return { data: data as T, total: Number(res.headers.get('x-total-count') ?? (Array.isArray(data) ? data.length : 0)) };
}
export const PROVINCES: [string, string][] = [['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'], ['NL', 'Newfoundland and Labrador'],
  ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'], ['SK', 'Saskatchewan'], ['YT', 'Yukon']];
export const money = (cents: number, cur = 'CAD') => new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur }).format(cents / 100);
export const toCents = (v: string) => Math.round(parseFloat(v || '0') * 100);
