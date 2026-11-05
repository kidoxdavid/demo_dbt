/** Money is integer cents everywhere. Cards show whole dollars when there are no cents ("$34"); totals always show cents ("$48.00"). */
export const money = (c: number) => `$${(c / 100).toFixed(2)}`;
export const moneyShort = (c: number) => (c % 100 === 0 ? `$${c / 100}` : money(c));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parts = (iso: string) => { const [, m, d] = iso.slice(0, 10).split('-').map(Number); return { m: MONTHS[m - 1], d }; };
/** "Nov 12–16", or "Nov 28 – Dec 3" across months. Dates are calendar days (YYYY-MM-DD), never shifted by time zone. */
export function dateRange(min: string, max: string) { const a = parts(min), b = parts(max); if (min.slice(0, 10) === max.slice(0, 10)) return `${a.m} ${a.d}`; return a.m === b.m ? `${a.m} ${a.d}–${b.d}` : `${a.m} ${a.d} – ${b.m} ${b.d}`; }
