import { useState } from 'react';
import { useApi } from '../api';
import { Button } from '../components/ui';
import { money } from '../format';
import { useDesktop } from '../hooks';

const wrap = (desktop: boolean) => ({ className: `sd-page${desktop ? '' : ' pad'}`, style: desktop ? undefined : { paddingTop: 10 } });
const Change = ({ pct }: { pct: number | null }) => (pct === null ? <span className="muted">nothing earlier to compare</span> : <span style={{ color: pct >= 0 ? 'var(--ok)' : 'var(--mut)' }}>{pct >= 0 ? '▲' : '▼'} {Math.abs(pct)}% vs the period before</span>);
const Stat = ({ label, value, note }: { label: string; value: string; note?: React.ReactNode }) => <div className="card sd-card" style={{ flex: '1 1 150px', minWidth: 150 }}><div className="muted" style={{ fontSize: 13 }}>{label}</div><div className="serif" style={{ fontSize: 28, margin: '4px 0' }}>{value}</div>{note && <div style={{ fontSize: 13 }}>{note}</div>}</div>;

/** How the shop is doing: real sales, orders and visits from this maker's own data, with a daily chart and the best-selling pieces. */
export function InsightsPage() {
  const desktop = useDesktop(); const [days, setDays] = useState(30); const { data, error } = useApi<any>(`/api/studio/insights?days=${days}`);
  const max = Math.max(1, ...(data?.daily ?? []).map((d: any) => d.cents)); const [table, setTable] = useState(false);
  return <div {...wrap(desktop)}><h1 className="serif">Insights</h1><div className="sub">How your shop is doing. These numbers come straight from your orders and page views.</div>
    <div role="group" aria-label="Time range" style={{ display: 'flex', gap: 8, margin: '14px 0', flexWrap: 'wrap' }}>{[7, 30, 90].map(d => <Button key={d} size="sm" variant={days === d ? undefined : 'ghost'} aria-pressed={days === d} onClick={() => setDays(d)}>Last {d} days</Button>)}</div>
    {error && <div className="err" role="alert">Could not load your numbers. Try again in a moment.</div>}
    {!data ? <div className="skeleton" style={{ height: 220 }} /> : <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}><Stat label="Sales" value={money(data.salesCents)} note={<Change pct={data.change.sales} />} /><Stat label="Orders" value={String(data.orders)} note={<Change pct={data.change.orders} />} /><Stat label="Shop visits" value={String(data.visits)} note={<Change pct={data.change.visits} />} /><Stat label="Average order" value={money(data.avgOrderCents)} /><Stat label="Visits that became orders" value={data.conversionPct === null ? '—' : `${data.conversionPct}%`} /></div>
      {data.orders === 0 && data.visits === 0 ? <div className="empty" style={{ marginTop: 16 }}><h2 className="serif">Nothing to show yet</h2><p>Once people visit your shop and place orders, you will see how you are doing here. Share your shop link to get started.</p></div> : <>
        <h2 className="serif" style={{ fontSize: 20, marginTop: 24 }}>Sales each day</h2>
        <div role="img" aria-label={`Sales per day over the last ${days} days, highest day ${money(max)}`} style={{ display: 'flex', alignItems: 'flex-end', gap: days > 30 ? 1 : 3, height: 140, marginTop: 8 }}>{data.daily.map((d: any) => <div key={d.day} title={`${d.day}: ${money(d.cents)}`} style={{ flex: 1, minWidth: 2, height: `${Math.max(2, (d.cents / max) * 100)}%`, background: d.cents ? 'var(--acc)' : 'var(--line)', borderRadius: 2 }} />)}</div>
        <Button size="sm" variant="ghost" style={{ marginTop: 8 }} aria-expanded={table} onClick={() => setTable(!table)}>{table ? 'Hide the table' : 'Show as a table'}</Button>
        {table && <div className="card table" style={{ marginTop: 8 }}>{data.daily.filter((d: any) => d.cents || d.views).map((d: any) => <div key={d.day} className="tr"><div className="t"><b>{d.day}</b><div>{d.views} visits</div></div><b>{money(d.cents)}</b></div>)}</div>}
        <h2 className="serif" style={{ fontSize: 20, marginTop: 24 }}>Best sellers</h2>
        {data.top.length === 0 ? <p className="muted">No sales in this period yet.</p> : <div className="card table">{data.top.map((t: any) => <div key={t.title} className="tr"><div className="t"><b>{t.title}</b><div>{t.units} sold</div></div><b>{money(t.cents)}</b></div>)}</div>}</>}</>}</div>;
}

/** What the marketplace owes this maker: ready to be paid, still in the hold period, and what has been paid. */
export function PayoutsPage() {
  const desktop = useDesktop(); const { data, error } = useApi<any>('/api/studio/payouts');
  return <div {...wrap(desktop)}><h1 className="serif">Payouts</h1><div className="sub">Your earnings after the marketplace's commission. Money becomes ready to pay {data ? `${data.holdDays} days` : 'a few days'} after an order is delivered, so refunds and problems can be sorted first.</div>
    {error && <div className="err" role="alert">Could not load your payouts. Try again in a moment.</div>}
    {!data ? <div className="skeleton" style={{ height: 160, marginTop: 16 }} /> : <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}><Stat label="Ready to be paid" value={money(data.availableCents)} /><Stat label="Waiting (in the hold period or not yet delivered)" value={money(data.pendingCents)} /><Stat label="Already paid to you" value={money(data.paidOutCents)} /></div>
      <div className="card sd-card" style={{ marginTop: 16 }}><b>How you get paid</b><p className="muted" style={{ margin: '6px 0 0' }}>The marketplace team sends your payout and records it here with a reference. Automatic bank deposits are not switched on yet. Your sales so far: {money(data.salesCents)}, commission {money(data.commissionCents)}, refunded {money(data.refundedCents)}.</p></div>
      <h2 className="serif" style={{ fontSize: 20, marginTop: 24 }}>Payments sent to you</h2>
      {data.history.length === 0 ? <div className="empty"><h2 className="serif">No payouts yet</h2><p>When your first payout is sent, it will appear here with its reference.</p></div> : <div className="card table">{data.history.map((p: any) => <div key={p.id} className="tr"><div className="t"><b>{money(p.amountCents)}</b><div>{new Date(p.createdAt).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })} · reference {p.reference}{p.note ? ` · ${p.note}` : ''}</div></div></div>)}</div>}</>}</div>;
}
