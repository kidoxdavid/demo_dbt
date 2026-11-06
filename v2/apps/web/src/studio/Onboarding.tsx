import qrcode from 'qrcode-generator';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useDesktop } from '../hooks';
import { ApiError, api, useApi } from '../api';
import { ProductArt } from '../art/ProductArt';
import type { ArtKind, Tone } from '../art/tones';
import { Icon, type IconName } from '../components/Icon';
import { Button, Chip, Progress, Wordmark } from '../components/ui';
import { AttributeFields, cents, dollars, errText, uploadMedia, type AttrDef } from './fields';
import { useStudio } from './StudioShell';

interface Cat { id: string; slug: string; name: string; tileName: string; art: { kind: ArtKind; tone: Tone } | null }
const LEFT = ['About 9 min left', 'About 7 min left', 'About 5 min left', 'About 2 min left', 'All set'];
const LOOKS = [['atelier', 'Atelier'], ['noir', 'Noir'], ['sage', 'Sage'], ['blush', 'Blush'], ['sky', 'Sky']] as const;
const KEY = 'es_ob'; const mem = { get: (k: string) => { try { return sessionStorage.getItem(`${KEY}_${k}`); } catch { return null; } }, set: (k: string, v: string) => { try { sessionStorage.setItem(`${KEY}_${k}`, v); } catch { /* private mode */ } } };

/** Seller sign-up in five short steps: what you sell, shop identity, first product (photo first), shipping and returns, live. Matches reference seller-onboarding-1..4 (step 5 is the "live" screen). */
export function Onboarding() {
  const { step: s = '1' } = useParams(); const step = Math.min(5, Math.max(1, Number(s) || 1)); const { user, shop, ready } = useStudio(); const desktop = useDesktop();
  if (!ready) return <div className="pad" style={{ paddingTop: 40 }}><div className="skeleton" style={{ height: 240 }} /></div>;
  if (step > 1 && !(user && shop)) return <Navigate to="/studio/start/1" replace />;
  return <div role="main" className="screen ob" style={{ paddingBottom: 130 }}>{desktop && <div className="pad" style={{ paddingTop: 16 }}><Link to="/" className="crumbs">‹ Back to eazystores</Link></div>}<Progress step={step} total={5} left={LEFT[step - 1]} />
    {step === 1 && <StepSell />}{step === 2 && <StepIdentity />}{step === 3 && <StepProduct />}{step === 4 && <StepShipping />}{step === 5 && <StepLive />}</div>;
}

function BottomBar({ back, children }: { back?: string; children: React.ReactNode }) { return <div className={`bottombar${back ? ' g' : ' g'}`}>{back && <Button variant="ghost" to={back}>Back</Button>}{children}</div>; }

// ---- 1. What do you sell?
function StepSell() {
  const nav = useNavigate(); const { user, refresh } = useStudio(); const { data: cats } = useApi<Cat[]>('/api/categories'); const [sel, setSel] = useState<string[]>(() => { try { return JSON.parse(mem.get('cats') ?? '[]'); } catch { return []; } });
  const [more, setMore] = useState(false); const [sheet, setSheet] = useState(false); const toggle = (slug: string) => setSel(x => { const n = x.includes(slug) ? x.filter(y => y !== slug) : [...x, slug].slice(0, 8); mem.set('cats', JSON.stringify(n)); return n; });
  const list = (cats ?? []).filter(c => !c.slug.includes('/')); const shown = more ? list : list.slice(0, 10);
  return <><div className="pad" style={{ marginTop: 18 }}><h1 className="serif">What do you sell?</h1><div className="lede">Pick everything that fits. We will set up the right fields for you.</div>
    <div className="grid2" style={{ marginTop: 18 }}>{shown.map(c => { const on = sel.includes(c.slug); return <button key={c.slug} type="button" className={`tile-sel${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(c.slug)}><div className="a">{c.art && <ProductArt kind={c.art.kind} tone={c.art.tone} />}</div><div className="n">{c.tileName}{on && <Icon name="check" />}</div></button>; })}</div>
    <div className="tell">{more ? 'Not here? Choose “Something else”.' : <>Something else? <button type="button" onClick={() => setMore(true)}>Tell us</button></>}</div>
    {!user && <p className="tell" style={{ marginTop: 8 }}>Already selling? <Link to="/studio/login" style={{ color: 'var(--acc)', fontWeight: 700 }}>Sign in</Link></p>}</div>
    <div className="bottombar g"><Button block disabled={!sel.length} onClick={() => (user ? nav('/studio/start/2') : setSheet(true))}>Continue</Button></div>
    {sheet && <Account cats={sel} onDone={async () => { await refresh(); nav('/studio/start/2'); }} onClose={() => setSheet(false)} />}</>;
}
function Account({ cats, onDone, onClose }: { cats: string[]; onDone: () => void; onClose: () => void }) {
  const [f, setF] = useState({ fullName: '', email: '', password: '', shopName: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/api/studio/signup', { method: 'POST', body: { fullName: f.fullName.trim(), email: f.email.trim(), password: f.password, categories: cats, ...(f.shopName.trim() ? { shopName: f.shopName.trim() } : {}) } }); onDone(); }
    catch (x) { setErr(x instanceof ApiError && x.code === 'signups_closed' ? 'New maker sign-ups are closed right now. Please check back soon.' : x instanceof ApiError && x.code === 'email_in_use' ? 'There is already an account with that email. Sign in instead.' : x instanceof ApiError && x.code.startsWith('weak_password') ? 'Choose a longer, less common password (at least 10 characters).' : errText(x)); } finally { setBusy(false); } };
  return <div className="sheet-scrim" onClick={onClose}><form className="sheet" role="dialog" aria-label="Create your seller account" onClick={e => e.stopPropagation()} onSubmit={submit} noValidate><h3 className="serif">Create your seller account</h3>
    <label className="label" htmlFor="sa-name">Your name</label><input id="sa-name" className="field" autoComplete="name" value={f.fullName} onChange={e => setF({ ...f, fullName: e.target.value })} required />
    <label className="label" htmlFor="sa-shop">Shop name (you can change it)</label><input id="sa-shop" className="field" value={f.shopName} onChange={e => setF({ ...f, shopName: e.target.value })} />
    <label className="label" htmlFor="sa-email">Email</label><input id="sa-email" className="field" type="email" autoComplete="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required />
    <label className="label" htmlFor="sa-pw">Password</label><input id="sa-pw" className="field" type="password" autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required />
    {err && <div className="err" role="alert">{err}</div>}<div className="row"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" block disabled={busy}>{busy ? 'One moment…' : 'Create account'}</Button></div></form></div>;
}

// ---- 2. Shop identity
function StepIdentity() {
  const nav = useNavigate(); const { shop, refresh } = useStudio(); const [name, setName] = useState(shop!.name); const [tagline, setTagline] = useState(shop!.tagline ?? ''); const [look, setLook] = useState(shop!.look); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [logo, setLogo] = useState<string | null>(shop!.logo); const kind = (shop!.categories[0] ? 'pottery' : 'pottery') as ArtKind; const cat = useApi<Cat[]>('/api/categories').data; const art = cat?.find(c => c.slug === shop!.categories[0]?.slug)?.art; void kind;
  const setLogoFile = async (f?: File) => { if (!f) return; try { const m = await uploadMedia(f); await api('/api/studio/shop', { method: 'PATCH', body: { logoMediaId: m.id } }); setLogo(m.url); await refresh(); } catch (x) { setErr(errText(x)); } };
  const save = async () => { setErr(''); setBusy(true); try { await api('/api/studio/shop', { method: 'PATCH', body: { name: name.trim(), tagline: tagline.trim() || null, look } }); await refresh(); nav('/studio/start/3'); } catch (x) { setErr(errText(x, { slug_unavailable: 'That shop name is taken. Try another.' })); } finally { setBusy(false); } };
  return <><div className="pad" style={{ marginTop: 18 }}><h1 className="serif">Make it yours</h1>
    <div className="card previewcard"><div className="ban"><ProductArt kind={art?.kind ?? 'pottery'} tone="blush" /></div><div className="bd"><label className="lg" style={{ display: 'block', cursor: 'pointer' }} title="Add a logo">{logo ? <img src={logo} alt="Logo" /> : <ProductArt kind={art?.kind ?? 'pottery'} tone="warm" />}<input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload a logo" style={{ display: 'none' }} onChange={e => setLogoFile(e.target.files?.[0])} /></label>
      <div className="nm serif">{name || 'Your shop'}</div><div className="tg">{tagline || 'Your one-line tagline'}</div></div></div>
    <label className="flabel" htmlFor="ob-name" style={{ display: 'block' }}>Shop name</label><input id="ob-name" className="fcard" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
    <label className="flabel t12" htmlFor="ob-tag" style={{ display: 'block' }}>One-line tagline</label><input id="ob-tag" className="fcard" value={tagline} maxLength={140} placeholder="What makes your shop yours?" onChange={e => setTagline(e.target.value)} />
    <div className="flabel t16" id="look-l">Choose a look</div><div className="looks" role="radiogroup" aria-labelledby="look-l">{LOOKS.map(([k, n]) => <button key={k} type="button" role="radio" aria-checked={look === k} onClick={() => setLook(k)}><span className={`sw${look === k ? ' on' : ''}`} data-theme={k} style={{ background: 'var(--bg)', display: 'flex' }}><i style={{ background: 'var(--acc)' }} /></span><div className="nmx">{n}</div></button>)}</div>
    {err && <div className="err" role="alert">{err}</div>}</div>
    <BottomBar back="/studio/start/1"><Button block disabled={busy || name.trim().length < 1} onClick={save}>{busy ? 'Saving…' : 'Continue'}</Button></BottomBar></>;
}

// ---- 3. First product (photo first)
interface PV { updatedAt: string; id: string; title: string; status: string; handmade: boolean; oneOfAKind: boolean; attributes: Record<string, unknown>; categorySlug: string | null; media: { id: string; url: string }[]; variants: { priceCents: number; stock: number }[]; art?: { kind: ArtKind; tone: Tone } | null;
  category: { slug: string; name: string; restricted: boolean; attributes: AttrDef[] } | null; readiness: { ready: boolean; problems: { field: string; code: string; message: string }[] } }
function StepProduct() {
  const nav = useNavigate(); const [sp] = useSearchParams(); const { refresh } = useStudio(); const [id, setId] = useState<string | null>(sp.get('draft') ?? mem.get('draft')); const [p, setP] = useState<PV | null>(null);
  const [title, setTitle] = useState(''); const [price, setPrice] = useState(''); const [qty, setQty] = useState('1'); const [handmade, setHandmade] = useState(true); const [ooak, setOoak] = useState(false); const [attrs, setAttrs] = useState<Record<string, unknown>>({}); const [ack, setAck] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [sug, setSug] = useState<{ slug: string | null; name: string | null; suggested: boolean } | null>(null);
  const loaded = useRef(false); const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = async (pid: string) => { const v = await api<PV>(`/api/studio/products/${pid}`); setP(v); if (!loaded.current) { loaded.current = true; setTitle(v.title); setPrice(v.variants[0] ? dollars(v.variants[0].priceCents) : ''); setQty(String(v.variants[0]?.stock ?? 1)); setHandmade(v.handmade); setOoak(v.oneOfAKind); setAttrs(v.attributes); } return v; };
  useEffect(() => { if (id) void load(id).catch(() => { mem.set('draft', ''); setId(null); }); else loaded.current = true; }, []);          // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (title.trim().length < 2) return; const t = setTimeout(() => api<any>(`/api/studio/suggest-category?title=${encodeURIComponent(title)}`).then(setSug, () => {}), 400); return () => clearTimeout(t); }, [title]);
  const body = () => ({ title: title.trim(), handmade, oneOfAKind: ooak, ...(sug?.slug && !p?.categorySlug ? { categorySlug: sug.slug } : {}), ...(cents(price) !== null ? { priceCents: cents(price)! } : {}), stock: ooak ? 1 : Math.max(0, Math.min(1_000_000, Math.floor(Number(qty) || 0))), attributes: attrs, ...(p ? { mediaIds: p.media.map(m => m.id) } : {}) });
  const save = async (extra: object = {}) => { setState('saving'); try { const b = { ...body(), ...extra }; const v = id ? await api<PV>(`/api/studio/products/${id}`, { method: 'PATCH', body: b }) : await api<PV>('/api/studio/products', { method: 'POST', body: b }); if (!id) { setId(v.id); mem.set('draft', v.id); } setP(v); setState('saved'); return v; } catch (x) { setState('error'); setErr(errText(x, { one_of_a_kind_needs_single_item: 'A one-of-a-kind piece has a quantity of 1.' })); throw x; } };
  const touched = useRef(false); useEffect(() => { if (!touched.current) return; clearTimeout(timer.current); timer.current = setTimeout(() => { void save().catch(() => {}); }, 900); return () => clearTimeout(timer.current); }, [title, price, qty, handmade, ooak, attrs]);          // eslint-disable-line react-hooks/exhaustive-deps
  const edit = <T,>(set: (v: T) => void) => (v: T) => { touched.current = true; set(v); };
  const addPhoto = async (f?: File) => { if (!f) return; setErr(''); try { const m = await uploadMedia(f); const ids = [...(p?.media.map(x => x.id) ?? []), m.id]; const v = await save({ mediaIds: ids }); void v; } catch (x) { setErr(errText(x)); } };
  const publish = async () => { setErr(''); setBusy(true); try { await save(); const v = await api<any>(`/api/studio/products/${id}/publish`, { method: 'POST', body: { acknowledged: ack } }); void v; mem.set('draft', ''); await refresh(); nav('/studio/start/4'); }
    catch (x) { if (x instanceof ApiError && x.code === 'acknowledgement_required') { /* shown below */ } else if (x instanceof ApiError && Array.isArray(x.body?.detail ?? x.body?.problems)) setErr(''); else if (!(x instanceof ApiError)) setErr('Something went wrong.'); if (id) await load(id).catch(() => {}); if (x instanceof ApiError && x.code.startsWith('prohibited_item')) setErr(x.body?.detail?.[0]?.message ?? 'That item cannot be sold here.'); } finally { setBusy(false); } };
  const slots = [...(p?.media ?? [])]; const cover = slots[0]; const needed = (p?.category?.attributes ?? []).filter(a => a.required); const probs = (p?.readiness.problems ?? []).filter(x => x.code !== 'attribute_required' || true);
  return <><div className="pad" style={{ marginTop: 16 }}><h1 className="serif">Add your first product</h1><div className="lede" style={{ fontSize: 13, marginTop: 6 }}>Start with photos. Good light, plain background.</div>
    <div className="photos"><div className="cover">{cover ? <img src={cover.url} alt="Cover photo" /> : p?.art ? <ProductArt kind={p.art.kind} tone={p.art.tone} /> : <label className="slot" style={{ height: '100%', aspectRatio: 'auto', borderRadius: 0 }}><Icon name="cam" /><input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Add a cover photo" onChange={e => addPhoto(e.target.files?.[0])} /></label>}{(cover || p?.art) && <Chip variant="surf">Cover</Chip>}</div>
      {Array.from({ length: 4 }, (_, i) => { const m = slots[i + 1]; return <label key={i} className="slot">{m ? <img src={m.url} alt="" /> : <Icon name="cam" />}{!m && <input type="file" accept="image/jpeg,image/png,image/webp" aria-label={`Add photo ${i + 2}`} onChange={e => addPhoto(e.target.files?.[0])} />}</label>; })}</div>
    <label className="flabel t16" htmlFor="p-title" style={{ display: 'block' }}>Title</label><input id="p-title" className="fcard t13" value={title} maxLength={140} onChange={e => edit(setTitle)(e.target.value)} />
    <div style={{ display: 'flex', gap: 10, marginTop: 12 }}><div style={{ flex: 1 }}><label className="flabel" htmlFor="p-price" style={{ display: 'block', marginTop: 0, fontSize: 13 }}>Price</label><input id="p-price" className="fcard t13" inputMode="decimal" placeholder="$ 0.00" value={price ? `$ ${price}` : ''} onChange={e => edit(setPrice)(e.target.value.replace(/^\$\s*/, ''))} /></div>
      <div style={{ flex: 1 }}><label className="flabel" htmlFor="p-qty" style={{ display: 'block', marginTop: 0, fontSize: 13 }}>Quantity</label><input id="p-qty" className="fcard t13" inputMode="numeric" value={ooak ? '1' : qty} disabled={ooak} onChange={e => edit(setQty)(e.target.value)} /></div></div>
    <div className="chips-row">{sug?.name && <Chip>✓ {sug.name}{sug.suggested ? ' · suggested' : ''}</Chip>}<button type="button" className={`chip ${handmade ? '' : 'outline'}`.trim()} style={handmade ? { background: 'var(--surf)', border: '1px solid var(--line)', color: 'var(--ink)' } : { background: 'var(--surf)', border: '1px solid var(--line)', color: 'var(--ink)' }} aria-pressed={handmade} onClick={() => edit(setHandmade)(!handmade)}>Handmade{handmade ? ' ✓' : ''}</button>
      <button type="button" className="chip" style={{ background: 'var(--surf)', border: '1px solid var(--line)', color: 'var(--ink)' }} aria-pressed={ooak} onClick={() => edit(setOoak)(!ooak)}>One of a kind{ooak ? ' ✓' : ''}</button></div>
    <Link to={id ? `/studio/products/${id}` : '/studio/products/new'} className="card addrow"><span>Add sizes or colours</span><Icon name="plus" /></Link>
    {needed.length > 0 && <div className="card" style={{ marginTop: 14, padding: '14px 16px' }}><b style={{ fontSize: 14 }}>A few details for {p?.category?.name}</b><AttributeFields defs={p!.category!.attributes} value={attrs} onChange={(k, v) => edit(setAttrs)({ ...attrs, [k]: v })} only={d => !!d.required} /></div>}
    {p?.category?.restricted && <label className="tgl" style={{ marginTop: 14, fontSize: 13, display: 'flex', gap: 10 }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />I have read the extra rules for {p.category.name} and my product follows them.</label>}
    {probs.length > 0 && title && <ul className="problems" aria-live="polite">{probs.map(x => <li key={x.code + x.field}>{x.message}</li>)}</ul>}
    {err && <div className="err" role="alert">{err}</div>}<div className="saved" aria-live="polite">{state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved yet' : id ? `✓ Draft saved${state === 'saved' || (p && Date.now() - new Date(p.updatedAt).getTime() < 90_000) ? ' just now' : ''}` : ''}</div></div>
    <BottomBar back="/studio/start/2"><Button block disabled={busy || !id || (probs.length > 0) || (!!p?.category?.restricted && !ack)} onClick={publish}>{busy ? 'Publishing…' : 'Publish product'}</Button></BottomBar></>;
}

// ---- 4. Shipping and returns
function StepShipping() {
  const nav = useNavigate(); const { shop, refresh } = useStudio(); const prof = useApi<any[]>('/api/studio/shipping-profiles'); const def = prof.data?.find(p => p.isDefault);
  const [min, setMin] = useState(String(shop!.processing.minDays)); const [max, setMax] = useState(String(shop!.processing.maxDays)); const [rate, setRate] = useState(''); const [free, setFree] = useState(''); const [returns, setReturns] = useState<string>(shop!.policies?.returns?.template ?? 'standard'); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (def) { setRate(dollars(def.baseCents)); setFree(def.freeOverCents ? dollars(def.freeOverCents) : ''); } }, [def?.id]);          // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { setErr(''); setBusy(true); try {
    const r = cents(rate); const f = free.trim() ? cents(free) : null; if (r === null || (free.trim() && f === null)) { setErr('Enter the shipping price in dollars, for example 9.00.'); return; }
    await api('/api/studio/shop', { method: 'PATCH', body: { processingDaysMin: Number(min), processingDaysMax: Number(max), policies: { returns: { template: returns } } } });
    if (def) await api(`/api/studio/shipping-profiles/${def.id}`, { method: 'PUT', body: { name: def.name, rateType: 'flat', baseCents: r, extraItemCents: 0, perKgCents: 0, freeOverCents: f, transitDaysMin: def.transitDaysMin, transitDaysMax: def.transitDaysMax, isDefault: true } });
    await refresh(); nav('/studio/start/5'); } catch (x) { setErr(errText(x, { processing_range_invalid: 'The longest time cannot be shorter than the shortest.' })); } finally { setBusy(false); } };
  const days = Array.from({ length: 15 }, (_, i) => i);
  return <><div className="pad" style={{ marginTop: 18 }}><h1 className="serif">Shipping and returns</h1><div className="lede">Buyers see these before they order. You can change them any time.</div>
    <div className="flabel t16">Time to get an order ready</div><div className="form"><div className="two"><div><label className="label" htmlFor="sh-min">Fastest (days)</label><select id="sh-min" className="field" value={min} onChange={e => setMin(e.target.value)}>{days.map(d => <option key={d}>{d}</option>)}</select></div><div><label className="label" htmlFor="sh-max">Slowest (days)</label><select id="sh-max" className="field" value={max} onChange={e => setMax(e.target.value)}>{days.map(d => <option key={d}>{d}</option>)}</select></div></div>
      <label className="label" htmlFor="sh-rate">Flat shipping price ($ per order)</label><input id="sh-rate" className="field" inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} />
      <label className="label" htmlFor="sh-free">Free shipping over ($, optional)</label><input id="sh-free" className="field" inputMode="decimal" placeholder="75.00" value={free} onChange={e => setFree(e.target.value)} /><div className="hint">Free shipping over $75 sells more for most shops.</div>
      <div className="flabel t16" id="ret-l">Returns</div><div role="radiogroup" aria-labelledby="ret-l">{[['standard', 'Accept returns within 14 days'], ['final_sale', 'Final sale (no returns, except damaged items)']].map(([v, l]) => <label key={v} className="tgl"><input type="radio" name="returns" checked={returns === v} onChange={() => setReturns(v)} />{l}</label>)}</div></div>
    {err && <div className="err" role="alert">{err}</div>}</div>
    <BottomBar back="/studio/start/3"><Button block disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Continue'}</Button></BottomBar></>;
}

// ---- 5. Live
function Qr({ text }: { text: string }) {
  const q = qrcode(0, 'M'); q.addData(text); q.make(); const n = q.getModuleCount(); const cells: string[] = []; for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(`M${c} ${r}h1v1h-1z`);
  return <div className="qr"><svg viewBox={`0 0 ${n} ${n}`} role="img" aria-label="QR code for your shop link" shapeRendering="crispEdges"><path d={cells.join('')} fill="var(--ink)" /></svg></div>;
}
function StepLive() {
  const { shop } = useStudio(); const [copied, setCopied] = useState(false); const url = `${location.origin}/shop/${shop!.slug}`; const shown = `eazystores.ca/shop/${shop!.slug}`;
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { window.prompt('Copy your shop link', url); } };
  const todo: [IconName, string, string, string][] = [['wallet', 'Set up payouts', '2 minutes · so you can get paid', '/studio/payouts'], ['plus', 'Add more products', 'Or import many at once from a spreadsheet', '/studio/products/new'], ['truck', 'Offer free shipping', 'Over $75 sells more for most shops', '/studio/shipping']];
  return <><div className="pad live" style={{ marginTop: 22 }}><div className="ok-mark"><Icon name="check" size={28} /></div><h1 className="serif">Your shop is live</h1><div className="lede">{shop!.name} is open for business.</div>
    <div className="card livecard"><Qr text={url} /><div style={{ flex: 1 }}><div className="k">Your shop link</div><div className="u">{shown}</div><Button size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button></div></div></div>
    <div className="pad" style={{ marginTop: 20 }}><div style={{ fontSize: 13, fontWeight: 600 }}>Three quick things to do next</div>{todo.map(([i, t, s, to]) => <Link key={t} to={to} className="card todo"><span className="c"><Icon name={i} /></span><span className="x"><b>{t}</b><div>{s}</div></span><Icon name="chev" /></Link>)}</div>
    <div className="bottombar" style={{ padding: '14px 18px 30px' }}><Button block to="/studio">Go to my studio</Button></div></>;
}
void Wordmark;
