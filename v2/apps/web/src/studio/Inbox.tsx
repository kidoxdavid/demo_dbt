import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useApi } from '../api';
import { Conversation, RatingStars, apiMessage, type Msg } from '../components/Engagement';
import { Button, Chip } from '../components/ui';
import { useDesktop } from '../hooks';
import { ago } from './Dashboard';
import { useStudio } from './StudioShell';

const wrap = (desktop: boolean) => ({ className: `sd-page${desktop ? '' : ' pad'}`, style: desktop ? undefined : { paddingTop: 10 } });

/** Buyer conversations about orders and pieces. Unanswered ones come first in the count on the studio home. */
export function Inbox() {
  const desktop = useDesktop(); const [unread, setUnread] = useState(false); const { data } = useApi<{ unread: number; items: any[] }>(`/api/studio/threads${unread ? '?unread=true' : ''}`); const now = new Date();
  return <div {...wrap(desktop)}><h1 className="serif">Messages</h1><div className="sub">{data ? `${data.unread} waiting for your reply` : ' '}</div>
    <div className="seg" role="tablist">{[[false, 'All'], [true, 'Unread']].map(([v, l]) => <button key={String(l)} role="tab" aria-selected={unread === v} className={unread === v ? 'on' : ''} onClick={() => setUnread(v as boolean)}>{l as string}</button>)}</div>
    {data?.items.length === 0 ? <div className="empty"><h2 className="serif">{unread ? 'Nothing is waiting' : 'No messages yet'}</h2><p>Buyers can message you from an order or from a product page. We email you when they do.</p></div>
      : <div className="card table">{(data?.items ?? []).map(t => <Link key={t.id} to={`/studio/messages/${t.id}`} className="tr"><div className="t"><b>{t.buyerName}{t.about ? ` · ${t.about}` : ''}</b><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.lastSender === 'seller' ? 'You: ' : ''}{t.lastMessage}</div></div><span className="muted" style={{ fontSize: 12 }}>{ago(t.lastAt, now)}</span>{t.unread && <Chip>Reply</Chip>}</Link>)}</div>}</div>;
}
export function InboxThread() {
  const { id = '' } = useParams(); const desktop = useDesktop(); const { refresh } = useStudio(); const { data, reload, error } = useApi<any>(`/api/studio/threads/${id}`);
  if (error) return <div className="empty"><h2 className="serif">We could not find that conversation</h2><Link to="/studio/messages" className="btn" style={{ marginTop: 16 }}>Back to messages</Link></div>; if (!data) return <div className="pad" style={{ paddingTop: 30 }}><div className="skeleton" style={{ height: 200 }} /></div>;
  return <div {...wrap(desktop)}><Link to="/studio/messages" className="crumbs">‹ Messages</Link><h1 className="serif" style={{ fontSize: 28, marginTop: 6 }}>{data.buyerName}</h1>
    <div className="sub">{data.productId ? <Link to={`/p/${data.productId}`} style={{ textDecoration: 'underline' }}>{data.about}</Link> : data.sellerOrderId ? <Link to={`/studio/orders/${data.sellerOrderId}`} style={{ textDecoration: 'underline' }}>{data.about}</Link> : data.about}</div>
    <div className="card sd-card" style={{ marginTop: 16, maxWidth: 640 }}><Conversation messages={data.messages as Msg[]} me="seller" placeholder="Write a reply" onSend={async body => { await api(`/api/studio/threads/${id}/messages`, { method: 'POST', body: { body } }); reload(); void refresh(); }} /></div></div>;
}

/** Reviews of your pieces: reply once in public, or report one that breaks the rules (staff decide). */
export function StudioReviews() {
  const desktop = useDesktop(); const [open, setOpen] = useState(false); const { data, reload } = useApi<{ total: number; items: any[] }>(`/api/studio/reviews?limit=50${open ? '&unanswered=true' : ''}`); const [reply, setReply] = useState<{ id: string; kind: 'reply' | 'report' } | null>(null); const [text, setText] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const send = async () => { if (!reply) return; setErr(''); setBusy(true); try { await api(`/api/studio/reviews/${reply.id}/${reply.kind}`, { method: 'POST', body: reply.kind === 'reply' ? { body: text.trim() } : { reason: text.trim() } }); setReply(null); setText(''); reload(); } catch (e) { setErr(apiMessage(e, reply.kind === 'report' ? 'That review cannot be reported again.' : undefined)); } finally { setBusy(false); } };
  return <div {...wrap(desktop)}><h1 className="serif">Reviews</h1><div className="sub">Only people who received a piece can review it. You can reply once, in public.</div>
    <div className="seg" role="tablist">{[[false, 'All'], [true, 'Needs a reply']].map(([v, l]) => <button key={String(l)} role="tab" aria-selected={open === v} className={open === v ? 'on' : ''} onClick={() => setOpen(v as boolean)}>{l as string}</button>)}</div>
    {data?.items.length === 0 ? <div className="empty"><h2 className="serif">No reviews here yet</h2><p>We ask buyers for a review when you mark an order delivered.</p></div>
      : <div className="card table">{(data?.items ?? []).map(r => <div key={r.id} className="tr" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}><div className="t"><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><RatingStars n={r.rating} /><b>{r.title}</b>{r.status === 'hidden' && <Chip variant="outline">Hidden by staff</Chip>}{r.reported && <Chip variant="outline">Reported</Chip>}</div>
        <div style={{ color: 'var(--ink)', fontSize: 14, margin: '4px 0' }}>{r.body}</div><div>{r.authorName} · {r.productTitle}</div>{r.reply && <div className="rv-reply"><b>Your reply</b><p>{r.reply.body}</p></div>}</div>
        {r.status === 'published' && <div style={{ display: 'flex', gap: 8 }}>{!r.reply && <Button size="sm" variant="ghost" onClick={() => { setReply({ id: r.id, kind: 'reply' }); setText(''); setErr(''); }}>Reply</Button>}{!r.reported && r.reportStatus !== 'kept' && <Button size="sm" variant="ghost" onClick={() => { setReply({ id: r.id, kind: 'report' }); setText(''); setErr(''); }}>Report</Button>}</div>}
        {reply && reply.id === r.id && <div style={{ flexBasis: '100%' }}><label className="label" htmlFor="rv-text">{reply.kind === 'reply' ? 'Your public reply' : 'Why does this break the rules? Staff will read this.'}</label><textarea id="rv-text" className="field" rows={3} maxLength={reply.kind === 'reply' ? 1000 : 500} value={text} onChange={e => setText(e.target.value)} />{err && <div className="err" role="alert">{err}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}><Button size="sm" disabled={busy || text.trim().length < (reply.kind === 'report' ? 5 : 1)} onClick={send}>{reply.kind === 'reply' ? 'Post reply' : 'Send report'}</Button><Button size="sm" variant="ghost" onClick={() => setReply(null)}>Cancel</Button></div></div>}</div>)}</div>}</div>;
}
