import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { Alert, Field } from '../ui';

/** Two-factor sign-in: set up an authenticator app, save recovery codes, or turn it off (not allowed for staff). */
export function SecurityPanel({ required = false, onChange }: { required?: boolean; onChange?: () => void }) {
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesLeft: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState(''); const [codes, setCodes] = useState<string[] | null>(null); const [saved, setSaved] = useState(false);
  const [pw, setPw] = useState(''); const [dcode, setDcode] = useState(''); const [disabling, setDisabling] = useState(false);
  const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api('/api/auth/mfa/status').then(setStatus).catch(e => setMsg({ k: 'err', t: errorText(e) })), []);
  useEffect(() => { load(); }, [load]);

  async function start() { setBusy(true); setMsg(null); try { setSetup(await api('/api/auth/mfa/setup', { method: 'POST', body: {} })); } catch (e) { setMsg({ k: 'err', t: errorText(e) }); } finally { setBusy(false); } }
  async function enable(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { const r = await api('/api/auth/mfa/enable', { body: { code } }); setCodes(r.recoveryCodes); setSetup(null); setCode(''); load(); }
    catch (x) { setMsg({ k: 'err', t: errorText(x) }); } finally { setBusy(false); }
  }
  async function disable(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { await api('/api/auth/mfa/disable', { body: { password: pw, code: dcode } }); setDisabling(false); setPw(''); setDcode(''); setMsg({ k: 'ok', t: 'Two-factor sign-in is off.' }); load(); onChange?.(); }
    catch (x) { setMsg({ k: 'err', t: errorText(x) }); } finally { setBusy(false); }
  }
  function done() { setCodes(null); setSaved(false); onChange?.(); }

  if (!status) return <p className="muted">Loading…</p>;
  if (codes) return <section className="card">
    <h3>Save your recovery codes</h3>
    <Alert kind="warn">Each code works once if you lose your phone. They are shown only now. Store them somewhere safe, such as a password manager.</Alert>
    <ul className="codes" aria-label="Recovery codes">{codes.map(c => <li key={c}><code>{c}</code></li>)}</ul>
    <div className="row"><button className="secondary" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Copy codes</button></div>
    <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />I have saved these codes</label>
    <p><button disabled={!saved} onClick={done}>Continue</button></p>
  </section>;

  return <section className="card">
    <div className="row spread"><h3 style={{ margin: 0 }}>Two-factor sign-in</h3><span className={`badge ${status.enabled ? 'active' : 'draft'}`}>{status.enabled ? 'On' : 'Off'}</span></div>
    <p className="muted small">{required ? 'Required for EazyStores staff. ' : ''}A 6-digit code from an authenticator app is needed on top of your password, which protects the account if the password leaks.</p>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    {!status.enabled && !setup && <p><button onClick={start} disabled={busy}>Set up two-factor</button></p>}
    {setup && <form onSubmit={enable}>
      <ol className="small" style={{ paddingLeft: 18, lineHeight: 1.8 }}><li>Scan this with an authenticator app (1Password, Google Authenticator, Authy…).</li><li>Enter the 6-digit code the app shows.</li></ol>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div role="img" aria-label="QR code for your authenticator app" style={{ width: 168, height: 168, background: '#fff', border: '1px solid var(--line)' }} dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
        <div style={{ flex: '1 1 220px' }}><p className="small muted" style={{ marginTop: 0 }}>Can't scan? Type this key into the app:</p><code className="secretkey">{setup.secret}</code></div>
      </div>
      <Field label="6-digit code">{id => <input id={id} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />}</Field>
      <p><button disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Turn on two-factor'}</button></p>
    </form>}
    {status.enabled && <>
      <p className="small">Recovery codes left: <b>{status.recoveryCodesLeft}</b></p>
      {!required && !disabling && <p><button className="secondary" onClick={() => setDisabling(true)}>Turn off two-factor</button></p>}
      {disabling && <form onSubmit={disable}>
        <Field label="Your password">{id => <input id={id} type="password" autoComplete="current-password" required value={pw} onChange={e => setPw(e.target.value)} />}</Field>
        <Field label="Current 6-digit code">{id => <input id={id} inputMode="numeric" pattern="\d{6}" maxLength={6} required value={dcode} onChange={e => setDcode(e.target.value.replace(/\D/g, ''))} />}</Field>
        <div className="row" style={{ marginTop: 12 }}><button className="danger" disabled={busy}>Turn off</button><button type="button" className="ghost" onClick={() => setDisabling(false)}>Cancel</button></div>
      </form>}
    </>}
  </section>;
}
