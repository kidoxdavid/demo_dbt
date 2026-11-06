import { useFlag } from '../flags';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, useApi } from '../api';
import { Button } from '../components/ui';
import { dateRange, money } from '../format';
import { useSession } from '../session';

const ERRORS: Record<string, string> = { invalid_credentials: 'That email and password do not match.', email_in_use: 'There is already an account with that email. Try signing in.', account_locked: 'Too many tries. Wait a few minutes and try again.' };
const nextPath = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/account');

const DELETE_ERR: Record<string, string> = { wrong_password: 'That password is not right.', open_orders: 'You have an order that has not arrived yet. You can delete your account once it has.', has_roles: 'This account runs a shop or has staff access. Ask us to close that first.' };
/** Your data: download everything we hold, or delete the account (personal details go; sales records stay without your name, email or address). */
function DataControls() {
  const { signOut } = useSession(); const [open, setOpen] = useState(false); const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const del = async () => { setErr(''); setBusy(true); try { await api('/api/me', { method: 'DELETE', body: { password: pw } }); await signOut().catch(() => {}); location.assign('/'); } catch (e) { setErr(e instanceof ApiError ? DELETE_ERR[e.code] ?? 'That did not work. Try again.' : 'That did not work. Try again.'); } finally { setBusy(false); } };
  return <div className="card sec" style={{ marginTop: 28 }}><b>Your data</b><p className="muted" style={{ fontSize: 13, marginTop: 4 }}>Download everything we hold about you, or delete your account. Records of past sales are kept for tax, without your name, email or street address.</p>
    <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}><a className="btn ghost sm" href="/api/me/export" download>Download my data</a><Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>Delete my account</Button></div>
    {open && <div style={{ marginTop: 12 }}><label className="label" htmlFor="del-pw">Enter your password to confirm. This cannot be undone.</label><input id="del-pw" className="field" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />{err && <div className="err" role="alert">{err}</div>}<Button size="sm" style={{ marginTop: 12 }} disabled={busy || !pw} onClick={del}>{busy ? 'Deleting…' : 'Delete everything now'}</Button></div>}</div>;
}

/** Buyer account: sign in or create one (the shop window), then your orders. */
export function AccountPage() {
  const { user, ready, signIn, signUp, signOut } = useSession(); const nav = useNavigate(); const [sp] = useSearchParams(); const [mode, setMode] = useState<'in' | 'up'>('in');
  const [f, setF] = useState({ email: '', password: '', name: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const orders = useApi<any[]>(user ? '/api/orders' : null);
  const next = nextPath(sp.get('next'));
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); setBusy(true);
    try { mode === 'in' ? await signIn(f.email.trim(), f.password) : await signUp(f.email.trim(), f.password, f.name.trim()); if (next !== '/account') nav(next, { replace: true }); }
    catch (x) { setErr(x instanceof ApiError ? ERRORS[x.code] ?? (x.code.startsWith('weak_password') ? 'Choose a longer, less common password (at least 10 characters).' : x.status === 429 ? 'Too many tries. Wait a minute.' : 'Please check your details.') : 'Something went wrong.'); } finally { setBusy(false); } };
  if (!ready) return <div className="pad" style={{ paddingTop: 40 }}><div className="skeleton" style={{ height: 200 }} /></div>;
  if (user) return <div className="screen pad" style={{ paddingTop: 10 }}><div className="co"><h1 className="serif">Hello, {user.fullName.split(' ')[0]}</h1><p className="muted" style={{ marginTop: 4 }}>{user.email}</p>
    <Link to="/account/messages" className="card sec" style={{ display: 'block', marginTop: 18 }}><b>Messages</b><div className="muted" style={{ fontSize: 13, marginTop: 2 }}>Conversations with makers</div></Link>
    <Link to="/account/notifications" className="card sec" style={{ display: 'block', marginTop: 10 }}><b>Notifications</b><div className="muted" style={{ fontSize: 13, marginTop: 2 }}>Your inbox, email and push settings</div></Link>
    <h2 className="serif" style={{ fontSize: 20, marginTop: 24 }}>Your orders</h2>
    {orders.data?.length === 0 && <p className="muted" style={{ marginTop: 8 }}>No orders yet.</p>}
    {(orders.data ?? []).map(o => <Link key={o.id} to={`/orders/${o.token}`} className="card sec" style={{ display: 'block', marginTop: 10 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Order #{o.number}</b><b>{money(o.totalCents)}</b></div><div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{o.sellers.map((s: any) => s.shop.name).join(', ')} · {o.paymentStatus.replace('_', ' ')}{o.sellers[0]?.eta?.min ? ` · arrives ${dateRange(o.sellers[0].eta.min, o.sellers[0].eta.max)}` : ''}</div></Link>)}
    <Button variant="ghost" block style={{ marginTop: 24 }} onClick={() => signOut()}>Sign out</Button>
    <DataControls /></div></div>;
  return <div className="screen pad" style={{ paddingTop: 10 }}><div className="co"><h1 className="serif">{mode === 'in' ? 'Sign in' : 'Create your account'}</h1>
    <form onSubmit={submit} noValidate>{mode === 'up' && <><label className="label" htmlFor="ac-name">Your name</label><input id="ac-name" className="field" autoComplete="name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></>}
      <label className="label" htmlFor="ac-email">Email</label><input id="ac-email" className="field" type="email" autoComplete="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required />
      <label className="label" htmlFor="ac-pw">Password</label><input id="ac-pw" className="field" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required />
      {err && <div className="err" role="alert">{err}</div>}<Button type="submit" block style={{ marginTop: 18 }} disabled={busy}>{busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}</Button></form>
    <SignupGate mode={mode}><p className="muted" style={{ fontSize: 14, textAlign: 'center', marginTop: 16 }}>{mode === 'in' ? 'New here?' : 'Already have an account?'} <button style={{ textDecoration: 'underline', color: 'var(--ink)' }} onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(''); }}>{mode === 'in' ? 'Create an account' : 'Sign in'}</button></p></SignupGate></div></div>;
}
/** The "create an account" link, hidden while the admin has closed buyer sign-ups. */
function SignupGate({ mode, children }: { mode: string; children: React.ReactNode }) { const on = useFlag('buyer_signups'); return mode === 'in' && !on ? null : <>{children}</>; }
