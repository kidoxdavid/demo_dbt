import { Link, useParams } from 'react-router-dom';
import { api, useApi } from '../api';
import { Conversation, type Msg } from '../components/Engagement';
import { useDesktop } from '../hooks';
import { useSession } from '../session';

const ago = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
/** The buyer's conversations with makers. Order chats (also reachable from the order page) and questions about pieces show up here. */
export function MyMessages() {
  const { user, ready } = useSession(); const desktop = useDesktop(); const { data } = useApi<any[]>(user ? '/api/me/threads' : null);
  return <div className={desktop ? 'dpad' : 'screen'}><div className={desktop ? 'co' : 'pad co'} style={{ paddingTop: 6 }}><Link to="/account" className="crumbs">‹ Account</Link><h1 className="serif" style={{ fontSize: 30, marginTop: 6 }}>Messages</h1>
    {ready && !user ? <div className="empty"><h2 className="serif">Sign in to see your messages</h2><Link to="/account?next=/account/messages" className="btn" style={{ marginTop: 16 }}>Sign in</Link></div>
      : data && data.length === 0 ? <div className="empty"><h2 className="serif">No messages yet</h2><p>Ask a maker a question from any product page, or message them from an order.</p></div>
      : <div className="card" style={{ marginTop: 14, padding: '2px 16px' }}>{(data ?? []).map(t => <Link key={t.id} to={`/account/messages/${t.id}`} className="thread-row"><div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 14 }}>{t.shop.name}</b>{t.about && <span className="muted" style={{ fontSize: 12 }}> · {t.about}</span>}<div className="muted" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.lastSender === 'buyer' ? 'You: ' : ''}{t.lastMessage}</div></div><span className="muted" style={{ fontSize: 12 }}>{ago(t.lastAt)}</span>{t.unread && <i className="dot" aria-label="Unread" />}</Link>)}</div>}</div></div>;
}
export function MyThread() {
  const { id = '' } = useParams(); const desktop = useDesktop(); const { data, reload, error } = useApi<any>(`/api/me/threads/${id}`);
  if (error) return <div className="empty"><h2 className="serif">We could not find that conversation</h2><Link to="/account/messages" className="btn" style={{ marginTop: 16 }}>Back to messages</Link></div>; if (!data) return <div className="pad" style={{ paddingTop: 30 }}><div className="skeleton" style={{ height: 200 }} /></div>;
  return <div className={desktop ? 'dpad' : 'screen'}><div className={desktop ? 'co' : 'pad co'} style={{ paddingTop: 6 }}><Link to="/account/messages" className="crumbs">‹ Messages</Link><h1 className="serif" style={{ fontSize: 26, marginTop: 6 }}><Link to={`/shop/${data.shop.slug}`}>{data.shop.name}</Link></h1>{data.about && <div className="muted" style={{ fontSize: 13 }}>{data.productId ? <Link to={`/p/${data.productId}`} style={{ textDecoration: 'underline' }}>{data.about}</Link> : data.about}</div>}
    <div className="card" style={{ marginTop: 14, padding: 16 }}><Conversation messages={data.messages as Msg[]} me="buyer" onSend={async body => { await api(`/api/me/threads/${id}/messages`, { method: 'POST', body: { body } }); reload(); }} /></div></div></div>;
}
