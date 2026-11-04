import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError, errorText, money, toCents } from '../api';
import { Alert, Badge, Empty, Field } from '../ui';
import { IcoBox, IcoCog, IcoHome, IcoReceipt, IcoUpload } from '../icons';

type Biz = { business: any; store: any; role: string };
const NAV = [
  { to: '/dashboard', label: 'Overview', Icon: IcoHome, end: true }, { to: '/dashboard/products', label: 'Products', Icon: IcoBox },
  { to: '/dashboard/orders', label: 'Orders', Icon: IcoReceipt }, { to: '/dashboard/import', label: 'Import', Icon: IcoUpload },
  { to: '/dashboard/settings', label: 'Settings', Icon: IcoCog },
];

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
  if (!data) return <div className="wrap"><p className="muted">Loading…</p></div>;
  const logout = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); nav('/'); };
  const live = data.store.status === 'published';
  return <div className="app">
    <aside className="side" aria-label="Main navigation">
      <Link to="/dashboard" className="logo">Eazy<b>Stores</b></Link>
      {NAV.map(({ to, label, Icon, end }) => <NavLink key={to} end={end} to={to} className={({ isActive }) => `nav${isActive ? ' active' : ''}`}><Icon />{label}</NavLink>)}
      <div className="foot">
        <div className="small" style={{ fontWeight: 600 }}>{data.business.business_name}</div>
        <div className="small muted" style={{ marginBottom: 10 }}>{live ? <Link to={`/store/${data.store.slug}`}>/store/{data.store.slug}</Link> : 'Store not published yet'}</div>
        <button className="secondary sm" onClick={logout}>Log out</button>
      </div>
    </aside>
    <div>
      <div className="mtop"><Link to="/dashboard" className="logo">Eazy<b>Stores</b></Link><button className="ghost sm" onClick={logout}>Log out</button></div>
      <main className="main">
        <Routes>
          <Route index element={<Overview data={data} />} />
          <Route path="products" element={<Products />} />
          <Route path="orders" element={<Orders />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="settings" element={<Settings data={data} reload={reload} />} />
        </Routes>
      </main>
      <nav className="tabbar" aria-label="Main navigation">
        {NAV.map(({ to, label, Icon, end }) => <NavLink key={to} end={end} to={to} className={({ isActive }) => isActive ? 'active' : ''}><Icon />{label}</NavLink>)}
      </nav>
    </div>
  </div>;
}

function Overview({ data }: { data: Biz }) {
  const [d, setD] = useState<any>(null); const [pc, setPc] = useState<number | null>(null);
  useEffect(() => { api('/api/seller/dashboard').then(setD).catch(() => {}); api('/api/seller/products?limit=1').then(r => setPc(r.length)).catch(() => {}); }, []);
  const published = data.store.status === 'published';
  const steps = [
    { done: !!(data.business.category && data.business.description), label: 'Describe your business', to: '/dashboard/settings' },
    { done: (pc ?? 0) > 0, label: 'Add your first products', to: '/dashboard/products' },
    { done: published, label: 'Publish your store', to: '/dashboard/settings' },
  ];
  const unknown = (v: number | null) => v == null ? <div className="n unknown">Unknown</div> : <div className="n">{money(v)}</div>;
  return <>
    <div className="pagehead"><div><div className="eyebrow">Overview</div><h1>Good to see you, {data.business.business_name}</h1></div></div>
    {!steps.every(s => s.done) && <section className="card"><div className="eyebrow">Get started</div><ol style={{ margin: '10px 0 0', paddingLeft: 20, lineHeight: 2 }}>
      {steps.map(s => <li key={s.label}>{s.done ? <span className="muted"><s>{s.label}</s> ✓</span> : <Link to={s.to}>{s.label}</Link>}</li>)}</ol></section>}
    {published && <Alert kind="ok">Your store is live at <Link to={`/store/${data.store.slug}`}>/store/{data.store.slug}</Link>. Share it anywhere.</Alert>}
    {d && <>
      <div className="grid">
        <div className="card stat accent"><div className="n">{money(d.grossSalesCents)}</div><div className="l">Gross sales (not profit)</div></div>
        <div className="card stat"><div className="n">{d.orders}</div><div className="l">Paid orders</div></div>
        <div className="card stat">{unknown(d.cogsCents)}<div className="l">Cost of goods sold</div></div>
        <div className="card stat">{unknown(d.grossProfitCents)}<div className="l">Gross profit{d.grossProfitIsPartial && d.grossProfitCents != null ? ' (partial)' : ''}</div></div>
        <div className="card stat"><div className="n">{money(d.platformFeesCents)}</div><div className="l">EazyStores fees</div></div>
        <div className="card stat"><div className="n">{money(d.shippingCollectedCents)}</div><div className="l">Delivery fees collected</div></div>
      </div>
      {d.grossProfitIsPartial && <Alert kind="warn">{d.lineItemsMissingCost} sold item(s) have no cost recorded, so profit is {d.grossProfitCents == null ? 'unknown' : 'only partly known'}. Add costs on the Products page.</Alert>}
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
  const fail = (e: unknown) => setMsg({ k: 'err', t: errorText(e) });
  async function adjust(variantId: string, delta: number) { try { await api(`/api/seller/variants/${variantId}/stock`, { body: { delta } }); load(); } catch (e) { fail(e); } }
  async function setStatus(id: string, status: string) { try { await api(`/api/seller/products/${id}`, { method: 'PATCH', body: { status } }); load(); } catch (e) { fail(e); } }
  async function upload(productId: string, files: FileList | null) {
    if (!files) return; setMsg(null);
    for (const f of Array.from(files)) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { setMsg({ k: 'err', t: `${f.name}: use a JPG, PNG or WebP image.` }); continue; }
      if (f.size > 5 * 1024 * 1024) { setMsg({ k: 'err', t: `${f.name} is over 5 MB. Please use a smaller photo.` }); continue; }
      const res = await fetch(`/api/seller/products/${productId}/images`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': f.type }, body: f });
      if (!res.ok) { const d = await res.json().catch(() => ({})); fail(new ApiError(res.status, d.error ?? 'upload_failed')); }
    }
    load();
  }
  async function removeImage(id: string) { try { await api(`/api/seller/images/${id}`, { method: 'DELETE' }); load(); } catch (e) { fail(e); } }
  return <>
    <div className="pagehead"><div><div className="eyebrow">Catalogue</div><h1>Products</h1></div>
      <div className="row"><Link className="btn secondary" to="/dashboard/import">Import from spreadsheet</Link><button onClick={() => setShow(s => !s)}>{show ? 'Close' : 'Add product'}</button></div></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    {show && <ProductForm onDone={() => { setShow(false); setMsg({ k: 'ok', t: 'Product saved. Add photos below to make it shine.' }); load(); }} />}
    {items && !items.length && !show && <section className="card"><Empty title="Your catalogue is empty">Add a product, or import many at once from a spreadsheet.</Empty></section>}
    {items?.map(p => (
      <section className="card" key={p.id}>
        <div className="row spread"><h3>{p.name}</h3><Badge s={p.status} /></div>
        <div className="thumbs" aria-label={`Photos of ${p.name}`}>
          {p.images?.map((im: any) => <div className="thumb" key={im.id}><img src={im.url} alt="" loading="lazy" />
            <button aria-label="Remove photo" onClick={() => removeImage(im.id)}>×</button></div>)}
          <label className="thumb" style={{ display: 'grid', placeItems: 'center', cursor: 'pointer', margin: 0, color: 'var(--brand)' }}>
            <span style={{ fontSize: '1.6rem', lineHeight: 1 }} aria-hidden>+</span><span className="sr" style={{ position: 'absolute', left: -9999 }}>Add photos to {p.name}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ position: 'absolute', inset: 0, opacity: 0, minHeight: 0, cursor: 'pointer' }} aria-label={`Add photos to ${p.name}`}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { upload(p.id, e.target.files); e.target.value = ''; }} />
          </label>
        </div>
        <ul className="list">
          {p.variants?.map((v: any) => (
            <li key={v.id} className="row spread">
              <span>{v.title} · <b>{money(v.priceCents)}</b>{v.costCents != null ? <span className="muted"> · cost {money(v.costCents)}</span> : <span className="muted"> · no cost set</span>}</span>
              <span className="row">
                {v.trackInventory ? <>
                  <span>{v.onHand} in stock{v.reserved ? `, ${v.reserved} reserved` : ''} {v.lowStock && <span className="badge low">low</span>}</span>
                  <button className="secondary sm" aria-label={`Remove one ${p.name} ${v.title}`} onClick={() => adjust(v.id, -1)}>−1</button>
                  <button className="secondary sm" aria-label={`Add one ${p.name} ${v.title}`} onClick={() => adjust(v.id, 1)}>+1</button>
                </> : <span className="muted">Not tracked</span>}
              </span>
            </li>))}
        </ul>
        <div className="row" style={{ marginTop: 8 }}>
          {p.status !== 'active' && <button className="sm" onClick={() => setStatus(p.id, 'active')}>Publish product</button>}
          {p.status === 'active' && <button className="secondary sm" onClick={() => setStatus(p.id, 'draft')}>Hide (draft)</button>}
          {p.status !== 'archived' && <button className="danger sm" onClick={() => setStatus(p.id, 'archived')}>Archive</button>}
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


const FIELD_LABELS: Record<string, string> = { name: 'Product name', description: 'Description', brand: 'Brand', option: 'Option / size / colour', sku: 'SKU', price: 'Price', cost: 'Your cost', stock: 'Quantity' };
const TEMPLATE = 'Product Name,Option,SKU,Price,Cost,Quantity,Brand,Description\nOud Noir,50ml,OUD-50,80.00,35.00,4,Maison,Warm smoky oud\nOud Noir,100ml,OUD-100,140.00,60.00,2,Maison,Warm smoky oud\n';

function ImportPage() {
  const [csv, setCsv] = useState(''); const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<string, string> | undefined>(); const [prev, setPrev] = useState<any>(null);
  const [asDraft, setAsDraft] = useState(true); const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ k: 'err' | 'ok'; t: string } | null>(null); const fileRef = useRef<HTMLInputElement>(null);

  async function preview(map?: Record<string, string>) {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/api/seller/imports/preview', { body: { csv, mapping: map } });
      setPrev(r); setMapping(Object.fromEntries(Object.entries(r.mapping).map(([k, v]) => [k, v as string])));
    } catch (e) {
      setPrev(null);
      setMsg({ k: 'err', t: e instanceof ApiError && e.code === 'csv_malformed' ? 'This file could not be read as a CSV. Check for a missing closing quote.' : e instanceof ApiError && e.code === 'csv_empty' ? 'The file needs a header row and at least one product row.' : e instanceof ApiError && e.code === 'mapping_duplicate_field' ? 'Each field can only be assigned to one column.' : errorText(e) });
    } finally { setBusy(false); }
  }
  async function commit() {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/api/seller/imports/commit', { body: { csv, mapping, importAsDraft: asDraft } });
      setMsg({ k: 'ok', t: `Imported ${r.products} product(s) with ${r.variants} option(s). ${r.skipped} row(s) were skipped. Nothing existing was changed.${r.status === 'draft' ? ' They are saved as drafts: publish them from Products.' : ''}` });
      setPrev(null); setCsv(''); setFileName('');
    } catch (e) { setMsg({ k: 'err', t: e instanceof ApiError && e.code === 'nothing_to_import' ? 'No rows are ready to import. Fix the highlighted rows or remove duplicates first.' : errorText(e) }); }
    finally { setBusy(false); }
  }
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 2_000_000) { setMsg({ k: 'err', t: 'That file is too large (limit 2 MB, about 2,000 rows).' }); return; }
    setFileName(f.name); setCsv(await f.text()); setPrev(null); setMapping(undefined); setMsg(null);
  }
  const s = prev?.summary;
  return <>
    <div className="pagehead"><div><div className="eyebrow">Bulk tools</div><h1>Import products</h1><p>Upload a spreadsheet saved as CSV. We'll match your columns, check every row, and show you a preview before anything is added.</p></div></div>
    {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
    <section className="card">
      <div className="drop">
        <p style={{ margin: '0 0 12px' }}>{fileName ? <>Selected: <b>{fileName}</b></> : 'Choose a CSV file exported from Excel, Google Sheets or your old store.'}</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="secondary" onClick={() => fileRef.current?.click()}>Choose file</button>
          <a className="btn ghost" download="eazystores-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}>Download template</a>
        </div>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'none' }} aria-label="CSV file" />
      </div>
      <Field label="…or paste CSV text">{id => <textarea id={id} value={csv} onChange={e => { setCsv(e.target.value); setPrev(null); setMapping(undefined); }} placeholder="name,price,quantity" />}</Field>
      <p><button disabled={busy || !csv.trim()} onClick={() => preview()}>{busy && !prev ? 'Checking…' : 'Check my file'}</button></p>
    </section>
    {prev && <>
      <section className="card">
        <h3>1. Check how your columns were matched</h3>
        <p className="muted small">We guessed from your column names. Change any that look wrong.</p>
        <div className="grid">{prev.headers.map((h: string, i: number) => <Field key={i} label={`Column “${h}”`}>{id =>
          <select id={id} value={mapping?.[String(i)] ?? ''} onChange={e => { const m = { ...(mapping ?? {}) }; if (e.target.value) m[String(i)] = e.target.value; else delete m[String(i)]; setMapping(m); }}>
            <option value="">Ignore this column</option>{Object.entries(FIELD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>)}</div>
        <p><button className="secondary" disabled={busy} onClick={() => preview(mapping)}>Update preview</button></p>
      </section>
      <section className="card">
        <h3>2. Review</h3>
        <div className="chips"><span className="chip good">{s.importable} ready · {s.products} product(s)</span>
          {s.withIssues > 0 && <span className="chip bad">{s.withIssues} with problems</span>}{s.duplicates > 0 && <span className="chip mid">{s.duplicates} already in your store</span>}</div>
        {s.importable < s.total && <p className="muted small">Rows with problems or duplicates are skipped. Existing products are never changed. Fix your file and check again to include them.</p>}
        <div className="table-scroll"><table><thead><tr><th>Line</th><th>Product</th><th>Option</th><th>SKU</th><th>Price</th><th>Qty</th><th>Status</th></tr></thead><tbody>
          {prev.rows.map((r: any) => <tr key={r.line} className={r.issues.length ? 'issue' : r.duplicate ? 'dupe' : 'okrow'}>
            <td>{r.line}</td><td>{r.name || <i>missing</i>}</td><td>{r.option}</td><td>{r.sku ?? '—'}</td><td>{r.priceCents != null ? money(r.priceCents) : '—'}</td><td>{r.stock}</td>
            <td>{r.issues.length ? r.issues.join('; ') : r.duplicate ? `Skipped: ${r.duplicate}` : 'Ready'}</td></tr>)}</tbody></table></div>
        {prev.truncated && <p className="muted small">Showing the first 200 rows. All rows are checked on import.</p>}
      </section>
      <section className="card">
        <h3>3. Import</h3>
        <label className="check"><input type="checkbox" checked={asDraft} onChange={e => setAsDraft(e.target.checked)} />Save as drafts so I can review before they appear in my store</label>
        <p><button disabled={busy || s.importable === 0} onClick={commit}>{busy ? 'Importing…' : `Import ${s.importable} row(s)`}</button></p>
      </section>
    </>}
  </>;
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
    <div className="pagehead"><div><div className="eyebrow">Fulfilment</div><h1>Orders</h1></div></div>
    {err && <Alert kind="err">{err}</Alert>}
    {items && !items.length && <Empty title="No orders yet">Share your store link to get your first order.</Empty>}
    {items && items.length > 0 && <section className="card"><ul className="list">
      {items.map(o => <li key={o.id}>
        <button className="ghost" style={{ width: '100%', justifyContent: 'space-between', borderRadius: 12 }} onClick={() => show(o.id)} aria-label={`Open order ${o.number}`}>
          <span>#{o.number} · {o.customer_name}</span><span>{money(o.total_cents, o.currency)} <Badge s={o.status} /></span></button></li>)}
    </ul></section>}
    {open && <section className="card" aria-live="polite">
      <div className="row spread"><h2 style={{ margin: 0 }}>Order #{open.number}</h2><Badge s={open.status} /></div>
      <p>{open.customer_name} · {open.customer_email}<br />{open.fulfilment === 'delivery' && open.delivery_address ? `Deliver to: ${open.delivery_address.line1}, ${open.delivery_address.city} ${open.delivery_address.postalCode}` : 'Customer pickup'}</p>
      <div className="table-scroll"><table><tbody>{open.items.map((i: any, n: number) => <tr key={n}><td>{i.name}{i.variant_title !== 'Default' ? ` (${i.variant_title})` : ''} × {i.quantity}</td><td>{money(i.unit_price_cents * i.quantity)}</td></tr>)}
        <tr><td>Delivery</td><td>{money(open.shipping_cents)}</td></tr><tr><td><b>Total</b></td><td><b>{money(open.total_cents)}</b></td></tr></tbody></table></div>
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
    <div className="pagehead"><div><div className="eyebrow">Your store</div><h1>Settings</h1></div></div>
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
