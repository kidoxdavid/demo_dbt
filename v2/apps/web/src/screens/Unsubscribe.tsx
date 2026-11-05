import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApi } from '../api';
import { Button } from '../components/ui';

/** The page an email's "Unsubscribe" link opens. It works without signing in; the link itself is the proof. */
export function Unsubscribe() {
  const [sp] = useSearchParams(); const token = sp.get('t') ?? ''; const { data, error } = useApi<{ category: string; label: string }>(token ? `/api/unsubscribe/${encodeURIComponent(token)}` : null); const [done, setDone] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); setErr(''); try { await api('/api/unsubscribe', { method: 'POST', body: { token } }); setDone(true); } catch { setErr('That did not work. Try again, or change it in your account settings.'); } finally { setBusy(false); } };
  return <div className="screen pad" style={{ paddingTop: 60 }}><div className="co" style={{ textAlign: 'center' }}>
    {!token || error ? <><h1 className="serif">This link does not work</h1><p className="muted" style={{ marginTop: 8 }}>It may be damaged or out of date. You can change your emails any time in your account.</p><Link to="/account/notifications" className="btn" style={{ marginTop: 18 }}>Notification settings</Link></>
      : done ? <><h1 className="serif">You are unsubscribed</h1><p className="muted" style={{ marginTop: 8 }}>You will no longer get {data?.label.toLowerCase()} emails. Receipts and updates about your orders still arrive.</p><Link to="/" className="btn ghost" style={{ marginTop: 18 }}>Back to the shop</Link></>
      : data ? <><h1 className="serif">Stop {data.label.toLowerCase()} emails?</h1><p className="muted" style={{ marginTop: 8 }}>Emails about your orders will keep coming.</p>{err && <div className="err" role="alert">{err}</div>}<Button style={{ marginTop: 18 }} disabled={busy} onClick={go}>{busy ? 'One moment…' : 'Unsubscribe'}</Button></>
      : <div className="skeleton" style={{ height: 120 }} />}</div></div>;
}
