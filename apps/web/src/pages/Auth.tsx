import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorText } from '../api';
import { Alert, Field } from '../ui';
import { IcoBox, IcoChart, IcoTag } from '../icons';

export const Header = () => (
  <header className="top"><div className="wrap">
    <Link to="/" className="logo">Eazy<b>Stores</b></Link>
    <div className="row"><Link className="btn ghost sm" to="/login">Log in</Link><Link className="btn sm" to="/signup">Start selling</Link></div>
  </div></header>
);

export function Landing() {
  return <>
    <Header />
    <section className="hero"><div className="wrap">
      <div className="eyebrow">Free to start · No technical skills needed</div>
      <h1>Sell online like the big brands.</h1>
      <p className="lead">Launch a beautiful store in minutes, share one link anywhere, and see what you really earn after costs and fees.</p>
      <div className="row"><Link className="btn lg" to="/signup">Create your store</Link><Link className="btn secondary lg" to="/login">Log in</Link></div>
      <div className="mock" aria-hidden="true">
        <div className="frame">
          <div className="bar"><i /><i /><i /><span className="url">eazystores.ca/store/your-brand</span></div>
          <div className="body">
            <div><div className="tile a"><span><b>Oud Noir</b><b>$80</b></span></div></div>
            <div><div className="tile b"><span><b>Rose Water</b><b>$25</b></span></div></div>
            <div><div className="tile c"><span><b>Amber Candle</b><b>$32</b></span></div></div>
          </div>
        </div>
        <div className="float"><small>This month</small><b>$4,280</b><small>Gross profit · $1,940</small></div>
      </div>
    </div></section>
    <main className="wrap">
      <div className="band"><h2>Everything you need to run your business.</h2><p className="sub">One simple place to sell, manage stock and understand your numbers.</p></div>
      <div className="features">
        {[['A store that looks the part', 'Clean, fast, mobile-first pages that put your products and photos front and centre.', <IcoTag key="a" />],
          ['Never oversell', 'Stock is held while a customer checks out, so you never promise what you do not have.', <IcoBox key="b" />],
          ['Know what you earn', 'Sales, costs, fees and profit kept apart, so you can tell if you are really making money.', <IcoChart key="c" />]]
          .map(([t, d, i]) => <article className="card feature" key={t as string}><div className="ico">{i}</div><h3>{t}</h3><p>{d}</p></article>)}
      </div>
      <section className="cta"><h2>Open your store today.</h2><p>It takes a few minutes and costs nothing to start.</p><Link className="btn lg" to="/signup">Get started free</Link></section>
    </main>
    <footer className="footer"><div className="wrap">© EazyStores · Development build: payments are simulated.</div></footer>
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
      <h1 style={{ marginTop: 40 }}>Create your store</h1><p className="muted" style={{ marginTop: -6 }}>Free to start. You can change everything later.</p>
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
      <h1 style={{ marginTop: 40 }}>Welcome back</h1>
      <form className="card" onSubmit={submit}>
        {err && <Alert kind="err">{err}</Alert>}
        <Field label="Email">{id => <input id={id} type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />}</Field>
        <Field label="Password">{id => <input id={id} type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />}</Field>
        <p><button disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button></p>
      </form>
    </main>
  </>;
}
