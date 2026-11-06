import { useState } from 'react';
import { api, useApi } from '../api';
import { Button, Chip } from '../components/ui';
import { useConsole } from './ConsoleShell';
import { Page, Rows, fail } from './shared';

const LABEL: Record<string, string> = { pending: 'Waiting', live: 'Live', paused: 'Hidden by maker', rejected: 'Not approved', ended: 'Ended' };
/** Makers' store-page promotions: approve, reject with a reason, or take one down. Works in the admin and marketing windows. */
export function PromotionsQueue() {
  const { area } = useConsole(); const [status, setStatus] = useState(''); const { data, reload } = useApi<any[]>(`/api/${area}/promotions${status ? `?status=${status}` : ''}`);
  const [open, setOpen] = useState<string | null>(null); const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const decide = async (id: string, decision: 'approve' | 'reject') => { setErr(''); setBusy(true); try { await api(`/api/${area}/promotions/${id}/decide`, { method: 'POST', body: { decision, reason: reason.trim() || undefined } }); setOpen(null); setReason(''); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  return <Page title="Store promotions" sub="Banners makers run on their own store page. Check the wording, then approve it or send it back with a reason the maker will see.">
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>{['', 'pending', 'live', 'rejected'].map(s => <Button key={s} size="sm" variant={status === s ? undefined : 'ghost'} onClick={() => setStatus(s)}>{s ? LABEL[s] : 'All'}</Button>)}</div>
    {err && <div className="err" role="alert">{err}</div>}
    <Rows empty="No promotions here.">{(data ?? []).map(r => <div key={r.id} className="tr" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div className="t" style={{ flex: 1, minWidth: 220 }}><b>{r.shop}: {r.headline}</b><div>{r.body || <i>No extra words</i>}</div><div className="muted">{r.productTitle ? `Features “${r.productTitle}”` : 'No featured piece'} · button “{r.ctaLabel}” · {r.startsOn}{r.endsOn ? ` to ${r.endsOn}` : ''} · {r.views} views, {r.clicks} clicks</div>{r.rejectReason && <div className="muted">Reason given: {r.rejectReason}</div>}</div>
      <Chip variant={r.status === 'live' ? 'ok' : 'outline'}>{LABEL[r.status]}</Chip>
      {r.status !== 'ended' && <div style={{ display: 'flex', gap: 8 }}>{r.status !== 'live' && <Button size="sm" disabled={busy} onClick={() => decide(r.id, 'approve')}>Approve</Button>}<Button size="sm" variant="ghost" onClick={() => { setOpen(open === r.id ? null : r.id); setReason(''); }}>{r.status === 'live' ? 'Take down…' : 'Reject…'}</Button></div>}
      {open === r.id && <div style={{ flexBasis: '100%', display: 'flex', gap: 10 }}><input className="field" aria-label="Reason" placeholder="Reason (the maker sees it)" value={reason} onChange={e => setReason(e.target.value)} /><Button size="sm" disabled={busy || !reason.trim()} onClick={() => decide(r.id, 'reject')}>Send</Button></div>}
    </div>)}</Rows></Page>;
}
