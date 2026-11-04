import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText, money, toCents, PROVINCES } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';

const when = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const planMsg = (e: unknown) => { const t = errorText(e); return t.startsWith('Something went wrong (plan_feature_pos') ? 'Counter sales are on the Professional plan. See Plan.' : t; };

/* ---------------- More (mobile menu) ---------------- */
export function MorePage({ items }: { items: { to: string; label: string }[] }) {
  return <>
    <div className="pagehead"><div><div className="eyebrow">Everything else</div><h1>More</h1></div></div>
    <section className="card"><ul className="list">{items.map(i => <li key={i.to}><Link className="morelink" to={i.to}>{i.label}<span aria-hidden>›</span></Link></li>)}</ul></section>
  </>;
}

/* ---------------- Discount codes ---------------- */
const blankD = { code: '', kind: 'percent', value: '10', min: '', ends: '', maxUses: '', perEmail: '' };
export function Discounts() {
  const [items, setItems] = useState<any[] | null>(null); const [err, setErr] = useState(''); const [f, setF] = useState(blankD); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api('/api/seller/discounts').then(setItems).catch(e => setErr(errorText(e))), []);
  useEffect(() => { load(); }, [load]);
  const set = (k: keyof typeof blankD, v: string) => setF(p => ({ ...p, [k]: v }));
  async function create(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await api('/api/seller/discounts', { body: { code: f.code, kind: f.kind, value: f.kind === 'percent' ? parseInt(f.value || '0', 10) : f.kind === 'fixed' ? toCents(f.value) : 0,
        minSubtotalCents: f.min ? toCents(f.min) : 0, endsAt: f.ends ? new Date(f.ends + 'T23:59:59').toISOString() : undefined,
        maxUses: f.maxUses ? parseInt(f.maxUses, 10) : undefined, maxUsesPerEmail: f.perEmail ? parseInt(f.perEmail, 10) : undefined } });
      setF(blankD); load();
    } catch (x) { setErr(errorText(x).replace('Something went wrong (code_exists)', 'You already have a code with that name.')); } finally { setBusy(false); }
  }
  async function toggle(d: any) { try { await api(`/api/seller/discounts/${d.id}`, { method: 'PATCH', body: { active: !d.active } }); load(); } catch (x) { setErr(errorText(x)); } }
  const label = (d: any) => d.kind === 'percent' ? `${d.value}% off` : d.kind === 'fixed' ? `${money(d.value)} off` : 'Free delivery';
  return <>
    <div className="pagehead"><div><div className="eyebrow">Promotions</div><h1>Discount codes</h1></div></div>
    {err && <Alert kind="err">{err}</Alert>}
    <form className="card" onSubmit={create}>
      <h2>New code</h2>
      <div className="grid2">
        <Field label="Code" hint="Customers type this at checkout. Letters, numbers, - and _.">{id => <input id={id} required value={f.code} maxLength={30} onChange={e => set('code', e.target.value.toUpperCase())} />}</Field>
        <Field label="Type">{id => <select id={id} value={f.kind} onChange={e => set('kind', e.target.value)}><option value="percent">Percent off</option><option value="fixed">Fixed amount off</option><option value="free_shipping">Free delivery</option></select>}</Field>
        {f.kind !== 'free_shipping' && <Field label={f.kind === 'percent' ? 'Percent (1 to 100)' : 'Amount ($)'}>{id => <input id={id} required inputMode="decimal" value={f.value} onChange={e => set('value', e.target.value)} />}</Field>}
        <Field label="Minimum order ($)" hint="Optional">{id => <input id={id} inputMode="decimal" value={f.min} onChange={e => set('min', e.target.value)} />}</Field>
        <Field label="Ends on" hint="Optional">{id => <input id={id} type="date" value={f.ends} onChange={e => set('ends', e.target.value)} />}</Field>
        <Field label="Total uses allowed" hint="Optional">{id => <input id={id} inputMode="numeric" value={f.maxUses} onChange={e => set('maxUses', e.target.value)} />}</Field>
        <Field label="Uses per customer email" hint="Optional">{id => <input id={id} inputMode="numeric" value={f.perEmail} onChange={e => set('perEmail', e.target.value)} />}</Field>
      </div>
      <p><button disabled={busy}>{busy ? 'Saving…' : 'Create code'}</button></p>
      <p className="muted small">Once customers have used a code you can pause it, extend it or cap it, but not change what it gives. Platform fees are charged on what customers actually pay for goods, not on the discount.</p>
    </form>
    {items && !items.length && <Empty title="No codes yet">Create one above to run a promotion.</Empty>}
    {items && items.length > 0 && <section className="card"><div className="table-scroll"><table>
      <thead><tr><th>Code</th><th>Gives</th><th>Used</th><th>Discount given</th><th>Ends</th><th></th></tr></thead>
      <tbody>{items.map(d => <tr key={d.id}><td><b>{d.code}</b> {!d.active && <Badge s="paused" />}</td><td>{label(d)}{d.minSubtotalCents ? ` over ${money(d.minSubtotalCents)}` : ''}</td>
        <td>{d.redemptions}{d.maxUses ? ` / ${d.maxUses}` : ''}</td><td>{money(d.discountGivenCents)}</td><td>{when(d.endsAt) || '—'}</td>
        <td><button className="secondary sm" onClick={() => toggle(d)}>{d.active ? 'Pause' : 'Resume'}</button></td></tr>)}</tbody></table></div></section>}
  </>;
}

/* ---------------- Delivery rules ---------------- */
type Rule = { name: string; regions: string[]; minWeightG: string; maxWeightG: string; minSub: string; maxSub: string; price: string };
const blankR = (): Rule => ({ name: '', regions: [], minWeightG: '', maxWeightG: '', minSub: '', maxSub: '', price: '' });
export function ShippingRules() {
  const [rules, setRules] = useState<Rule[] | null>(null); const [err, setErr] = useState(''); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/seller/shipping-rules').then((rs: any[]) => setRules(rs.map(r => ({ name: r.name, regions: r.regions, minWeightG: r.minWeightG ? String(r.minWeightG) : '', maxWeightG: r.maxWeightG != null ? String(r.maxWeightG) : '',
    minSub: r.minSubtotalCents ? (r.minSubtotalCents / 100).toFixed(2) : '', maxSub: r.maxSubtotalCents != null ? (r.maxSubtotalCents / 100).toFixed(2) : '', price: (r.priceCents / 100).toFixed(2) })))).catch(e => setErr(errorText(e))); }, []);
  if (!rules) return err ? <Alert kind="err">{err}</Alert> : <p className="muted">Loading…</p>;
  const upd = (i: number, k: keyof Rule, v: any) => { setOk(false); setRules(p => p!.map((r, j) => j === i ? { ...r, [k]: v } : r)); };
  const move = (i: number, d: number) => setRules(p => { const a = [...p!]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  async function save() {
    setErr(''); setOk(false); setBusy(true);
    try {
      await api('/api/seller/shipping-rules', { method: 'PUT', body: { rules: rules!.map(r => ({ name: r.name, regions: r.regions, minWeightG: r.minWeightG ? parseInt(r.minWeightG, 10) : 0, maxWeightG: r.maxWeightG ? parseInt(r.maxWeightG, 10) : null,
        minSubtotalCents: r.minSub ? toCents(r.minSub) : 0, maxSubtotalCents: r.maxSub ? toCents(r.maxSub) : null, priceCents: toCents(r.price) })) } }); setOk(true);
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return <>
    <div className="pagehead"><div><div className="eyebrow">Delivery</div><h1>Delivery prices</h1></div></div>
    <section className="card"><p className="muted">Without rules, every delivery costs your flat delivery fee. Add rules to charge by province, weight or order value. The <b>first rule that matches</b> is used, so put the most specific ones first. If you add rules and none matches an order, customers cannot check out for delivery, so end with a catch-all rule.</p></section>
    {err && <Alert kind="err">{err}</Alert>}{ok && <Alert kind="ok">Saved.</Alert>}
    {rules.map((r, i) => <section className="card" key={i} aria-label={`Rule ${i + 1}`}>
      <div className="row spread"><h3 style={{ margin: 0 }}>Rule {i + 1}</h3><div className="row">
        <button type="button" className="ghost sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
        <button type="button" className="ghost sm" onClick={() => move(i, 1)} disabled={i === rules.length - 1} aria-label="Move down">↓</button>
        <button type="button" className="danger sm" onClick={() => setRules(p => p!.filter((_, j) => j !== i))}>Remove</button></div></div>
      <div className="grid2">
        <Field label="Name (shown to the customer)">{id => <input id={id} maxLength={80} value={r.name} onChange={e => upd(i, 'name', e.target.value)} />}</Field>
        <Field label="Delivery price ($)">{id => <input id={id} inputMode="decimal" value={r.price} onChange={e => upd(i, 'price', e.target.value)} />}</Field>
        <Field label="Weight from (g)">{id => <input id={id} inputMode="numeric" value={r.minWeightG} onChange={e => upd(i, 'minWeightG', e.target.value)} />}</Field>
        <Field label="Weight up to (g)" hint="Blank = no limit">{id => <input id={id} inputMode="numeric" value={r.maxWeightG} onChange={e => upd(i, 'maxWeightG', e.target.value)} />}</Field>
        <Field label="Order value from ($)">{id => <input id={id} inputMode="decimal" value={r.minSub} onChange={e => upd(i, 'minSub', e.target.value)} />}</Field>
        <Field label="Order value up to ($)" hint="Blank = no limit">{id => <input id={id} inputMode="decimal" value={r.maxSub} onChange={e => upd(i, 'maxSub', e.target.value)} />}</Field>
      </div>
      <fieldset className="chips"><legend>Provinces (none selected = everywhere)</legend>
        {PROVINCES.map(([c, n]) => <label key={c} className={`chip${r.regions.includes(c) ? ' on' : ''}`} title={n}><input type="checkbox" checked={r.regions.includes(c)} onChange={e => upd(i, 'regions', e.target.checked ? [...r.regions, c] : r.regions.filter(x => x !== c))} />{c}</label>)}</fieldset>
    </section>)}
    <div className="row"><button className="secondary" onClick={() => setRules(p => [...p!, blankR()])} disabled={rules.length >= 30}>Add a rule</button><button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save delivery prices'}</button></div>
  </>;
}

/* ---------------- Counter sales (POS) ---------------- */
type CartL = { variantId: string; name: string; variant: string; priceCents: number; qty: number; available: number | null };
export function Pos() {
  const [q, setQ] = useState(''); const [hits, setHits] = useState<any[]>([]); const [cart, setCart] = useState<CartL[]>([]); const [err, setErr] = useState(''); const [gate, setGate] = useState('');
  const [code, setCode] = useState(''); const [method, setMethod] = useState('cash'); const [tendered, setTendered] = useState(''); const [email, setEmail] = useState('');
  const [quote, setQuote] = useState<any>(null); const [done, setDone] = useState<any>(null); const [busy, setBusy] = useState(false); const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [done]);
  const items = cart.map(l => ({ variantId: l.variantId, quantity: l.qty }));
  useEffect(() => {
    if (!cart.length) { setQuote(null); return; }
    const h = setTimeout(() => api('/api/seller/pos/quote', { body: { items, discountCode: code || undefined } }).then(r => { setQuote(r); setErr(''); }).catch(e => { setQuote(null); setErr(errorText(e)); }), 250);
    return () => clearTimeout(h); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(items), code]);
  function add(h: any) {
    setCart(p => { const i = p.findIndex(l => l.variantId === h.variantId); if (i >= 0) return p.map((l, j) => j === i ? { ...l, qty: l.qty + 1 } : l);
      return [...p, { variantId: h.variantId, name: h.name, variant: h.variant, priceCents: h.priceCents, qty: 1, available: h.available }]; });
    setQ(''); setHits([]); input.current?.focus();
  }
  async function search(e: FormEvent) {
    e.preventDefault(); setErr(''); if (!q.trim()) return;
    try {
      const r: any[] = await api(`/api/seller/pos/lookup?q=${encodeURIComponent(q.trim())}`);
      if (r.length === 1 || (r.length && (r[0].barcode === q.trim() || r[0].sku?.toLowerCase() === q.trim().toLowerCase()))) add(r[0]); else { setHits(r); if (!r.length) setErr('Nothing found for that.'); }
    } catch (x) { if (String((x as any).code) === 'plan_feature_pos') setGate('Counter sales are included in the Professional plan.'); else setErr(planMsg(x)); }
  }
  async function charge() {
    setBusy(true); setErr('');
    try {
      const body: any = { items, paymentMethod: method, discountCode: code || undefined, customerEmail: email || undefined };
      if (method === 'cash' && tendered) body.tenderedCents = toCents(tendered);
      const sale = await api('/api/seller/pos/sales', { body });
      setDone(sale); setCart([]); setCode(''); setTendered(''); setEmail('');
    } catch (x) { setErr(errorText(x).replace('Something went wrong (out_of_stock)', 'Not enough stock for one of these items.')); } finally { setBusy(false); }
  }
  if (gate) return <><div className="pagehead"><div><div className="eyebrow">In person</div><h1>Counter sale</h1></div></div><Alert kind="warn">{gate} <Link to="/dashboard/plan">See plans</Link></Alert></>;
  const tenderedC = tendered ? toCents(tendered) : null; const short = method === 'cash' && quote && tenderedC != null && tenderedC < quote.totalCents;
  return <>
    <div className="pagehead"><div><div className="eyebrow">In person</div><h1>Counter sale</h1></div></div>
    {err && <Alert kind="err">{err}</Alert>}
    {done && <section className="card receipt" aria-live="polite"><div className="row spread"><h2 style={{ margin: 0 }}>Sale #{done.number} recorded</h2><button className="ghost sm" onClick={() => setDone(null)}>New sale</button></div>
      <p style={{ fontSize: 28, margin: '8px 0' }}>{money(done.totalCents)}</p>
      {done.changeCents != null && <p><b>Change due: {money(done.changeCents)}</b></p>}
      <p className="muted small">Paid by {done.paymentMethod.replace('_', ' ')}. {done.taxCents > 0 && <>Includes {money(done.taxCents)} tax. </>}Stock was updated.</p></section>}
    <form className="card" onSubmit={search} role="search">
      <Field label="Scan a barcode or search by name or SKU">{id => <input id={id} ref={input} value={q} onChange={e => setQ(e.target.value)} autoComplete="off" inputMode="search" />}</Field>
      <p><button>Find</button></p>
      {hits.length > 0 && <ul className="list">{hits.map(h => <li key={h.variantId}><button type="button" className="ghost" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => add(h)}>
        <span>{h.name}{h.variant !== 'Default' ? ` · ${h.variant}` : ''}</span><span>{money(h.priceCents)}{h.available != null ? ` · ${h.available} left` : ''}</span></button></li>)}</ul>}
    </form>
    {cart.length > 0 && <section className="card" aria-label="Cart">
      <ul className="list">{cart.map(l => <li key={l.variantId} className="row spread"><span>{l.name}{l.variant !== 'Default' ? ` · ${l.variant}` : ''}<br /><span className="muted small">{money(l.priceCents)} each</span></span>
        <span className="row"><button type="button" className="secondary sm" aria-label={`Remove one ${l.name}`} onClick={() => setCart(p => p.flatMap(x => x.variantId === l.variantId ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x]))}>−</button>
          <b>{l.qty}</b><button type="button" className="secondary sm" aria-label={`Add one ${l.name}`} onClick={() => setCart(p => p.map(x => x.variantId === l.variantId ? { ...x, qty: x.qty + 1 } : x))}>+</button></span></li>)}</ul>
      <div className="grid2">
        <Field label="Discount code">{id => <input id={id} value={code} onChange={e => setCode(e.target.value.toUpperCase())} />}</Field>
        <Field label="How did they pay?">{id => <select id={id} value={method} onChange={e => setMethod(e.target.value)}><option value="cash">Cash</option><option value="card_terminal">Card (your own terminal)</option><option value="e_transfer">e-Transfer</option><option value="other">Other</option></select>}</Field>
        {method === 'cash' && <Field label="Cash received ($)">{id => <input id={id} inputMode="decimal" value={tendered} onChange={e => setTendered(e.target.value)} />}</Field>}
        <Field label="Email a receipt (optional)">{id => <input id={id} type="email" value={email} onChange={e => setEmail(e.target.value)} />}</Field>
      </div>
      {quote && <table><tbody><tr><td>Subtotal</td><td>{money(quote.subtotalCents)}</td></tr>{quote.discountCents > 0 && <tr><td>Discount {quote.discountCode}</td><td>−{money(quote.discountCents)}</td></tr>}
        {quote.taxLines.map((t: any) => <tr key={t.name}><td>{t.name}</td><td>{money(t.cents)}</td></tr>)}<tr><td><b>Total</b></td><td><b data-testid="pos-total">{money(quote.totalCents)}</b></td></tr>
        {method === 'cash' && tenderedC != null && !short && <tr><td>Change</td><td>{money(tenderedC - quote.totalCents)}</td></tr>}</tbody></table>}
      {method === 'card_terminal' && <p className="muted small">EazyStores does not run your card terminal. Take the payment there, then record it here.</p>}
      <p><button onClick={charge} disabled={busy || !quote || !!short}>{busy ? 'Recording…' : short ? 'Cash is less than the total' : 'Record sale'}</button></p>
    </section>}
    <PosSummary refreshKey={done?.id} />
  </>;
}
function PosSummary({ refreshKey }: { refreshKey?: string }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => { api(`/api/seller/pos/summary?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`).then(setS).catch(() => setS(null)); }, [refreshKey]);
  if (!s) return null;
  return <section className="card"><h2>Today at the counter</h2>
    {s.sales === 0 ? <p className="muted">No counter sales yet today.</p> : <div className="table-scroll"><table><thead><tr><th>Paid by</th><th>Sales</th><th>Total</th></tr></thead>
      <tbody>{s.byMethod.map((m: any) => <tr key={m.method}><td>{m.method.replace('_', ' ')}</td><td>{m.count}</td><td>{money(m.totalCents)}</td></tr>)}<tr><td><b>All</b></td><td><b>{s.sales}</b></td><td><b>{money(s.totalCents)}</b></td></tr></tbody></table></div>}
    <p className="muted small">{s.note}</p></section>;
}

/* ---------------- Reviews ---------------- */
export function Reviews() {
  const [items, setItems] = useState<any[] | null>(null); const [err, setErr] = useState(''); const [open, setOpen] = useState(''); const [text, setText] = useState('');
  const load = useCallback(() => api('/api/seller/reviews').then(setItems).catch(e => setErr(errorText(e))), []);
  useEffect(() => { load(); }, [load]);
  async function reply(id: string) { try { await api(`/api/seller/reviews/${id}/reply`, { body: { reply: text } }); setOpen(''); setText(''); load(); } catch (x) { setErr(errorText(x).replace('(already_replied)', '— you have already replied.')); } }
  return <>
    <div className="pagehead"><div><div className="eyebrow">Customers</div><h1>Reviews</h1></div></div>
    {err && <Alert kind="err">{err}</Alert>}
    {items && !items.length && <Empty title="No reviews yet">Customers who bought a product can review it. You can reply once to each review.</Empty>}
    {items?.map(r => <section className="card" key={r.id}>
      <div className="row spread"><b>{r.productName}</b><span aria-label={`${r.rating} out of 5`}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span></div>
      {r.title && <p style={{ margin: '6px 0 0' }}><b>{r.title}</b></p>}{r.body && <p style={{ margin: '4px 0' }}>{r.body}</p>}
      <p className="muted small">{r.name} · {when(r.createdAt)}</p>
      {r.sellerReply ? <blockquote className="reply">{r.sellerReply}<div className="muted small">Your reply</div></blockquote>
        : open === r.id ? <div><Field label="Your reply (public, one per review)">{id => <textarea id={id} maxLength={1000} value={text} onChange={e => setText(e.target.value)} />}</Field>
          <div className="row"><button onClick={() => reply(r.id)} disabled={text.trim().length < 2}>Post reply</button><button className="ghost" onClick={() => setOpen('')}>Cancel</button></div></div>
        : <button className="secondary sm" onClick={() => { setOpen(r.id); setText(''); }}>Reply</button>}
    </section>)}
    <p className="muted small">Reviews can only be removed by EazyStores staff, with a recorded reason, so every review you see is a real customer’s.</p>
  </>;
}

/* ---------------- Plan & billing ---------------- */
export function Plan() {
  const [b, setB] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [interval, setIntervalV] = useState<'monthly' | 'annual'>('monthly'); const [busy, setBusy] = useState('');
  const load = useCallback(() => api('/api/seller/billing').then(setB).catch(e => setErr(e?.status === 403 ? 'Only the owner and managers can see billing.' : errorText(e))), []);
  useEffect(() => { load(); }, [load]);
  async function act(path: string, body: any, label: string) {
    setErr(''); setMsg(''); setBusy(label);
    try { const r = await api(path, { body }); setMsg(r.applied === 'period_end' ? `Done. This takes effect on ${when(r.effectiveAt)}, when your current period ends.` : r.applied === 'trial' ? `Your free trial has started and runs until ${when(r.trialEndsAt)}. You will be charged when it ends unless you change plan.` : r.chargedCents != null ? `Upgraded. Charged ${money(r.chargedCents)}${r.creditCents ? ` after a ${money(r.creditCents)} credit for unused time` : ''}.` : 'Done.'); await load(); }
    catch (x) { const t = errorText(x); setErr(t.replace(/Something went wrong \(usage_exceeds_plan:(.*)\)/, (_m, d) => `You are using more than that plan allows (${d.replace(/_/g, ' ')}). Reduce usage first.`).replace('Something went wrong (payment_failed:card_declined)', 'The card was declined, so nothing changed.').replace('Something went wrong (billing_not_configured)', 'Paid plans cannot be bought on this install yet.').replace('Something went wrong (managed_by_staff)', 'Your plan is arranged with our team. Contact support to change it.').replace('Something went wrong (payment_past_due)', 'Please resolve the unpaid invoice first.')); }
    finally { setBusy(''); }
  }
  if (!b) return err ? <Alert kind="err">{err}</Alert> : <p className="muted">Loading…</p>;
  const sub = b.subscription;
  return <>
    <div className="pagehead"><div><div className="eyebrow">Your subscription</div><h1>Plan</h1></div></div>
    {b.provider.simulated && <Alert kind="warn"><b>Simulated billing.</b> No real money moves and no card is held. This shows how plans will work.</Alert>}
    {!b.provider.configured && <Alert kind="warn">Paid plans cannot be bought on this install yet (no billing provider is connected).</Alert>}
    {err && <Alert kind="err">{err}</Alert>}{msg && <Alert kind="ok">{msg}</Alert>}
    <section className="card">
      <div className="row spread"><h2 style={{ margin: 0 }}>{b.plan.name}</h2><Badge s={sub.status} /></div>
      <p className="muted">{b.plan.priceMonthlyCents ? `${money(b.plan.priceMonthlyCents)} a month` : 'Free'} · platform fee {(b.plan.transactionFeeBps / 100).toFixed(2)}% on sales · {b.usage.activeProducts} active product(s){b.plan.limits.active_products ? ` of ${b.plan.limits.active_products}` : ''}</p>
      {sub.status === 'trialing' && <p>Free trial until <b>{when(sub.trialEndsAt)}</b>. Nothing has been charged yet.</p>}
      {sub.status === 'active' && b.plan.priceMonthlyCents > 0 && !sub.managedByStaff && <p>Paid through <b>{when(sub.currentPeriodEnd)}</b>, then renews.</p>}
      {sub.managedByStaff && <p>Your plan is arranged with our team and is not billed here.</p>}
      {sub.status === 'past_due' && <><Alert kind="err">Your last payment did not go through. We retry daily; if it is still unpaid by {when(sub.graceEndsAt)} your store moves to the free Starter plan. Nothing is deleted.</Alert>
        <button onClick={() => act('/api/seller/billing/retry', {}, 'retry')} disabled={!!busy}>Try payment again</button></>}
      {sub.pendingPlan && <p><Badge s="scheduled" /> Moves to <b>{b.plans.find((p: any) => p.code === sub.pendingPlan)?.name}</b> on {when(sub.currentPeriodEnd)}. <button className="ghost sm" onClick={() => act('/api/seller/billing/resume', {}, 'resume')}>Keep my current plan</button></p>}
      {!sub.pendingPlan && b.plan.code !== 'starter' && !sub.managedByStaff && sub.status !== 'past_due' && <button className="ghost sm" onClick={() => act('/api/seller/billing/cancel', {}, 'cancel')} disabled={!!busy}>Cancel paid plan (moves to Starter at period end)</button>}
    </section>
    <div className="row" role="group" aria-label="Billing period"><button className={interval === 'monthly' ? '' : 'secondary'} onClick={() => setIntervalV('monthly')}>Monthly</button><button className={interval === 'annual' ? '' : 'secondary'} onClick={() => setIntervalV('annual')}>Yearly</button></div>
    <div className="plans">{b.plans.map((p: any) => <section className={`card plan${p.current ? ' current' : ''}`} key={p.code}>
      <h3>{p.name}</h3><p className="price">{p.priceMonthlyCents ? money(interval === 'annual' ? p.priceAnnualCents : p.priceMonthlyCents) : 'Free'}<span className="muted small">{p.priceMonthlyCents ? (interval === 'annual' ? ' / year' : ' / month') : ''}</span></p>
      <ul className="ticks"><li>{p.limits.active_products ? `Up to ${p.limits.active_products.toLocaleString()} active products` : 'Unlimited products'}</li><li>{(p.transactionFeeBps / 100).toFixed(2)}% platform fee on sales</li>
        <li>{p.limits.staff ? `${p.limits.staff} team member${p.limits.staff > 1 ? 's' : ''}` : 'Unlimited team'}</li>{p.features.pos && <li>Counter sales (EazyPOS)</li>}{p.features.custom_domain && <li>Your own web address</li>}</ul>
      {p.exceeds.length > 0 && !p.current && <p className="muted small">Not available while you use more than it allows ({p.exceeds.map((x: any) => `${x.used} of ${x.max} ${x.limit.replace(/_/g, ' ')}`).join(', ')}).</p>}
      {p.current && sub.interval === interval ? <button disabled>Your plan</button>
        : <button className={p.current ? 'secondary' : ''} disabled={!!busy || p.exceeds.length > 0} onClick={() => act('/api/seller/billing/change', { plan: p.code, interval }, p.code)}>
          {p.trialAvailable ? `Start ${p.trialDays}-day free trial` : p.current ? `Switch to ${interval === 'annual' ? 'yearly' : 'monthly'}` : 'Choose'}</button>}
    </section>)}</div>
    <p className="muted small">Upgrades start immediately with credit for unused time; downgrades start when your paid period ends. {b.note} Larger shops can ask us about an Enterprise arrangement.</p>
    {b.invoices.length > 0 && <section className="card"><h2>Invoices</h2><div className="table-scroll"><table><thead><tr><th>Date</th><th>For</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>{b.invoices.map((i: any) => <tr key={i.id}><td>{when(i.createdAt)}</td><td>{i.description}</td><td>{money(i.amountCents)}{i.creditCents ? <span className="muted small"> (after {money(i.creditCents)} credit)</span> : null}</td><td><Badge s={i.status} /></td></tr>)}</tbody></table></div>
      {b.provider.simulated && <p className="muted small">Simulated: these are not real charges or tax invoices.</p>}</section>}
  </>;
}

/* ---------------- Business assistant ---------------- */
export function Assist() {
  const [qs, setQs] = useState<any[]>([]); const [ans, setAns] = useState<any>(null); const [text, setText] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/seller/assist/questions').then(setQs).catch(e => setErr(errorText(e))); }, []);
  async function ask(body: any) { setBusy(true); setErr(''); try { setAns(await api('/api/seller/assist/ask', { body })); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); } }
  const cell = (v: any, kind?: string) => v == null || v === '' ? '—' : kind === 'money' ? money(v) : kind === 'date' ? when(v) : String(v);
  return <>
    <div className="pagehead"><div><div className="eyebrow">Your numbers</div><h1>Ask about your business</h1></div></div>
    <section className="card"><p className="muted">Answers come straight from your own sales, stock and customer records using fixed calculations. This is not an AI guessing, and each answer says exactly how it was worked out.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>{qs.map(q => <button key={q.id} className="secondary sm" disabled={busy} onClick={() => ask({ id: q.id })}>{q.title}</button>)}</div>
      <form className="row" style={{ marginTop: 12 }} onSubmit={e => { e.preventDefault(); if (text.trim()) ask({ question: text }); }}>
        <input aria-label="Type a question" placeholder="Or type a question, e.g. what is selling best?" value={text} onChange={e => setText(e.target.value)} maxLength={300} style={{ flex: 1 }} /><button disabled={busy || !text.trim()}>Ask</button></form></section>
    {err && <Alert kind="err">{err}</Alert>}
    {ans && !ans.matched && <Alert kind="warn">{ans.message}</Alert>}
    {ans?.matched && <section className="card" aria-live="polite"><h2>{ans.title}</h2><p style={{ fontSize: 17 }}>{ans.summary}</p>
      {ans.rows.length > 0 && <div className="table-scroll"><table><thead><tr>{ans.columns.map((c: any) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{ans.rows.map((r: any, i: number) => <tr key={i}>{ans.columns.map((c: any) => <td key={c.key}>{cell(r[c.key], c.kind)}</td>)}</tr>)}</tbody></table></div>}
      <h3 style={{ marginTop: 16 }}>How to read this</h3><ul className="ticks">{ans.caveats.map((c: string) => <li key={c}>{c}</li>)}</ul><p className="muted small">{ans.method}</p></section>}
  </>;
}

/* ---------------- AI drafting (shown only when the server has a key) ---------------- */
export function useAiStatus() { const [s, setS] = useState<{ configured: boolean } | null>(null); useEffect(() => { api('/api/seller/ai/status').then(setS).catch(() => setS({ configured: false })); }, []); return s; }
export function AiPhotoDraft({ onDraft }: { onDraft: (d: { name: string; description: string }) => void }) {
  const st = useAiStatus(); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [res, setRes] = useState<any>(null);
  if (!st) return null;
  if (!st.configured) return <p className="muted small">Photo-to-listing drafting is off on this install (no AI key is set).</p>;
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return; setBusy(true); setErr(''); setRes(null);
    try {
      const r = await fetch('/api/seller/ai/snap', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': f.type }, body: f });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? 'failed');
      setRes(j); onDraft({ name: j.draft.name, description: j.draft.description });
    } catch (x: any) { setErr(x.message === 'ai_not_configured' ? 'AI drafting is off.' : `Could not draft from that photo (${x.message}). You can still fill it in by hand.`); } finally { setBusy(false); e.target.value = ''; }
  }
  return <div className="aibox"><label className="secondary btn">{busy ? 'Reading photo…' : 'Draft from a photo (AI)'}<input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick} disabled={busy} /></label>
    {err && <Alert kind="err">{err}</Alert>}
    {res && <><Alert kind="warn">{res.notice}</Alert>{res.warnings.length > 0 && <Alert kind="warn">Check these claims, you did not write them: {res.warnings.map((w: any) => `“${w.phrase}” (${w.type})`).join(', ')}.</Alert>}
      {res.draft.needsFromSeller.length > 0 && <p className="muted small">The AI could not tell: {res.draft.needsFromSeller.join(', ')}. Please add it.</p>}</>}</div>;
}
export function AiStoreText() {
  const st = useAiStatus(); const [f, setF] = useState({ whatYouSell: '', whoFor: '', story: '', tone: 'warm' }); const [res, setRes] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (!st) return null;
  if (!st.configured) return <section className="card"><h2>Draft my store text</h2><p className="muted">Off on this install: no AI key is set. You can still write your store text by hand in Settings.</p></section>;
  async function go(e: FormEvent) { e.preventDefault(); setBusy(true); setErr(''); setRes(null);
    try { setRes(await api('/api/seller/ai/launch', { body: { ...f, whoFor: f.whoFor || undefined, story: f.story || undefined } })); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); } }
  return <form className="card" onSubmit={go}><h2>Draft my store text (AI)</h2><p className="muted small">Tell us the facts; we draft a tagline and an About text. Only what you type here is sent. Nothing is saved to your store until you copy it.</p>
    {err && <Alert kind="err">{err}</Alert>}
    <Field label="What do you sell?">{id => <textarea id={id} required minLength={5} maxLength={600} value={f.whatYouSell} onChange={e => setF({ ...f, whatYouSell: e.target.value })} />}</Field>
    <Field label="Who is it for? (optional)">{id => <input id={id} maxLength={300} value={f.whoFor} onChange={e => setF({ ...f, whoFor: e.target.value })} />}</Field>
    <Field label="Your story (optional)">{id => <textarea id={id} maxLength={800} value={f.story} onChange={e => setF({ ...f, story: e.target.value })} />}</Field>
    <Field label="Tone">{id => <select id={id} value={f.tone} onChange={e => setF({ ...f, tone: e.target.value })}><option value="warm">Warm</option><option value="plain">Plain</option><option value="refined">Refined</option><option value="playful">Playful</option></select>}</Field>
    <p><button disabled={busy}>{busy ? 'Drafting…' : 'Draft text'}</button></p>
    {res && <div aria-live="polite"><Alert kind="warn">{res.notice}</Alert>{res.warnings.length > 0 && <Alert kind="warn">Check these claims, you did not write them: {res.warnings.map((w: any) => `“${w.phrase}”`).join(', ')}.</Alert>}
      <h3>Tagline</h3><p>{res.draft.tagline}</p><h3>About</h3><p style={{ whiteSpace: 'pre-wrap' }}>{res.draft.about}</p>
      {res.draft.shippingNote && <><h3>Delivery note</h3><p>{res.draft.shippingNote}</p></>}{res.draft.returnsNote && <><h3>Returns note</h3><p>{res.draft.returnsNote}</p></>}
      <div className="row"><button type="button" className="secondary sm" onClick={() => { navigator.clipboard?.writeText(`${res.draft.tagline}\n\n${res.draft.about}`); api(`/api/seller/ai/drafts/${res.id}/decision`, { body: { decision: 'accepted' } }).catch(() => {}); }}>Copy text</button>
        <button type="button" className="ghost sm" onClick={() => { api(`/api/seller/ai/drafts/${res.id}/decision`, { body: { decision: 'discarded' } }).catch(() => {}); setRes(null); }}>Discard</button></div></div>}
  </form>;
}
