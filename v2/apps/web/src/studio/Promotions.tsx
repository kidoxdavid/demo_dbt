import { useEffect, useState } from 'react';
import { api, ApiError, useApi } from '../api';
import { Button, Chip } from '../components/ui';
import { useDesktop } from '../hooks';
import { Switch } from '../console/shared';

const wrap = (desktop: boolean) => ({ className: `sd-page${desktop ? '' : ' pad'}`, style: desktop ? undefined : { paddingTop: 10 } });
const STATUS: Record<string, [string, 'ok' | 'outline' | '']> = { live: ['Showing on your store page', 'ok'], pending: ['Waiting for approval', 'outline'], paused: ['Hidden by you', 'outline'], rejected: ['Not approved', ''], ended: ['Ended', 'outline'] };
const MAP: Record<string, string> = { product_not_yours: 'Pick one of your own live pieces.', ends_before_start: 'The end date must be after the start date.', feature_off: 'Store promotions are switched off for now.', not_approved: 'It needs approval before it can show.', rejected_by_staff: 'Staff did not approve it. Change the wording and save to send it again.', validation_failed: 'Check the headline (up to 60 characters) and the other fields.' };
const say = (e: unknown) => (e instanceof ApiError ? MAP[e.code] ?? 'Something went wrong. Try again.' : 'Something went wrong. Try again.');

export function PromotionPage() {
  const desktop = useDesktop(); const { data, reload, error } = useApi<any>('/api/studio/promotion');
  const p = data?.promotion; const [f, setF] = useState({ headline: '', body: '', ctaLabel: 'Shop now', productId: '', startsOn: '', endsOn: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState('');
  useEffect(() => { if (data) setF({ headline: p?.headline ?? '', body: p?.body ?? '', ctaLabel: p?.ctaLabel ?? 'Shop now', productId: p?.productId ?? '', startsOn: p?.startsOn ?? '', endsOn: p?.endsOn ?? '' }); }, [data]);     // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { setErr(''); setSaved(''); setBusy(true); try { const r = await api('/api/studio/promotion', { method: 'PUT', body: { headline: f.headline, body: f.body, ctaLabel: f.ctaLabel, productId: f.productId || null, ...(f.startsOn ? { startsOn: f.startsOn } : {}), endsOn: f.endsOn || null } }); setSaved(data?.requiresApproval ? 'Saved. Staff will look at it before visitors see it.' : 'Saved. It is showing on your store page.'); void r; reload(); } catch (e) { setErr(say(e)); } finally { setBusy(false); } };
  const setStatus = async (status: string) => { setErr(''); setSaved(''); try { await api('/api/studio/promotion/status', { method: 'POST', body: { status } }); reload(); } catch (e) { setErr(say(e)); } };
  if (error?.code === 'feature_off') return <div {...wrap(desktop)}><h1 className="serif">Store promotion</h1><div className="empty"><h2 className="serif">Not available right now</h2><p>Store promotions are switched off for the whole shop for the moment.</p></div></div>;
  const [label, variant] = STATUS[p?.status ?? ''] ?? ['', 'outline'];
  return <div {...wrap(desktop)}><h1 className="serif">Store promotion</h1>
    <div className="sub">A banner at the top of your own store page. Say what is special and feature one of your pieces. {data?.requiresApproval ? 'Staff check each promotion before visitors see it.' : 'It shows as soon as you save it.'}</div>
    {p && <div className="card sd-card" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}><div style={{ flex: 1, minWidth: 200 }}><Chip variant={variant as any}>{label}</Chip><div style={{ marginTop: 6 }} className="muted">{p.views} visitors saw it · {p.clicks} clicks</div>{p.status === 'rejected' && <div className="err" role="alert" style={{ marginTop: 8 }}>Staff said: {p.rejectReason}</div>}</div>
      {(p.status === 'live' || (p.status === 'paused' && p.approved)) && <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span id="promo-show">Show on my store page</span><Switch on={p.status === 'live'} label="Show on my store page" onChange={on => setStatus(on ? 'live' : 'paused')} /></div>}
      <Button size="sm" variant="ghost" onClick={() => setStatus('ended')}>End it</Button></div>}
    <div className="card sd-card form" style={{ marginTop: 16 }}>
      <label className="label" style={{ marginTop: 0 }} htmlFor="pr-h">Headline</label><input id="pr-h" className="field" maxLength={60} value={f.headline} onChange={e => setF({ ...f, headline: e.target.value })} placeholder="Autumn glazes are here" />
      <label className="label" htmlFor="pr-b">A few words (optional)</label><textarea id="pr-b" className="field" rows={3} maxLength={200} value={f.body} onChange={e => setF({ ...f, body: e.target.value })} />
      <label className="label" htmlFor="pr-p">Feature one of your pieces</label><select id="pr-p" className="field" value={f.productId} onChange={e => setF({ ...f, productId: e.target.value })}><option value="">None, just the message</option>{(data?.products ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
      <label className="label" htmlFor="pr-c">Button wording</label><input id="pr-c" className="field" maxLength={24} value={f.ctaLabel} onChange={e => setF({ ...f, ctaLabel: e.target.value })} />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}><div style={{ flex: '1 1 200px' }}><label className="label" htmlFor="pr-s">Starts</label><input id="pr-s" className="field" type="date" value={f.startsOn} onChange={e => setF({ ...f, startsOn: e.target.value })} /></div><div style={{ flex: '1 1 200px' }}><label className="label" htmlFor="pr-e">Ends (optional)</label><input id="pr-e" className="field" type="date" value={f.endsOn} onChange={e => setF({ ...f, endsOn: e.target.value })} /></div></div>
      {err && <div className="err" role="alert">{err}</div>}{saved && <p role="status" className="muted" style={{ marginTop: 12 }}>{saved}</p>}
      <Button style={{ marginTop: 16 }} disabled={busy || !f.headline.trim()} onClick={save}>{p ? 'Save changes' : 'Start promotion'}</Button></div></div>;
}
