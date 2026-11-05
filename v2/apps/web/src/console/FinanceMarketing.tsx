import { useEffect, useState } from 'react';
import { api, useApi } from '../api';
import { Button, Chip } from '../components/ui';
import { money } from '../format';
import { cents, dollars } from '../studio/fields';
import { Page, Rows, SearchBar, Stat, day, fail, stamp } from './shared';

const Spark = ({ daily }: { daily: { day: string; cents: number }[] }) => {
  const max = Math.max(1, ...daily.map(d => d.cents)); const pts = daily.map((d, i) => `${i ? 'L' : 'M'}${((i / Math.max(1, daily.length - 1)) * 300).toFixed(0)} ${(76 - (d.cents / max) * 68).toFixed(0)}`).join(' ');
  return <svg viewBox="0 0 300 80" style={{ width: '100%', height: 90 }} role="img" aria-label="Sales over the last 30 days"><path d={pts} fill="none" stroke="var(--acc)" strokeWidth="3" strokeLinecap="round" /></svg>;
};

export function FinanceOverview() {
  const { data: o } = useApi<any>('/api/finance/overview'); if (!o) return <div className="skeleton" style={{ height: 200 }} />;
  return <Page title="Finance" sub="Straight from the ledger. Every entry balances to zero.">
    <div style={{ display: 'flex', gap: 16, marginTop: 18, flexWrap: 'wrap' }}><Stat n={money(o.ledger.cash)} l="Cash received" sub="Payments in, refunds and payouts out" /><Stat n={money(o.ledger.sellerPayable)} l="Owed to sellers" sub={`${money(o.availableToPay)} can be paid now`} /><Stat n={money(o.ledger.commissionRevenue)} l="Commission earned" /><Stat n={money(o.ledger.taxPayable)} l="GST to remit" /></div>
    <div className="card sd-card" style={{ marginTop: 16 }}><div className="hd" style={{ display: 'flex', justifyContent: 'space-between' }}><b>Last 30 days</b><span className="muted" style={{ fontSize: 13 }}>{o.last30.orders} seller orders · {money(o.last30.sales)} sales · {money(o.last30.commission)} commission</span></div><Spark daily={o.daily} /></div>
    <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>Sellers become payable {o.payoutHoldDays} days after delivery (a setting).</p></Page>;
}

export function SellerBalances() {
  const [term, setTerm] = useState(''); const { data, reload } = useApi<{ holdDays: number; items: any[] }>(`/api/finance/sellers?limit=100${term ? `&q=${encodeURIComponent(term)}` : ''}`); const { data: payouts, reload: reloadP } = useApi<any[]>('/api/finance/payouts?limit=20'); const [paying, setPaying] = useState<any>(null);
  return <Page title="Seller balances" sub={data ? `Money becomes available ${data.holdDays} days after delivery. A payout is recorded after you have sent the bank transfer.` : ' '}><SearchBar value={term} onChange={setTerm} placeholder="Search sellers" />
    <Rows empty="No sellers.">{(data?.items ?? []).map(s => <div key={s.id} className="tr" style={{ flexWrap: 'wrap' }}><div className="t"><b>{s.shop ?? s.legalName}</b><div>{s.legalName} · {s.orders} orders · {money(s.salesCents)} sold · {money(s.paidOutCents)} paid out</div></div><div style={{ textAlign: 'right' }}><b>{money(s.availableCents)}</b><div className="muted" style={{ fontSize: 12 }}>available · {money(s.pendingCents)} on hold</div></div><Button size="sm" variant="ghost" disabled={s.availableCents <= 0} onClick={() => setPaying(paying?.id === s.id ? null : s)}>Record payout…</Button>{paying?.id === s.id && <PayoutForm seller={s} onDone={() => { setPaying(null); reload(); reloadP(); }} />}</div>)}</Rows>
    <h2 className="serif" style={{ fontSize: 20, marginTop: 24 }}>Recent payouts</h2><Rows empty="No payouts yet.">{(payouts ?? []).map(p => <div key={p.id} className="tr"><div className="t"><b>{p.seller}</b><div>{p.reference}{p.note ? ` · ${p.note}` : ''} · {p.byEmail ?? ''} · {stamp(p.createdAt)}</div></div><b>{money(p.amountCents)}</b></div>)}</Rows></Page>;
}
function PayoutForm({ seller, onDone }: { seller: any; onDone: () => void }) {
  const [amount, setAmount] = useState(dollars(seller.availableCents)); const [ref, setRef] = useState(''); const [note, setNote] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const c = cents(amount);
  const go = async () => { setErr(''); setBusy(true); try { await api('/api/finance/payouts', { method: 'POST', body: { sellerId: seller.id, amountCents: c, reference: ref.trim(), ...(note.trim() ? { note: note.trim() } : {}) } }); onDone(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  return <div style={{ flexBasis: '100%', borderTop: '1px solid var(--line)', paddingTop: 12 }}><div className="two" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}><div><label className="label" htmlFor={`pa-${seller.id}`}>Amount ($)</label><input id={`pa-${seller.id}`} className="field" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></div><div><label className="label" htmlFor={`pr-${seller.id}`}>Bank transfer reference</label><input id={`pr-${seller.id}`} className="field" value={ref} onChange={e => setRef(e.target.value)} /></div></div>
    <label className="label" htmlFor={`pn-${seller.id}`}>Note (optional)</label><input id={`pn-${seller.id}`} className="field" value={note} onChange={e => setNote(e.target.value)} />{err && <div className="err" role="alert">{err}</div>}
    <Button size="sm" style={{ marginTop: 12 }} disabled={busy || !c || c > seller.availableCents || !ref.trim()} onClick={go}>Record payout of {c ? money(c) : '…'}</Button></div>;
}

export function Reports() {
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const qs = `${from ? `from=${from}` : ''}${from && to ? '&' : ''}${to ? `to=${to}` : ''}`; const { data: g, error } = useApi<any>(`/api/finance/gst${qs ? `?${qs}` : ''}`);
  return <Page title="GST and exports" sub="Tax collected from buyers, less tax returned on refunds, for any period. Leave the dates empty for all time.">
    <div className="tools"><label className="label" style={{ margin: 0 }}>From <input className="field" type="date" aria-label="From date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="label" style={{ margin: 0 }}>To <input className="field" type="date" aria-label="To date" value={to} onChange={e => setTo(e.target.value)} /></label></div>
    {error ? <div className="err" role="alert">Check the dates.</div> : g && <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap' }}><Stat n={money(g.collectedCents)} l="GST collected" /><Stat n={money(g.refundedCents)} l="GST returned on refunds" /><Stat n={money(g.netOwedCents)} l="Net GST to remit" /></div>}
    <div className="card sd-card" style={{ marginTop: 16 }}><b>Sales export</b><p className="muted" style={{ fontSize: 13, marginTop: 4 }}>One row per seller order: items, shipping, GST, total, commission and refunds, as a spreadsheet file. Downloads are written to the audit log.</p>
      <a className="btn sm" style={{ marginTop: 12 }} href={`/api/finance/export/sales.csv${qs ? `?${qs}` : ''}`} download>Download sales CSV</a></div></Page>;
}

// ================================================ marketing
interface Home { promoBar: string; phone: string[]; desktop: string[]; categories: any[]; spotlight: { shop: string; quote: string; art?: any } | null; products: Record<string, { title: string; seller: string }> }
function Picks({ label, ids, titles, onChange }: { label: string; ids: string[]; titles: Home['products']; onChange: (ids: string[], titles: Home['products']) => void }) {
  const [term, setTerm] = useState(''); const { data } = useApi<any[]>(`/api/marketing/products?limit=8${term.trim() ? `&q=${encodeURIComponent(term.trim())}` : ''}`);
  const move = (i: number, d: number) => { const n = [...ids]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; onChange(n, titles); };
  return <div className="card sd-card" style={{ marginTop: 16 }}><b>{label}</b><div className="hint muted" style={{ fontSize: 12, marginTop: 2 }}>In the order shown. Leave empty to show the newest pieces.</div>
    {ids.map((id, i) => <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 14 }}><span style={{ flex: 1 }}>{i + 1}. {titles[id]?.title ?? id.slice(0, 8)} <span className="muted">· {titles[id]?.seller}</span></span><button type="button" aria-label="Move up" onClick={() => move(i, -1)}>↑</button><button type="button" aria-label="Move down" onClick={() => move(i, 1)}>↓</button><button type="button" aria-label={`Remove ${titles[id]?.title ?? 'product'}`} onClick={() => onChange(ids.filter(x => x !== id), titles)}>✕</button></div>)}
    <input className="field" type="search" style={{ marginTop: 12 }} aria-label={`Find a product for ${label}`} placeholder="Find a product to add" value={term} onChange={e => setTerm(e.target.value)} />
    {term.trim() && (data ?? []).filter(c => !ids.includes(c.id)).map(c => <button key={c.id} type="button" className="opt" style={{ display: 'flex', justifyContent: 'space-between', width: '100%', padding: '10px 0', borderTop: '1px solid var(--line)', fontSize: 14 }} onClick={() => { onChange([...ids, c.id].slice(0, 12), { ...titles, [c.id]: { title: c.title, seller: c.seller.name } }); setTerm(''); }}><span>{c.title}</span><span className="muted">{c.seller.name}</span></button>)}</div>;
}
export function HomeEditor() {
  const { data, reload } = useApi<Home>('/api/marketing/home'); const [f, setF] = useState<Home | null>(null); const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data && !f) setF(data); }, [data, f]); if (!f) return <div className="skeleton" style={{ height: 240 }} />;
  const save = async () => { setErr(''); setMsg(''); setBusy(true); try { await api('/api/marketing/home', { method: 'PUT', body: { promoBar: f.promoBar, phone: f.phone, desktop: f.desktop, categories: f.categories, spotlight: f.spotlight } }); setMsg('Saved. The shop home page now shows this.'); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  const setTile = (i: number, k: string, v: string) => setF({ ...f, categories: f.categories.map((c, j) => (j === i ? { ...c, [k]: v } : c)) });
  return <Page title="Home page" sub="What shoppers see first. Changes go live as soon as you save, and every change is in the audit log." actions={<Button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Button>}>
    {err && <div className="err" role="alert">{err}</div>}{msg && <div className="saved" role="status" style={{ color: 'var(--ok)' }}>{msg}</div>}
    <div className="card sd-card form" style={{ marginTop: 16 }}><b>Bar above the header (desktop)</b><label className="label" htmlFor="hm-promo">Text (empty hides the bar)</label><input id="hm-promo" className="field" maxLength={140} value={f.promoBar} onChange={e => setF({ ...f, promoBar: e.target.value })} /></div>
    <Picks label="New from makers: phones" ids={f.phone} titles={f.products} onChange={(ids, t) => setF({ ...f, phone: ids, products: t })} /><Picks label="New from makers: desktop" ids={f.desktop} titles={f.products} onChange={(ids, t) => setF({ ...f, desktop: ids, products: t })} />
    <div className="card sd-card" style={{ marginTop: 16 }}><b>Category tiles</b><div className="hint muted" style={{ fontSize: 12, marginTop: 2 }}>Up to twelve. The category is the page it opens; the label is what shoppers read.</div>
      {f.categories.map((c, i) => <div key={i} style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}><input className="field" aria-label={`Tile ${i + 1} label`} value={c.label} maxLength={30} onChange={e => setTile(i, 'label', e.target.value)} /><input className="field" aria-label={`Tile ${i + 1} category`} value={c.slug} onChange={e => setTile(i, 'slug', e.target.value)} /><button type="button" aria-label={`Remove tile ${c.label}`} onClick={() => setF({ ...f, categories: f.categories.filter((_, j) => j !== i) })}>✕</button></div>)}
      {f.categories.length < 12 && <Button size="sm" variant="ghost" style={{ marginTop: 12 }} onClick={() => setF({ ...f, categories: [...f.categories, { slug: '', label: '', kind: 'pottery', tone: 'warm' }] })}>Add a tile</Button>}</div>
    <div className="card sd-card form" style={{ marginTop: 16 }}><b>Maker spotlight</b>{f.spotlight ? <><label className="label" htmlFor="hm-shop">Shop (its link name)</label><input id="hm-shop" className="field" value={f.spotlight.shop} onChange={e => setF({ ...f, spotlight: { ...f.spotlight!, shop: e.target.value.trim() } })} /><label className="label" htmlFor="hm-quote">Quote</label><textarea id="hm-quote" className="field" rows={3} maxLength={400} value={f.spotlight.quote} onChange={e => setF({ ...f, spotlight: { ...f.spotlight!, quote: e.target.value } })} /><Button size="sm" variant="ghost" style={{ marginTop: 12 }} onClick={() => setF({ ...f, spotlight: null })}>Remove the spotlight</Button></>
      : <Button size="sm" variant="ghost" style={{ marginTop: 12 }} onClick={() => setF({ ...f, spotlight: { shop: '', quote: '' } })}>Add a spotlight</Button>}</div></Page>;
}

export function Synonyms() {
  const { data, reload } = useApi<{ term: string; related: string[] }[]>('/api/marketing/synonyms'); const [term, setTerm] = useState(''); const [related, setRelated] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const add = async () => { setErr(''); setBusy(true); try { await api('/api/marketing/synonyms', { method: 'PUT', body: { term: term.trim(), related: related.split(',').map(x => x.trim()).filter(Boolean) } }); setTerm(''); setRelated(''); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  const del = async (t: string) => { try { await api(`/api/marketing/synonyms/${encodeURIComponent(t)}`, { method: 'DELETE' }); reload(); } catch (e) { setErr(fail(e)); } };
  return <Page title="Search words" sub="When a shopper searches a word, pieces that match its synonyms are found too. Only add words a person has confirmed mean the same thing.">
    <div className="card sd-card form" style={{ marginTop: 16 }}><label className="label" style={{ marginTop: 0 }} htmlFor="sy-t">Shoppers search for</label><input id="sy-t" className="field" value={term} onChange={e => setTerm(e.target.value)} placeholder="carafe" /><label className="label" htmlFor="sy-r">Also find (comma separated)</label><input id="sy-r" className="field" value={related} onChange={e => setRelated(e.target.value)} placeholder="pitcher, jug" />
      {err && <div className="err" role="alert">{err}</div>}<Button size="sm" style={{ marginTop: 12 }} disabled={busy || term.trim().length < 2 || !related.trim()} onClick={add}>Save</Button></div>
    <Rows empty="No synonyms yet.">{(data ?? []).map(s => <div key={s.term} className="tr"><div className="t"><b>{s.term}</b><div>also finds {s.related.join(', ')}</div></div><Button size="sm" variant="ghost" onClick={() => del(s.term)}>Remove</Button></div>)}</Rows></Page>;
}
void Chip; void day;
