import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorText } from '../api';
import { Alert, Field } from '../ui';
import { usePub } from './Store';

export const Header = () => (
  <header className="ptop"><div className="wrap pbar">
    <Link to="/" className="plogo">Eazy<i>Stores</i></Link>
    <nav className="pnav" aria-label="Sections"><Link to="/">Browse the marketplace</Link><Link to="/sell">Sell with us</Link></nav>
    <div className="pright"><Link className="plink" to="/login">Log in</Link><Link className="btn sm" to="/signup">Open a store</Link></div>
  </div></header>
);

export function Landing() {
  usePub();
  const steps = [['01', 'Add what you make', 'Upload photos and prices one at a time, or bring a whole spreadsheet. We check every row before anything goes live.'],
    ['02', 'Share one link', 'Your store has its own address that works on Instagram, WhatsApp and in person. Shoppers can also discover you in the marketplace.'],
    ['03', 'Know what you earn', 'Sales, costs, fees and profit are kept apart, so you can see whether the business is really making money.']];
  return <>
    <Header />
    <section className="lhero"><div className="wrap lhero-grid">
      <div>
        <span className="kicker">For independent sellers</span>
        <h1>A considered home for your brand.</h1>
        <p className="lede">A beautiful storefront, simple stock control and honest numbers, without the technical work. Free to start.</p>
        <div className="row" style={{ marginTop: 28 }}><Link className="btn" to="/signup">Open your store</Link><Link className="cta-link" to="/">See the marketplace <span aria-hidden>→</span></Link></div>
      </div>
      <div className="lmock" aria-hidden="true">
        <div className="lmock-bar"><i /><i /><i /><span>eazystores.ca/store/your-brand</span></div>
        <div className="lmock-body">
          <div className="lt a"><span>Oud Noir<b>$85</b></span></div><div className="lt b"><span>Rose Water<b>$65</b></span></div><div className="lt c"><span>Amber Candle<b>$32</b></span></div>
        </div>
        <div className="lfloat"><small>This month</small><b>$4,280</b><small>Gross profit $1,940</small></div>
      </div>
    </div></section>
    <main className="wrap">
      <section className="band2"><div className="band2-head"><h2>How it works</h2></div>
        <ol className="steps">{steps.map(([n, t, d]) => <li key={n}><span className="num">{n}</span><h3>{t}</h3><p>{d}</p></li>)}</ol></section>
      <section className="lcta"><h2>Open your store today.</h2><p>It takes a few minutes and costs nothing to start.</p><Link className="btn" to="/signup">Get started</Link></section>
    </main>
    <footer className="pfoot"><div className="wrap pfoot-grid"><div><div className="plogo">Eazy<i>Stores</i></div><p className="muted small">A home for independent brands.</p></div>
      <div className="small"><b>Shoppers</b><br /><Link to="/">Browse the marketplace</Link></div><div className="small muted">Development build. Payments are simulated.</div></div></footer>
  </>;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function Signup() {
  usePub();
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
      <span className="kicker" style={{ marginTop: 44 }}>Open a store</span><h1 style={{ margin: '12px 0 8px' }}>Create your store</h1><p className="muted" style={{ marginTop: 0 }}>Free to start. You can change everything later.</p>
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
  usePub();
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
      <span className="kicker" style={{ marginTop: 44 }}>Sellers</span><h1 style={{ margin: '12px 0 8px' }}>Welcome back</h1>
      <form className="card" onSubmit={submit}>
        {err && <Alert kind="err">{err}</Alert>}
        <Field label="Email">{id => <input id={id} type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />}</Field>
        <Field label="Password">{id => <input id={id} type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />}</Field>
        <p><button disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button></p>
      </form>
    </main>
  </>;
}
