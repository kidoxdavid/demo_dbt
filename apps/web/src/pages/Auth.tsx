import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorText } from '../api';
import { Alert, Field } from '../ui';

export const Header = () => (
  <header className="top"><div className="wrap">
    <Link to="/" className="logo">Eazy<b>Stores</b></Link>
    <div className="row"><Link to="/login">Log in</Link><Link className="btn" to="/signup">Start selling</Link></div>
  </div></header>
);

export function Landing() {
  return <>
    <Header />
    <main className="wrap hero">
      <h1>Open your online store in minutes.</h1>
      <p>Add your products, share one link, and get paid. Track what you actually earn after costs and fees. No technical skills needed.</p>
      <div className="row"><Link className="btn" to="/signup">Create your free store</Link></div>
    </main>
  </>;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function Signup() {
  const nav = useNavigate();
  const [f, setF] = useState({ fullName: '', email: '', password: '', businessName: '', storeSlug: '', legalType: 'individual' });
  const [slugTouched, setTouched] = useState(false);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v, ...(k === 'businessName' && !slugTouched ? { storeSlug: slugify(v) } : {}) }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/api/auth/signup', { body: f }); nav('/dashboard'); }
    catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return <>
    <Header />
    <main className="wrap" style={{ maxWidth: 520 }}>
      <h1>Create your store</h1>
      <form className="card" onSubmit={submit}>
        {err && <Alert kind="err">{err}</Alert>}
        <Field label="Your name">{id => <input id={id} required autoComplete="name" value={f.fullName} onChange={e => set('fullName', e.target.value)} />}</Field>
        <Field label="Email">{id => <input id={id} type="email" required autoComplete="email" value={f.email} onChange={e => set('email', e.target.value)} />}</Field>
        <Field label="Password" hint="At least 10 characters.">{id => <input id={id} type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={e => set('password', e.target.value)} />}</Field>
        <Field label="Business name">{id => <input id={id} required value={f.businessName} onChange={e => set('businessName', e.target.value)} />}</Field>
        <Field label="Store address" hint={`Your store will live at /store/${f.storeSlug || 'your-name'}`}>
          {id => <input id={id} required pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" title="3-40 characters: lowercase letters, numbers, hyphens" value={f.storeSlug}
            onChange={e => { setTouched(true); set('storeSlug', e.target.value.toLowerCase()); }} />}
        </Field>
        <Field label="Type of seller">{id => (
          <select id={id} value={f.legalType} onChange={e => set('legalType', e.target.value)}>
            <option value="individual">Individual</option><option value="sole_proprietorship">Sole proprietorship</option>
            <option value="registered_business">Registered business</option><option value="partnership">Partnership</option><option value="creator">Independent creator</option>
          </select>)}</Field>
        <p><button disabled={busy}>{busy ? 'Creating…' : 'Create store'}</button></p>
        <p className="muted small">Already have an account? <Link to="/login">Log in</Link></p>
      </form>
    </main>
  </>;
}

export function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/api/auth/login', { body: { email, password } }); nav('/dashboard'); }
    catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return <>
    <Header />
    <main className="wrap" style={{ maxWidth: 520 }}>
      <h1>Log in</h1>
      <form className="card" onSubmit={submit}>
        {err && <Alert kind="err">{err}</Alert>}
        <Field label="Email">{id => <input id={id} type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />}</Field>
        <Field label="Password">{id => <input id={id} type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />}</Field>
        <p><button disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button></p>
      </form>
    </main>
  </>;
}
