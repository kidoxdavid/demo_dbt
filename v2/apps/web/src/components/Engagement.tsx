import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { Button } from './ui';

const ERR: Record<string, string> = { not_delivered_yet: 'You can review it once it has been delivered.', already_reviewed: 'You already reviewed this piece.', not_in_order: 'That piece is not in this order.', too_many_messages: 'You have sent a lot of messages. Please wait a little.', own_shop: 'This is your own shop.', unauthenticated: 'Please sign in first.', feature_off: 'This is switched off right now.' };
export const apiMessage = (e: unknown, fallback = 'Something went wrong. Try again.') => (e instanceof ApiError ? ERR[e.code] ?? (e.status === 429 ? 'Too many tries. Wait a minute.' : fallback) : fallback);

export const RatingStars = ({ n, size = 14 }: { n: number; size?: number }) => <span className="stars" role="img" aria-label={`${n} out of 5 stars`} style={{ fontSize: size }}>{'★'.repeat(Math.round(n))}<span style={{ opacity: 0.25 }}>{'★'.repeat(5 - Math.round(n))}</span></span>;
const when = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });

export interface ReviewData { count: number; avg: number | null; distribution: Record<string, number>; items: { id: string; rating: number; title: string | null; body: string; authorName: string; createdAt: string; reply: { body: string } | null; productTitle?: string }[] }
/** Average, the spread of ratings and the written reviews, with the maker's replies. */
export function ReviewList({ data, onMore, more }: { data: ReviewData; onMore?: () => void; more?: boolean }) {
  if (!data.count) return <p className="muted" style={{ fontSize: 14 }}>No reviews yet. Reviews come from people who received the piece.</p>;
  return <div className="rv"><div className="rv-sum"><div className="serif" style={{ fontSize: 34 }}>{data.avg?.toFixed(1)}</div><div><RatingStars n={data.avg ?? 0} size={16} /><div className="muted" style={{ fontSize: 13 }}>{data.count} review{data.count === 1 ? '' : 's'}</div></div>
    <div className="rv-bars" aria-hidden="true">{[5, 4, 3, 2, 1].map(k => <div key={k}><span>{k}</span><i><b style={{ width: `${(data.distribution[k] / data.count) * 100}%` }} /></i></div>)}</div></div>
    {data.items.map(r => <article key={r.id} className="rv-item"><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><RatingStars n={r.rating} /><b style={{ fontSize: 14 }}>{r.title}</b></div><p>{r.body}</p><div className="muted" style={{ fontSize: 12 }}>{r.authorName} · {when(r.createdAt)}{r.productTitle ? ` · ${r.productTitle}` : ''}</div>
      {r.reply && <div className="rv-reply"><b>Reply from the maker</b><p>{r.reply.body}</p></div>}</article>)}
    {more && onMore && <Button variant="ghost" size="sm" onClick={onMore}>Show more reviews</Button>}</div>;
}

export function ReviewForm({ token, productId, title, onDone }: { token: string; productId: string; title: string; onDone: () => void }) {
  const [rating, setRating] = useState(0); const [head, setHead] = useState(''); const [text, setText] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); setBusy(true); try { await api(`/api/orders/by-token/${token}/reviews`, { method: 'POST', body: { productId, rating, ...(head.trim() ? { title: head.trim() } : {}), body: text.trim() } }); onDone(); } catch (x) { setErr(apiMessage(x)); } finally { setBusy(false); } };
  return <form onSubmit={submit} className="rv-form" noValidate><b style={{ fontSize: 14 }}>Review “{title}”</b>
    <div role="radiogroup" aria-label="Your rating" className="rv-pick">{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>★</button>)}</div>
    <label className="label" htmlFor={`rt-${productId}`}>Headline (optional)</label><input id={`rt-${productId}`} className="field" maxLength={100} value={head} onChange={e => setHead(e.target.value)} />
    <label className="label" htmlFor={`rb-${productId}`}>Your review</label><textarea id={`rb-${productId}`} className="field" rows={4} maxLength={2000} value={text} onChange={e => setText(e.target.value)} />
    {err && <div className="err" role="alert">{err}</div>}<Button type="submit" size="sm" style={{ marginTop: 12 }} disabled={busy || !rating || !text.trim()}>{busy ? 'Posting…' : 'Post review'}</Button></form>;
}

export interface Msg { id: number; sender: 'buyer' | 'seller'; body: string; createdAt: string }
/** A conversation: bubbles on the left for them, on the right for you, and a box to answer. */
export function Conversation({ messages, me, onSend, placeholder }: { messages: Msg[]; me: 'buyer' | 'seller'; onSend: (body: string) => Promise<void>; placeholder?: string }) {
  const [text, setText] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }); }, [messages.length]);
  const send = async (e: FormEvent) => { e.preventDefault(); if (!text.trim()) return; setErr(''); setBusy(true); try { await onSend(text.trim()); setText(''); } catch (x) { setErr(apiMessage(x)); } finally { setBusy(false); } };
  return <div className="chat"><div className="chat-log" role="log" aria-live="polite">{messages.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No messages yet. Say hello.</p>}
    {messages.map(m => <div key={m.id} className={`bubble ${m.sender === me ? 'mine' : 'theirs'}`}><div>{m.body}</div><time className="muted" dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div>)}<div ref={end} /></div>
    <form onSubmit={send} className="chat-box"><label className="sr" htmlFor="chat-in" style={{ position: 'absolute', left: -9999 }}>Your message</label><textarea id="chat-in" className="field" rows={2} maxLength={2000} placeholder={placeholder ?? 'Write a message'} value={text} onChange={e => setText(e.target.value)} />
      <Button type="submit" size="sm" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</Button></form>{err && <div className="err" role="alert">{err}</div>}</div>;
}
