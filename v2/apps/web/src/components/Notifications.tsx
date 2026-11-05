import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useApi } from '../api';
import { Button } from './ui';

type Area = 'me' | 'studio';
interface Item { id: number; kind: string; title: string; body: string; url: string | null; read: boolean; createdAt: string }
interface Prefs { email: string; categories: { key: string; label: string; description: string; transactional: boolean; email: boolean; push: boolean }[]; push: { configured: boolean; devices: number } }
const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'Just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); };
const b64 = (s: string) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };

/** How many things are waiting. Polls gently while the tab is open and again when you come back to it. */
export function useUnread(area: Area, enabled: boolean) {
  const [n, setN] = useState(0); const load = useCallback(() => { if (enabled) api<{ unread: number }>(`/api/${area}/notifications/unread-count`).then(r => setN(r.unread), () => {}); }, [area, enabled]);
  useEffect(() => { load(); if (!enabled) return; const t = setInterval(load, 60_000); const v = () => document.visibilityState === 'visible' && load(); document.addEventListener('visibilitychange', v); return () => { clearInterval(t); document.removeEventListener('visibilitychange', v); }; }, [load, enabled]);
  return [n, setN, load] as const;
}

/** Push on this device: ask permission, register the service worker, subscribe with the server's public key, tell the server. */
function PushControl({ area, prefs, reload, onTest }: { area: Area; prefs: Prefs; reload: () => void; onTest: () => void }) {
  const [here, setHere] = useState<boolean | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  useEffect(() => { if (!supported) return; navigator.serviceWorker.getRegistration('/').then(r => r?.pushManager.getSubscription()).then(s => setHere(!!s), () => setHere(false)); }, [supported, prefs.push.devices]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(''); try { await fn(); reload(); } catch (e: any) { setMsg(e?.message === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser settings and try again.' : e?.code === 'no_device' ? 'Turn push on for this device first.' : 'Could not do that. Try again.'); } finally { setBusy(false); } };
  const on = () => run(async () => {
    const key = (await api<{ publicKey: string | null }>('/api/push/key')).publicKey; if (!key) throw new Error('unconfigured'); const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied'); const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) })); const j = sub.toJSON();
    await api(`/api/${area}/push`, { method: 'POST', body: { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } } }); setHere(true); });
  const off = () => run(async () => { const reg = await navigator.serviceWorker.getRegistration('/'); const sub = await reg?.pushManager.getSubscription(); if (sub) { await api(`/api/${area}/push`, { method: 'DELETE', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); } setHere(false); });
  const test = () => run(async () => { await api(`/api/${area}/push/test`, { method: 'POST' }); setMsg('Sent. It should arrive in a moment.'); onTest(); });
  return <div className="card" style={{ padding: '14px 16px', marginTop: 14 }}><b>Push notifications</b>
    <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>{!supported ? 'This browser cannot receive push notifications. On an iPhone, add eazystores to your Home Screen first.' : !prefs.push.configured ? 'Push is not set up on this server yet, so only the inbox and email work for now.' : here ? `On for this device (${prefs.push.devices} device${prefs.push.devices === 1 ? '' : 's'} in total).` : 'Get a nudge on this device when something needs you.'}</p>
    {supported && prefs.push.configured && <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>{here ? <><Button size="sm" variant="ghost" disabled={busy} onClick={test}>Send me a test</Button><Button size="sm" variant="ghost" disabled={busy} onClick={off}>Turn off on this device</Button></> : <Button size="sm" disabled={busy || here === null} onClick={on}>Turn on for this device</Button>}</div>}
    {msg && <div className="saved" role="status" aria-live="polite" style={{ marginTop: 8 }}>{msg}</div>}</div>;
}

export function NotificationsView({ area }: { area: Area }) {
  const nav = useNavigate(); const [tab, setTab] = useState<'inbox' | 'settings'>('inbox'); const { data, reload } = useApi<{ unread: number; items: Item[] }>(`/api/${area}/notifications`); const { data: prefs, reload: reloadPrefs } = useApi<Prefs>(`/api/${area}/notification-prefs`); const [err, setErr] = useState(''); const [over, setOver] = useState<Record<string, { email?: boolean; push?: boolean }>>({});
  const open = async (n: Item) => { if (!n.read) await api(`/api/${area}/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {}); if (n.url) nav(n.url); else reload(); };
  const readAll = async () => { await api(`/api/${area}/notifications/read-all`, { method: 'POST' }); reload(); };
  const set = async (category: string, patch: { email?: boolean; push?: boolean }) => { setErr(''); setOver(o => ({ ...o, [category]: { ...o[category], ...patch } }));          // shows at once, rolls back if it cannot be saved
    try { await api(`/api/${area}/notification-prefs`, { method: 'PUT', body: { category, ...patch } }); reloadPrefs(); } catch { setOver(o => { const { [category]: _drop, ...rest } = o; return rest; }); setErr('Could not save that. Try again.'); } };
  return <div className={area === 'studio' ? 'sd-page' : 'co'}><h1 className="serif" style={{ fontSize: area === 'studio' ? 34 : 30 }}>Notifications</h1>
    <div className="seg" role="tablist">{(['inbox', 'settings'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'inbox' ? `Inbox${data?.unread ? ` (${data.unread})` : ''}` : 'Settings'}</button>)}</div>
    {tab === 'inbox' && (data?.items.length === 0 ? <div className="empty"><h2 className="serif">Nothing yet</h2><p>Order updates, messages and reviews will show up here.</p></div> : <><div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>{!!data?.unread && <Button size="sm" variant="ghost" onClick={readAll}>Mark all as read</Button>}</div>
      <div className="card" style={{ marginTop: 8, padding: '2px 16px' }}>{(data?.items ?? []).map(n => <button key={n.id} type="button" className="thread-row" style={{ width: '100%', textAlign: 'left' }} onClick={() => open(n)}><div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 14, fontWeight: n.read ? 500 : 700 }}>{n.title}</b>{n.body && <div className="muted" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</div>}</div><span className="muted" style={{ fontSize: 12 }}>{ago(n.createdAt)}</span>{!n.read && <i className="dot" aria-label="Unread" />}</button>)}</div></>)}
    {tab === 'settings' && prefs && <><p className="muted" style={{ fontSize: 13, marginTop: 10 }}>Emails go to {prefs.email}.</p>
      {prefs.categories.map(c0 => { const c = { ...c0, ...over[c0.key] }; return <div key={c.key} className="card" style={{ padding: '14px 16px', marginTop: 12 }}><b>{c.label}</b><div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{c.description}</div>
        <label className="tgl"><input type="checkbox" checked={c.email} disabled={c.transactional} onChange={e => set(c.key, { email: e.target.checked })} />Email{c.transactional ? ' (always on)' : ''}</label>
        <label className="tgl"><input type="checkbox" checked={c.push} onChange={e => set(c.key, { push: e.target.checked })} />Push on my devices</label></div>; })}
      <PushControl area={area} prefs={prefs} reload={reloadPrefs} onTest={reload} />{err && <div className="err" role="alert">{err}</div>}</>}</div>;
}
