import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError, errorText, money, toCents } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';

type Biz = { business: any; store: any; role: string };

export function SellerShell() {
  const nav = useNavigate();
  const [data, setData] = useState<Biz | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const reload = useCallback(async () => {
    try { setData(await api('/api/seller/business')); }
    catch (e) { if (e instanceof ApiError && e.status === 401) nav('/login'); else setLoadErr(errorText(e)); }
  }, [nav]);
  useEffect(() => { reload(); }, [reload]);
  if (loadErr) return <div className="wrap"><Alert kind="err">{loadErr}</Alert></div>;
  if (!data) return <div className="wrap"><p>Loading…</p></div>;
  const logout = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); nav('/'); };
  return <>
    <header className="top"><div className="wrap">
      <Link to="/dashboard" className="logo">Eazy<b>Stores</b></Link>
      <div className="row"><span className="muted small">{data.business.business_name}</span><button className="secondary" onClick={logout}>Log out</button></div>
    </div></header>
    <div className="wrap">
      <nav className="tabs" aria-label="Seller sections">
        {[['', 'Overview'], ['products', 'Products'], ['orders', 'Orders'], ['settings', 'Store settings']].map(([p, l]) =>
          <NavLink key={p} end={p === ''} to={`/dashboard/${p}`.replace(/\/$/, '')} className={({ isActive }) => isActive ? 'active' : ''}>{l}</NavLink>)}
      </nav>
      <main>
        <Routes>
          <Route index element={<Overview data={data} />} />
          <Route path="products" element={<Products />} />
          <Route path="orders" element={<Orders />} />
          <Route path="settings" element={<Settings data={data} reload={reload} />} />
        </Routes>
      </main>
    </div>
  </>;
}

function Overview({ data }: { data: Biz }) {
  const [d, setD] = useState<any>(null); const [pc, setPc] = useState<number | null>(null);
  useEffect(() => { api('/api/seller/dashboard').then(setD).catch(() => {}); api('/api/seller/products?limit=1').then(r => setPc(r.length)).catch(() => {}); }, []);
  const published = data.store.status === 'published';
  const steps = [
    { done: !!(data.business.category && data.business.description), label: 'Describe your business', to: '/dashboard/settings' },
    { done: (pc ?? 0) > 0, label: 'Add your first product', to: '/dashboard/products' },
    { done: published, label: 'Publish your store', to: '/dashboard/settings' },
  ];
  return <>
    <h1>Overview</h1>
    {!steps.every(s => s.done) && <section className="card"><h2 style={{ marginTop: 0 }}>Get started</h2>
      <ol>{steps.map(s => <li key={s.label}>{s.done ? '✓ ' : ''}<Link to={s.to}>{s.label}</Link></li>)}</ol></section>}
    {published && <Alert kind="ok">Your store is live: <Link to={`/store/${data.store.slug}`}>/store/{data.store.slug}</Link></Alert>}
    {d && <>
      <div className="grid">
        <div className="card stat"><div className="n">{d.orders}</div><div className="l">Paid orders</div></div>
        <div className="card stat"><div className="n">{money(d.grossSalesCents)}</div><div className="l">Gross sales (not profit)</div></div>
        <div className="card stat"><div className="n">{d.cogsCents == null ? 'Unknown' : money(d.cogsCents)}</div><div className="l">Cost of goods sold</div></div>
        <div className="card stat"><div className="n">{d.grossProfitCents == null ? 'Unknown' : money(d.grossProfitCents)}</div><div className="l">Gross profit{d.grossProfitIsPartial ? ' (partial)' : ''}</div></div>
        <div className="card stat"><div className="n">{money(d.platformFeesCents)}</div><div className="l">EazyStores fees</div></div>
        <div className="card stat"><div className="n">{money(d.shippingCollectedCents)}</div><div className="l">Delivery fees collected</div></div>
      </div>
      {d.grossProfitIsPartial && <Alert kind="warn">{d.lineItemsMissingCost} sold item(s) have no cost recorded, so gross profit only covers items with a cost. Add costs on the Products page.</Alert>}
      <ul className="muted small">{d.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
    </>}
  </>;
}

type VRow = { title: string; price: string; cost: string; stock: string };
const blankV = (): VRow => ({ title: 'Default', price: '', cost: '', stock: '0' });

function Products() {
  const [items, setItems] = useState<any[] | null>(null);
  const [show, setShow] = useState(false); const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null);
  const load = useCallback(() => api('/api/seller/products?limit=100').then(setItems).catch(e => setMsg({ k: 'err', t: errorText(e) })), []);
  useEffect(() => { load(); }, [load]);

  async function adjust(variantId: string, delta: number) {
    try { await api(`/api/seller/variants/${variantId}/stock`, { body: { delta } }); load(); } catch (e) { setMsg({ k: 'err', t: errorText(e) }); }
  }
  async function setStatus(id: string, status: string) {
    try { await api(`/api/seller/products/${id}`, { method: 'PATCH', body: { status } }); load(); } catch (e) { setMsg({ k: 'err', t: errorText(e) }); }
  }
  return <>
    <div className="row spread"><h1>Products</h1><button onClick={() => setShow(s => !s)}>{show ? 'Close' : 'Add product'}</button></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    {show && <ProductForm onDone={() => { setShow(false); setMsg({ k: 'ok', t: 'Product saved.' }); load(); }} />}
    {items && !items.length && !show && <Empty title="No products yet">Add your first product to start selling.</Empty>}
    {items?.map(p => (
      <section className="card" key={p.id}>
        <div className="row spread"><h3>{p.name}</h3><Badge s={p.status} /></div>
        <ul className="list">
          {p.variants?.map((v: any) => (
            <li key={v.id} className="row spread">
              <span>{v.title} · {money(v.priceCents)}{v.costCents != null ? <span className="muted"> (cost {money(v.costCents)})</span> : <span className="muted"> (no cost set)</span>}</span>
              <span className="row">
                {v.trackInventory ? <>
                  <span>{v.onHand} in stock{v.reserved ? `, ${v.reserved} reserved` : ''} {v.lowStock && <span className="badge low">low</span>}</span>
                  <button className="secondary" aria-label={`Remove one ${p.name} ${v.title}`} onClick={() => adjust(v.id, -1)}>−1</button>
                  <button className="secondary" aria-label={`Add one ${p.name} ${v.title}`} onClick={() => adjust(v.id, 1)}>+1</button>
                </> : <span className="muted">Not tracked</span>}
              </span>
            </li>))}
        </ul>
        <div className="row">
          {p.status !== 'active' && <button onClick={() => setStatus(p.id, 'active')}>Publish product</button>}
          {p.status === 'active' && <button className="secondary" onClick={() => setStatus(p.id, 'draft')}>Hide (draft)</button>}
          {p.status !== 'archived' && <button className="danger" onClick={() => setStatus(p.id, 'archived')}>Archive</button>}
        </div>
      </section>))}
  </>;
}

function ProductForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [status, setStatus] = useState('active');
  const [vs, setVs] = useState<VRow[]>([blankV()]); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const upd = (i: number, k: keyof VRow, v: string) => setVs(p => p.map((r, j) => j === i ? { ...r, [k]: v } : r));
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await api('/api/seller/products', { body: { name, description: description || undefined, status, variants: vs.map(v => ({
        title: v.title || 'Default', priceCents: toCents(v.price), costCents: v.cost ? toCents(v.cost) : undefined, stock: parseInt(v.stock || '0', 10) })) } });
      onDone();
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return <form className="card" onSubmit={submit}>
    {err && <Alert kind="err">{err}</Alert>}
    <Field label="Product name">{id => <input id={id} required maxLength={200} value={name} onChange={e => setName(e.target.value)} />}</Field>
    <Field label="Description">{id => <textarea id={id} value={description} onChange={e => setDescription(e.target.value)} />}</Field>
    <h3 style={{ marginTop: 16 }}>Options and pricing</h3>
    <p className="muted small">Use one row per option (for example a colour or size). Cost is optional but needed to see your profit.</p>
    {vs.map((v, i) => <div className="variant-row" key={i}>
      <Field label="Option name">{id => <input id={id} value={v.title} onChange={e => upd(i, 'title', e.target.value)} />}</Field>
      <Field label="Price ($)">{id => <input id={id} required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={v.price} onChange={e => upd(i, 'price', e.target.value)} />}</Field>
      <Field label="Your cost ($)">{id => <input id={id} inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={v.cost} onChange={e => upd(i, 'cost', e.target.value)} />}</Field>
      <Field label="In stock">{id => <input id={id} required inputMode="numeric" pattern="\d+" value={v.stock} onChange={e => upd(i, 'stock', e.target.value)} />}</Field>
    </div>)}
    <div className="row"><button type="button" className="secondary" onClick={() => setVs(p => [...p, blankV()])}>Add another option</button>
      {vs.length > 1 && <button type="button" className="danger" onClick={() => setVs(p => p.slice(0, -1))}>Remove last option</button>}</div>
    <Field label="Visibility">{id => <select id={id} value={status} onChange={e => setStatus(e.target.value)}><option value="active">Visible in my store</option><option value="draft">Save as draft</option></select>}</Field>
    <p><button disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button></p>
  </form>;
}

const NEXT: Record<string, { to: string; label: string }[]> = {
  paid: [{ to: 'processing', label: 'Start processing' }], processing: [{ to: 'ready', label: 'Ready for pickup' }, { to: 'shipped', label: 'Mark shipped' }],
  ready: [{ to: 'completed', label: 'Mark completed' }], shipped: [{ to: 'completed', label: 'Mark completed' }],
};

function Orders() {
  const [items, setItems] = useState<any[] | null>(null); const [open, setOpen] = useState<any>(null); const [err, setErr] = useState('');
  const load = useCallback(() => api('/api/seller/orders?limit=100').then(setItems).catch(e => setErr(errorText(e))), []);
  useEffect(() => { load(); }, [load]);
  async function show(id: string) { setOpen(await api(`/api/seller/orders/${id}`)); }
  async function move(id: string, status: string) {
    try { await api(`/api/seller/orders/${id}/status`, { body: { status } }); await show(id); load(); } catch (e) { setErr(errorText(e)); }
  }
  return <>
    <h1>Orders</h1>
    {err && <Alert kind="err">{err}</Alert>}
    {items && !items.length && <Empty title="No orders yet">Share your store link to get your first order.</Empty>}
    {items && items.length > 0 && <section className="card"><ul className="list">
      {items.map(o => <li key={o.id}>
        <button className="secondary" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => show(o.id)} aria-label={`Open order ${o.number}`}>
          <span>#{o.number} · {o.customer_name}</span><span>{money(o.total_cents, o.currency)} <Badge s={o.status} /></span></button></li>)}
    </ul></section>}
    {open && <section className="card" aria-live="polite">
      <div className="row spread"><h2 style={{ margin: 0 }}>Order #{open.number}</h2><Badge s={open.status} /></div>
      <p>{open.customer_name} · {open.customer_email}<br />{open.fulfilment === 'delivery' && open.delivery_address ? `Deliver to: ${open.delivery_address.line1}, ${open.delivery_address.city} ${open.delivery_address.postalCode}` : 'Customer pickup'}</p>
      <table><tbody>{open.items.map((i: any, n: number) => <tr key={n}><td>{i.name}{i.variant_title !== 'Default' ? ` (${i.variant_title})` : ''} × {i.quantity}</td><td>{money(i.unit_price_cents * i.quantity)}</td></tr>)}
        <tr><td>Delivery</td><td>{money(open.shipping_cents)}</td></tr><tr><td><b>Total</b></td><td><b>{money(open.total_cents)}</b></td></tr></tbody></table>
      <div className="row" style={{ marginTop: 12 }}>{(NEXT[open.status] ?? []).map(n => <button key={n.to} onClick={() => move(open.id, n.to)}>{n.label}</button>)}</div>
      {open.status === 'awaiting_payment' && <p className="muted small">Waiting for the customer to pay. Stock is held until the reservation expires.</p>}
    </section>}
  </>;
}

function Settings({ data, reload }: { data: Biz; reload: () => void }) {
  const b = data.business, s = data.store;
  const [f, setF] = useState({ category: b.category ?? '', description: b.description ?? '', contactPhone: b.contact_phone ?? '', city: b.city ?? '', region: b.region ?? '',
    pickup: !!b.fulfilment?.pickup, delivery: !!b.fulfilment?.delivery, name: s.name, tagline: s.tagline ?? '', fee: ((s.delivery_fee_cents ?? 0) / 100).toFixed(2) });
  const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null); const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      await api('/api/seller/business', { method: 'PATCH', body: { category: f.category, description: f.description, contactPhone: f.contactPhone, city: f.city, region: f.region,
        fulfilment: { pickup: f.pickup, delivery: f.delivery, shipping: false } } });
      await api('/api/seller/store', { method: 'PATCH', body: { name: f.name, tagline: f.tagline, deliveryFeeCents: toCents(f.fee) } });
      setMsg({ k: 'ok', t: 'Saved.' }); reload();
    } catch (x) { setMsg({ k: 'err', t: errorText(x) }); } finally { setBusy(false); }
  }
  async function publish() {
    setMsg(null);
    try { await api('/api/seller/store/publish', { method: 'POST', body: {} }); setMsg({ k: 'ok', t: 'Your store is live!' }); reload(); } catch (x) { setMsg({ k: 'err', t: errorText(x) }); }
  }
  const link = `${window.location.origin}/store/${s.slug}`;
  return <>
    <h1>Store settings</h1>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    <form className="card" onSubmit={save}>
      <Field label="Store name">{id => <input id={id} required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />}</Field>
      <Field label="Tagline">{id => <input id={id} maxLength={200} value={f.tagline} onChange={e => setF({ ...f, tagline: e.target.value })} />}</Field>
      <Field label="What do you sell? (category)">{id => <input id={id} placeholder="e.g. Perfumes, 3D printed gifts" value={f.category} onChange={e => setF({ ...f, category: e.target.value })} />}</Field>
      <Field label="About your business">{id => <textarea id={id} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />}</Field>
      <Field label="Phone">{id => <input id={id} type="tel" autoComplete="tel" value={f.contactPhone} onChange={e => setF({ ...f, contactPhone: e.target.value })} />}</Field>
      <div className="row"><div style={{ flex: '1 1 160px' }}><Field label="City">{id => <input id={id} value={f.city} onChange={e => setF({ ...f, city: e.target.value })} />}</Field></div>
        <div style={{ flex: '1 1 160px' }}><Field label="Province / state">{id => <input id={id} value={f.region} onChange={e => setF({ ...f, region: e.target.value })} />}</Field></div></div>
      <h3 style={{ marginTop: 16 }}>How customers get their order</h3>
      <label className="check"><input type="checkbox" checked={f.pickup} onChange={e => setF({ ...f, pickup: e.target.checked })} />Customer pickup</label>
      <label className="check"><input type="checkbox" checked={f.delivery} onChange={e => setF({ ...f, delivery: e.target.checked })} />Delivery</label>
      {f.delivery && <Field label="Delivery fee ($)" hint="Flat fee per order.">{id => <input id={id} inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={f.fee} onChange={e => setF({ ...f, fee: e.target.value })} />}</Field>}
      <p><button disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></p>
    </form>
    <section className="card">
      <div className="row spread"><h2 style={{ margin: 0 }}>Publish</h2><Badge s={s.status} /></div>
      {s.status === 'published' ? <>
        <p>Share this link on Instagram, WhatsApp or anywhere:</p>
        <div className="row"><input readOnly value={link} aria-label="Store link" onFocus={e => e.currentTarget.select()} />
          <button className="secondary" onClick={() => navigator.clipboard?.writeText(link)}>Copy link</button><Link className="btn" to={`/store/${s.slug}`}>View store</Link></div></>
        : s.status === 'suspended' ? <Alert kind="err">Your store is suspended. Contact support.</Alert>
        : <><p className="muted">Save your details first, then publish. Customers can only see products you've made visible.</p><button onClick={publish}>Publish my store</button></>}
    </section>
  </>;
}
