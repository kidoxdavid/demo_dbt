import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi } from '../api';
import { Button, Chip } from '../components/ui';
import { money } from '../format';
import { useDesktop } from '../hooks';
import { cents, dollars, errText } from './fields';

const wrap = (desktop: boolean) => ({ className: `sd-page${desktop ? '' : ' pad'}`, style: desktop ? undefined : { paddingTop: 10 } });
const SERVING: Record<string, [string, 'ok' | 'outline' | '']> = { serving: ['Running', 'ok'], paused: ['Paused', 'outline'], ended: ['Ended', 'outline'], blocked: ['Stopped by staff', ''], budget_reached: ['Total budget reached', 'outline'], daily_budget_reached: ['Daily budget reached', 'outline'], low_balance: ['Not enough earnings to pay for clicks', ''] };
const MAP = { bid_too_low: 'That bid is below the minimum.', budget_below_bid: 'The daily budget must cover at least one click.', product_not_eligible: 'Only live products outside restricted categories can be advertised.', category_not_found: 'One of those categories does not exist.', blocked_by_staff: 'Staff stopped this campaign. See the reason below.', campaign_ended: 'This campaign has ended.', feature_off: 'Ads are switched off right now.' };
export const ServingChip = ({ s }: { s: string }) => { const [t, v] = SERVING[s] ?? [s, 'outline']; return <Chip variant={v as any}>{t}</Chip>; };

export function AdsPage() {
  const desktop = useDesktop(); const { data } = useApi<any>('/api/studio/ads');
  return <div {...wrap(desktop)}><div style={{ display: 'flex', alignItems: 'center' }}><h1 className="serif">Ads</h1><span style={{ marginLeft: 'auto' }}><Button size="sm" to="/studio/ads/new">New campaign</Button></span></div>
    <div className="sub">Sponsored pieces appear in category and search results, marked “Sponsored”. You pay only when someone opens one, and the cost comes out of your earnings. {data ? `Your earnings balance now: ${money(data.owedCents)}.` : ''}</div>
    {data?.campaigns.length === 0 ? <div className="empty"><h2 className="serif">No campaigns yet</h2><p>Pick the pieces you want seen, set what a click is worth to you and a daily limit. You can pause any time.</p></div>
      : <div className="card table">{(data?.campaigns ?? []).map((c: any) => <Link key={c.id} to={`/studio/ads/${c.id}`} className="tr"><div className="t"><b>{c.name}</b><div>{c.products.length} piece{c.products.length === 1 ? '' : 's'} · bid {money(c.bidCents)} · {c.impressions} views · {c.clicks} clicks · {money(c.spendCents)} spent</div></div><ServingChip s={c.serving} /></Link>)}</div>}</div>;
}

interface Form { name: string; productIds: string[]; bid: string; daily: string; total: string; categories: string[]; keywords: string }
export function AdEditor() {
  const { id = 'new' } = useParams(); const nav = useNavigate(); const desktop = useDesktop(); const isNew = id === 'new';
  const { data: ads } = useApi<any>('/api/studio/ads'); const { data: detail, reload } = useApi<any>(isNew ? null : `/api/studio/ads/${id}`); const { data: prods } = useApi<any>('/api/studio/products?status=published&limit=100'); const { data: cats } = useApi<{ slug: string; name: string }[]>('/api/categories');
  const [f, setF] = useState<Form | null>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  if (!isNew && detail && !f) setF({ name: detail.name, productIds: detail.products.map((p: any) => p.id), bid: dollars(detail.bidCents), daily: dollars(detail.dailyBudgetCents), total: detail.totalBudgetCents ? dollars(detail.totalBudgetCents) : '', categories: detail.categories, keywords: detail.keywords.join(', ') });
  if (isNew && !f && ads) setF({ name: '', productIds: [], bid: dollars(Math.max(50, ads.minBidCents)), daily: '5.00', total: '', categories: [], keywords: '' });
  if (!f || !ads) return <div className="pad" style={{ paddingTop: 30 }}><div className="skeleton" style={{ height: 240 }} /></div>;
  const toggle = (k: 'productIds' | 'categories', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v] });
  const body = () => ({ name: f.name.trim(), productIds: f.productIds, bidCents: cents(f.bid), dailyBudgetCents: cents(f.daily), totalBudgetCents: f.total.trim() ? cents(f.total) : null, categories: f.categories, keywords: f.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) });
  const save = async () => { setErr(''); setMsg(''); const b = body(); if (!b.bidCents || !b.dailyBudgetCents) return setErr('Enter the bid and the daily budget in dollars, for example 0.50.'); setBusy(true);
    try { if (isNew) { const c = await api<any>('/api/studio/ads', { method: 'POST', body: b }); nav(`/studio/ads/${c.id}`, { replace: true }); } else { await api(`/api/studio/ads/${id}`, { method: 'PATCH', body: b }); setMsg('Saved.'); reload(); } } catch (e) { setErr(errText(e, MAP)); } finally { setBusy(false); } };
  const status = async (s: 'active' | 'paused' | 'ended') => { if (s === 'ended' && !window.confirm('End this campaign for good? You cannot restart it.')) return; setErr(''); setBusy(true); try { await api(`/api/studio/ads/${id}`, { method: 'PATCH', body: { status: s } }); reload(); } catch (e) { setErr(errText(e, MAP)); } finally { setBusy(false); } };
  const editable = isNew || (detail && !['ended', 'blocked'].includes(detail.status));
  return <div {...wrap(desktop)}><Link to="/studio/ads" className="crumbs">‹ Ads</Link><div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}><h1 className="serif" style={{ fontSize: 30 }}>{isNew ? 'New campaign' : detail?.name}</h1>{detail && <ServingChip s={detail.serving} />}</div>
    {detail?.status === 'blocked' && <div className="notice">Staff stopped this campaign: {detail.blockedReason}</div>}
    {detail && <div className="card sd-card" style={{ marginTop: 16, maxWidth: 640 }}><div className="stat" style={{ marginTop: 0 }}>{[['Views', detail.impressions], ['Clicks', detail.clicks], ['Click rate', `${detail.ctr}%`], ['Spent', money(detail.spendCents)]].map(([l, n]) => <div key={l as string}><div className="n serif">{n}</div><div className="l">{l}</div></div>)}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Today: {money(detail.spendTodayCents)} of {money(detail.dailyBudgetCents)}. Last 14 days: {detail.daily.reduce((n: number, d: any) => n + d.clicks, 0)} clicks.</div></div>}
    <div className="form"><div className="card grp"><h2 className="serif">Campaign</h2><label className="label" htmlFor="ad-name">Name (only you see this)</label><input id="ad-name" className="field" value={f.name} maxLength={80} disabled={!editable} onChange={e => setF({ ...f, name: e.target.value })} />
      <div className="two"><div><label className="label" htmlFor="ad-bid">Most you will pay per click ($)</label><input id="ad-bid" className="field" inputMode="decimal" value={f.bid} disabled={!editable} onChange={e => setF({ ...f, bid: e.target.value })} /><div className="hint">Minimum {money(ads.minBidCents)}. You usually pay a little less: one cent over the next bid down.</div></div>
        <div><label className="label" htmlFor="ad-daily">Daily budget ($)</label><input id="ad-daily" className="field" inputMode="decimal" value={f.daily} disabled={!editable} onChange={e => setF({ ...f, daily: e.target.value })} /></div></div>
      <label className="label" htmlFor="ad-total">Total budget ($, optional)</label><input id="ad-total" className="field" inputMode="decimal" value={f.total} disabled={!editable} onChange={e => setF({ ...f, total: e.target.value })} /></div>
      <div className="card grp"><h2 className="serif">Pieces to promote</h2><div className="hint">Live pieces only. Restricted categories (toys, perfume, hair) cannot be advertised.</div>{(prods?.items ?? []).map((p: any) => <label key={p.id} className="tgl"><input type="checkbox" checked={f.productIds.includes(p.id)} disabled={!editable} onChange={() => toggle('productIds', p.id)} />{p.title}</label>)}{prods && prods.items.length === 0 && <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>You have no live products yet.</p>}</div>
      <div className="card grp"><h2 className="serif">Where it shows</h2><div className="hint">Leave both empty to show in the categories each piece belongs to, and in searches that match it.</div>
        <label className="label" htmlFor="ad-kw">Search words (comma separated)</label><input id="ad-kw" className="field" value={f.keywords} disabled={!editable} placeholder="mug, gift for mom" onChange={e => setF({ ...f, keywords: e.target.value })} />
        <div className="label">Categories</div>{(cats ?? []).map(c => <label key={c.slug} className="tgl"><input type="checkbox" checked={f.categories.includes(c.slug)} disabled={!editable} onChange={() => toggle('categories', c.slug)} />{c.name}</label>)}</div>
      {err && <div className="err" role="alert">{err}</div>}{msg && <div className="saved" role="status" style={{ color: 'var(--ok)' }}>{msg}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>{editable && <Button disabled={busy || !f.name.trim() || !f.productIds.length} onClick={save}>{isNew ? 'Start campaign' : 'Save changes'}</Button>}
        {detail?.status === 'active' && <Button variant="ghost" disabled={busy} onClick={() => status('paused')}>Pause</Button>}{detail?.status === 'paused' && <Button variant="ghost" disabled={busy} onClick={() => status('active')}>Resume</Button>}{detail && !['ended', 'blocked'].includes(detail.status) && <Button variant="ghost" disabled={busy} onClick={() => status('ended')}>End campaign</Button>}</div></div></div>;
}
