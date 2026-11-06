import { useEffect, useState } from 'react';
import { api, useApi } from '../api';
import { Button, Chip } from '../components/ui';
import { Page, Rows, Switch, fail } from './shared';

const PORTALS = [['studio', 'Maker studio'], ['admin', 'Admin'], ['support', 'Support'], ['finance', 'Finance'], ['marketing', 'Marketing']] as const;
const LOOKS = ['atelier', 'noir', 'sage', 'blush', 'sky'];

/** The name beside the logo and the colour look of each portal. */
export function BrandingPage() {
  const { data, reload } = useApi<any[]>('/api/admin/settings'); const pub = useApi<any>('/api/settings/public'); const [b, setB] = useState<any>(null); const [err, setErr] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (pub.data?.portal_branding) setB(pub.data.portal_branding); }, [pub.data]);
  void data; void reload;
  const save = async () => { setErr(''); setNote(''); setBusy(true); try { await api('/api/admin/settings/portal_branding', { method: 'PUT', body: { value: b } }); setNote('Saved. Each portal picks it up the next time it loads.'); pub.reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  if (!b) return <Page title="Portal names and looks" sub="Loading…"><div className="skeleton" style={{ height: 160 }} /></Page>;
  return <Page title="Portal names and looks" sub="Choose the name shown beside the logo in each portal and the colour look it uses. The logo itself stays as designed.">
    <div className="card sd-card form" style={{ marginTop: 16 }}>{PORTALS.map(([k, label]) => <div key={k} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
      <div style={{ flex: 1, minWidth: 160 }}><label className="label" style={{ marginTop: 0 }} htmlFor={`br-${k}`}>{label}: name</label><input id={`br-${k}`} className="field" maxLength={14} value={b[k].word} onChange={e => setB({ ...b, [k]: { ...b[k], word: e.target.value } })} /></div>
      <div style={{ minWidth: 150 }}><label className="label" style={{ marginTop: 0 }} htmlFor={`bl-${k}`}>Look</label><select id={`bl-${k}`} className="field" value={b[k].look} onChange={e => setB({ ...b, [k]: { ...b[k], look: e.target.value } })}>{LOOKS.map(l => <option key={l} value={l}>{l}</option>)}</select></div></div>)}
      {err && <div className="err" role="alert">{err}</div>}{note && <p role="status" className="muted">{note}</p>}<Button disabled={busy} onClick={save}>Save</Button></div></Page>;
}

/** Wording for each email: a new subject, a line before and a line after. The order details themselves are never replaced. */
export function EmailsPage() {
  const { data, reload } = useApi<any[]>('/api/admin/emails'); const [open, setOpen] = useState<string | null>(null);
  return <Page title="Emails" sub="Change the wording of the emails people receive. You can set a new subject and add a line before and after the usual message. The order details, amounts and links stay exactly as built.">
    <Rows>{(data ?? []).map(t => <div key={t.template} className="tr" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}><div className="t"><b>{t.label}</b><div>Subject now: {t.subject ?? t.standard}</div></div>{t.customised && <Chip variant="ok">Customised</Chip>}<Button size="sm" variant="ghost" aria-expanded={open === t.template} onClick={() => setOpen(open === t.template ? null : t.template)}>{open === t.template ? 'Close' : 'Edit'}</Button>
      {open === t.template && <div style={{ flexBasis: '100%' }}><EmailEditor t={t} onDone={() => { setOpen(null); reload(); }} /></div>}</div>)}</Rows></Page>;
}
function EmailEditor({ t, onDone }: { t: any; onDone: () => void }) {
  const [w, setW] = useState({ subject: t.subject ?? '', intro: t.intro ?? '', closing: t.closing ?? '' }); const [pv, setPv] = useState<{ subject: string; body: string } | null>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const body = { subject: w.subject.trim() || null, intro: w.intro, closing: w.closing };
  const preview = async () => { setErr(''); try { setPv(await api(`/api/admin/emails/${t.template}/preview`, { method: 'POST', body })); } catch (e) { setErr(fail(e)); } };
  const save = async () => { setErr(''); setBusy(true); try { await api(`/api/admin/emails/${t.template}`, { method: 'PUT', body }); onDone(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  const reset = async () => { setBusy(true); try { await api(`/api/admin/emails/${t.template}`, { method: 'DELETE' }); onDone(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  return <div className="card sd-card form" style={{ marginTop: 10 }}>
    <label className="label" style={{ marginTop: 0 }} htmlFor={`es-${t.template}`}>Subject (leave empty for the usual one)</label><input id={`es-${t.template}`} className="field" maxLength={150} value={w.subject} onChange={e => setW({ ...w, subject: e.target.value })} placeholder={t.standard} />
    <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>You can use: {t.placeholders.map((p: string) => `{${p}}`).join(' ')}</div>
    <label className="label" htmlFor={`ei-${t.template}`}>Line before the message</label><textarea id={`ei-${t.template}`} className="field" rows={2} maxLength={600} value={w.intro} onChange={e => setW({ ...w, intro: e.target.value })} />
    <label className="label" htmlFor={`ec-${t.template}`}>Line after the message</label><textarea id={`ec-${t.template}`} className="field" rows={2} maxLength={600} value={w.closing} onChange={e => setW({ ...w, closing: e.target.value })} />
    {pv && <div className="card" style={{ marginTop: 12, padding: 12, whiteSpace: 'pre-wrap' }} aria-label="Preview"><b>{pv.subject}</b><div style={{ marginTop: 8 }}>{pv.body}</div></div>}
    {err && <div className="err" role="alert">{err}</div>}<div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}><Button size="sm" variant="ghost" onClick={preview}>Preview</Button><Button size="sm" disabled={busy} onClick={save}>Save</Button>{t.customised && <Button size="sm" variant="ghost" disabled={busy} onClick={reset}>Back to the usual wording</Button>}</div></div>;
}

/** Plain pages: terms, privacy, returns and so on. Hidden until you publish them. */
export function PagesAdmin() {
  const { data, reload } = useApi<any[]>('/api/admin/pages'); const [edit, setEdit] = useState<any | null>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const start = (p?: any) => { setErr(''); setEdit(p ? { ...p, isNew: false } : { slug: '', title: '', body: '', published: false, isNew: true }); };
  const save = async (publish?: boolean) => { setErr(''); setBusy(true); try { const published = publish ?? edit.published; await api(`/api/admin/pages/${edit.slug}`, { method: 'PUT', body: { title: edit.title, body: edit.body, published } }); setEdit(null); reload(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  const del = async (slug: string) => { try { await api(`/api/admin/pages/${slug}`, { method: 'DELETE' }); reload(); } catch (e) { setErr(fail(e)); } };
  return <Page title="Pages" sub="Terms, privacy, returns and other plain pages. A page is hidden until you publish it; published pages are linked at the bottom of the shop. Start a paragraph with ## for a heading. Have a lawyer check legal pages before you publish them." actions={<Button size="sm" onClick={() => start()}>New page</Button>}>
    {err && !edit && <div className="err" role="alert">{err}</div>}
    <Rows empty="No pages yet.">{(data ?? []).map(p => <div key={p.slug} className="tr" style={{ alignItems: 'center' }}><div className="t"><b>{p.title}</b><div>/pages/{p.slug}</div></div><Chip variant={p.published ? 'ok' : 'outline'}>{p.published ? 'Published' : 'Hidden'}</Chip><Button size="sm" variant="ghost" onClick={() => start(p)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => del(p.slug)}>Delete</Button></div>)}</Rows>
    {edit && <div className="card sd-card form" style={{ marginTop: 16 }} role="group" aria-label="Edit page">
      <label className="label" style={{ marginTop: 0 }} htmlFor="pg-slug">Address (letters, numbers and dashes)</label><input id="pg-slug" className="field" disabled={!edit.isNew} value={edit.slug} onChange={e => setEdit({ ...edit, slug: e.target.value.toLowerCase() })} placeholder="privacy" />
      <label className="label" htmlFor="pg-title">Title</label><input id="pg-title" className="field" maxLength={100} value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} />
      <label className="label" htmlFor="pg-body">Text</label><textarea id="pg-body" className="field" rows={12} value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}><span>Visible to visitors</span><Switch on={edit.published} label="Visible to visitors" onChange={v => setEdit({ ...edit, published: v })} /></div>
      {err && <div className="err" role="alert">{err}</div>}<div style={{ display: 'flex', gap: 10, marginTop: 14 }}><Button disabled={busy || !edit.slug || !edit.title} onClick={() => save()}>Save</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div></div>}
  </Page>;
}
