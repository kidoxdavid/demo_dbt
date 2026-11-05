import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText, money, toCents } from '../api';
import { Alert, Empty, Field } from '../ui';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const kept = (c: number) => <b className={c < 0 ? 'neg' : 'pos'}>{c < 0 ? '−' : ''}{money(Math.abs(c))}</b>;

/** Where each dollar went, as lines that add up. */
function Waterfall({ t }: { t: any }) {
  const rows: [string, number, boolean?][] = [
    ['You sold (after discounts)', t.salesCents], ['Delivery charged to customers', t.deliveryChargedCents],
    ['Cost of what you sold', -t.cogsCents], ['EazyStores fee', -t.platformFeesCents], ['Card fees (estimate)', -t.processingFeesCents],
    ['Delivery you paid', -t.deliveryPaidCents], ['Refunds', -t.refundsCents]];
  return <table className="wf"><tbody>
    {rows.map(([l, v]) => <tr key={l}><td>{l}</td><td className={v < 0 ? 'neg' : ''}>{v < 0 ? '−' : ''}{money(Math.abs(v))}</td></tr>)}
    <tr className="sub"><td>You kept</td><td>{kept(t.keepCents)}</td></tr>
    {t.expensesCents > 0 && <><tr><td>Business expenses (ads, packaging…)</td><td className="neg">−{money(t.expensesCents)}</td></tr><tr className="sub"><td>You kept after expenses</td><td>{kept(t.keepAfterExpensesCents)}</td></tr></>}
  </tbody></table>;
}

/** The headline of the whole product: what you actually keep. */
export function KeepHero() {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api(`/api/seller/profit?from=${encodeURIComponent(iso(30))}&to=${encodeURIComponent(iso(-1))}&tz=${encodeURIComponent(TZ)}`).then(setD).catch(() => setD(null)); }, []);
  if (!d) return null; const t = d.totals;
  const pct = t.salesCents > 0 ? Math.round((t.keepAfterExpensesCents / t.salesCents) * 100) : null;
  return <section className="card keephero"><div className="khead"><div><div className="eyebrow">Last 30 days · what you actually kept</div>
    <div className="kbig">{kept(t.keepAfterExpensesCents)}</div>
    <div className="muted small">{t.orders === 0 ? 'No paid orders yet.' : <>from {money(t.salesCents)} sold{pct != null && <> · <b>{pct}¢</b> of every dollar</>} · {t.orders} order{t.orders > 1 ? 's' : ''}</>}</div></div>
    <Link className="btn secondary sm" to="/dashboard/profit">See where it went</Link></div>
    {t.salesCents > 0 && <div className="kbar" role="img" aria-label="Where each dollar sold went">
      {[['You kept', Math.max(0, t.keepAfterExpensesCents), '#1f9d62'], ['Cost of goods', t.cogsCents, '#e0a000'], ['Fees', t.platformFeesCents + t.processingFeesCents, '#6a3fd1'], ['Delivery & refunds', t.deliveryPaidCents + t.refundsCents, '#d1456f'], ['Expenses', t.expensesCents, '#3347e0']]
        .filter(([, v]) => (v as number) > 0).map(([l, v, c]) => <span key={l as string} style={{ flex: v as number, background: c as string }} title={`${l}: ${money(v as number)}`} />)}</div>}
    {t.salesCents > 0 && <div className="klegend">{[['You kept', '#1f9d62'], ['Cost of goods', '#e0a000'], ['Fees', '#6a3fd1'], ['Delivery & refunds', '#d1456f'], ['Expenses', '#3347e0']].map(([l, c]) => <span key={l}><i style={{ background: c }} />{l}</span>)}</div>}
    {(d.flags.itemsMissingCost > 0 || d.flags.deliveryOrdersMissingCost > 0) && <p className="muted small" style={{ marginBottom: 0 }}>
      {d.flags.itemsMissingCost > 0 && <>⚠ {d.flags.itemsMissingCost} sold item(s) have no cost price, so this is overstated. <Link to="/dashboard/products">Add costs</Link>. </>}
      {d.flags.deliveryOrdersMissingCost > 0 && <>⚠ {d.flags.deliveryOrdersMissingCost} delivery order(s) have no delivery cost entered. <Link to="/dashboard/orders">Enter them</Link>.</>}</p>}
  </section>;
}

export function Profit() {
  const [days, setDays] = useState(30); const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  const load = useCallback(() => api(`/api/seller/profit?${days ? `from=${encodeURIComponent(iso(days))}&` : ''}to=${encodeURIComponent(iso(-1))}&tz=${encodeURIComponent(TZ)}`).then(setD).catch(e => setErr(e?.status === 403 ? 'Only the owner and managers can see profit.' : errorText(e))), [days]);
  useEffect(() => { load(); }, [load]);
  if (err) return <Alert kind="err">{err}</Alert>;
  const max = Math.max(1, ...(d?.byDay ?? []).map((x: any) => Math.abs(x.keepCents)));
  return <>
    <div className="pagehead"><div><div className="eyebrow">Profit</div><h1>What you keep</h1></div>
      <div className="row" role="group" aria-label="Period">{[[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']].map(([n, l]) => <button key={n as number} className={days === n ? '' : 'secondary'} onClick={() => setDays(n as number)}>{l}</button>)}</div></div>
    {!d ? <p className="muted">Loading…</p> : d.totals.orders === 0 && d.totals.expensesCents === 0 ? <Empty title="Nothing in this period">Paid orders appear here with every cost taken off.</Empty> : <>
      <div className="grid2" style={{ alignItems: 'start' }}>
        <section className="card"><h2>Where the money went</h2><Waterfall t={d.totals} />
          {d.flags.processingFeeIsEstimate && <p className="muted small">Card fees are estimated at {(d.flags.processingFeeRate.bps / 100).toFixed(2)}% + {money(d.flags.processingFeeRate.fixedCents)} per online order until a payment provider reports the real figure.</p>}</section>
        <section className="card"><h2>By channel</h2><table><thead><tr><th>Channel</th><th>Orders</th><th>Sold</th><th>Kept</th></tr></thead>
          <tbody>{d.byChannel.map((c: any) => <tr key={c.channel}><td>{c.channel}</td><td>{c.orders}</td><td>{money(c.salesCents)}</td><td>{kept(c.keepCents)}</td></tr>)}</tbody></table></section>
      </div>
      <section className="card"><h2>By product</h2><p className="muted small">What each product earns you per sale, after its share of discounts and fees. Sorted by total kept.</p>
        <div className="table-scroll"><table><thead><tr><th>Product</th><th>Units</th><th>Sold</th><th>Kept</th><th>Kept per unit</th></tr></thead>
          <tbody>{d.byProduct.map((p: any) => <tr key={p.name}><td>{p.name}{p.missingCost && <span title="No cost price on some sales"> ⚠</span>}</td><td>{p.units}</td><td>{money(p.salesCents)}</td><td>{kept(p.keepCents)}</td><td>{kept(p.keepPerUnitCents)}</td></tr>)}</tbody></table></div></section>
      {d.byDay.length > 1 && <section className="card"><h2>By day</h2><div className="bars" role="img" aria-label="Amount kept per day">{d.byDay.map((x: any) => <div key={x.date} title={`${x.date}: kept ${money(x.keepCents)} of ${money(x.salesCents)}`}><i className={x.keepCents < 0 ? 'neg' : ''} style={{ height: `${Math.max(3, (Math.abs(x.keepCents) / max) * 100)}%` }} /></div>)}</div></section>}
      <ul className="muted small">{d.notes.map((n: string) => <li key={n}>{n}</li>)}</ul></>}
    <Expenses onChange={load} />
  </>;
}

function Expenses({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<any[]>([]); const [f, setF] = useState({ spentOn: new Date().toISOString().slice(0, 10), category: 'ads', amount: '', note: '' }); const [err, setErr] = useState('');
  const load = useCallback(() => api('/api/seller/expenses').then(setItems).catch(() => {}), []); useEffect(() => { load(); }, [load]);
  async function add(e: FormEvent) { e.preventDefault(); setErr(''); try { await api('/api/seller/expenses', { body: { spentOn: f.spentOn, category: f.category, amountCents: toCents(f.amount), note: f.note || undefined } }); setF({ ...f, amount: '', note: '' }); load(); onChange(); } catch (x) { setErr(errorText(x)); } }
  async function del(id: string) { await api(`/api/seller/expenses/${id}`, { method: 'DELETE' }).catch(() => {}); load(); onChange(); }
  return <section className="card"><h2>Business expenses</h2><p className="muted small">Ads, packaging, supplies: money you spend that is not tied to one order. It comes off what you keep.</p>
    {err && <Alert kind="err">{err}</Alert>}
    <form className="grid2" onSubmit={add}>
      <Field label="Date">{id => <input id={id} type="date" required value={f.spentOn} onChange={e => setF({ ...f, spentOn: e.target.value })} />}</Field>
      <Field label="Type">{id => <select id={id} value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="ads">Advertising</option><option value="packaging">Packaging</option><option value="supplies">Supplies</option><option value="software">Software</option><option value="other">Other</option></select>}</Field>
      <Field label="Amount ($)">{id => <input id={id} required inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} />}</Field>
      <Field label="Note (optional)">{id => <input id={id} maxLength={200} value={f.note} onChange={e => setF({ ...f, note: e.target.value })} />}</Field>
      <div><button>Add expense</button></div></form>
    {items.length > 0 && <div className="table-scroll"><table><tbody>{items.map(x => <tr key={x.id}><td>{new Date(x.spentOn).toISOString().slice(0, 10)}</td><td style={{ textTransform: 'capitalize' }}>{x.category}</td><td>{x.note}</td><td>{money(x.amountCents)}</td><td><button className="ghost sm" onClick={() => del(x.id)}>Remove</button></td></tr>)}</tbody></table></div>}</section>;
}

/** Order page: this order's economics, and the delivery cost field that completes them. */
export function OrderKeep({ orderId, status }: { orderId: string; status: string }) {
  const [k, setK] = useState<any>(null); const [cost, setCost] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => api(`/api/seller/orders/${orderId}/profit`).then(r => { setK(r); setCost(r.deliveryCostMissing ? '' : (r.deliveryPaidCents / 100).toFixed(2)); }).catch(() => setK(null)), [orderId]);
  useEffect(() => { load(); }, [load, status]);
  if (!k) return null;
  async function save(e: FormEvent) { e.preventDefault(); setMsg(''); try { await api(`/api/seller/orders/${orderId}/delivery-cost`, { method: 'PATCH', body: { cents: cost === '' ? null : toCents(cost) } }); setMsg('Saved.'); load(); } catch (x) { setMsg(errorText(x)); } }
  return <div className="orderkeep"><h3>You keep on this order: {kept(k.keepCents)}</h3>
    <table className="wf"><tbody>
      <tr><td>Sold after discount</td><td>{money(k.salesCents)}</td></tr>{k.deliveryChargedCents > 0 && <tr><td>Delivery charged</td><td>{money(k.deliveryChargedCents)}</td></tr>}
      <tr><td>Cost of goods{k.missingCostLines > 0 ? ' ⚠ some items have no cost' : ''}</td><td className="neg">−{money(k.cogsCents)}</td></tr><tr><td>EazyStores fee</td><td className="neg">−{money(k.platformFeeCents)}</td></tr>
      {k.processingFeeCents > 0 && <tr><td>Card fee (estimate)</td><td className="neg">−{money(k.processingFeeCents)}</td></tr>}{k.deliveryPaidCents > 0 && <tr><td>Delivery you paid</td><td className="neg">−{money(k.deliveryPaidCents)}</td></tr>}
      {k.refundsCents > 0 && <tr><td>Refunds</td><td className="neg">−{money(k.refundsCents)}</td></tr>}</tbody></table>
    {k.fulfilment === 'delivery' && <form className="row" onSubmit={save} style={{ alignItems: 'flex-end' }}><Field label="What you paid to deliver it ($)" hint={k.deliveryCostMissing ? 'Not entered yet, so the figure above is overstated.' : undefined}>{id => <input id={id} inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} />}</Field><button className="secondary sm">Save</button>{msg && <span className="muted small">{msg}</span>}</form>}
  </div>;
}

/** Under a product option's price and cost: what you keep per sale, live. */
export function PriceHint({ price, cost }: { price: string; cost: string }) {
  const [r, setR] = useState<any>(null);
  useEffect(() => {
    const p = toCents(price); if (!price || p <= 0) { setR(null); return; }
    const h = setTimeout(() => api('/api/seller/profit/price-check', { body: { priceCents: p, costCents: cost ? toCents(cost) : 0 } }).then(setR).catch(() => setR(null)), 300); return () => clearTimeout(h);
  }, [price, cost]);
  if (!r) return null;
  return <div className={`pricehint ${r.verdict}`} style={{ gridColumn: '1 / -1' }} role="status">
    {r.verdict === 'loses_money' ? <>⚠ <b>You lose {money(-r.keepCents)} on every sale at this price</b> after fees{r.suggestedPriceCents ? <>. For a {r.targetMarginPct}% margin, charge about <b>{money(r.suggestedPriceCents)}</b></> : ''}.</>
      : <>You keep <b>{money(r.keepCents)}</b> per sale ({r.marginPct}%) after the {money(r.platformFeeCents)} platform fee and ~{money(r.processingFeeCents)} card fee.{!cost && ' Add your cost for a real figure.'}{r.verdict === 'thin' && r.suggestedPriceCents ? <> That is thin; about <b>{money(r.suggestedPriceCents)}</b> would give {r.targetMarginPct}%.</> : null}</>}</div>;
}
