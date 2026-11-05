/** Money is integer cents. No floating point ever touches an amount that is stored or charged. */
export const percentOf = (cents: number, bps: number) => Math.floor((cents * bps + 5000) / 10000);        // round half up, integers only
/** Split `total` across `weights` so the parts add up EXACTLY (largest remainder; ties go to the earlier line). */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0); if (total === 0 || sum === 0) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / sum); const base = raw.map(Math.floor); let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) { if (left <= 0) break; base[o.i]++; left--; } return base;
}
export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
