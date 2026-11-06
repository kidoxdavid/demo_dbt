import { useEffect, useState } from 'react';
import { api, useApi } from '../api';
import { Button, Chip } from '../components/ui';
import { Page, Switch, fail } from './shared';

interface Perm { key: string; group: string; label: string; on: boolean; locked: boolean; isDefault: boolean }
interface Area { area: string; label: string; on: boolean; locked: boolean }
interface RoleView { role: string; label: string; editable: boolean; kind: 'staff' | 'maker'; areas: Area[]; permissions: Perm[] }

function RoleCard({ r, onSaved }: { r: RoleView; onSaved: () => void }) {
  const [perms, setPerms] = useState<Record<string, boolean>>({}); const [areas, setAreas] = useState<Record<string, boolean>>({}); const [open, setOpen] = useState(false); const [err, setErr] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { setPerms(Object.fromEntries(r.permissions.map(p => [p.key, p.on]))); setAreas(Object.fromEntries(r.areas.map(a => [a.area, a.on]))); }, [r]);
  const changed = r.permissions.some(p => perms[p.key] !== p.on) || r.areas.some(a => areas[a.area] !== a.on);
  const save = async () => { setErr(''); setNote(''); setBusy(true); try { await api(`/api/admin/roles/${r.role}`, { method: 'PUT', body: { permissions: Object.keys(perms).filter(k => perms[k]), areas: Object.keys(areas).filter(k => areas[k]) } }); setNote('Saved. It applies to everyone with this role straight away.'); onSaved(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  const reset = async () => { setErr(''); setNote(''); setBusy(true); try { await api(`/api/admin/roles/${r.role}`, { method: 'DELETE' }); setNote('Back to the default.'); onSaved(); } catch (e) { setErr(fail(e)); } finally { setBusy(false); } };
  const groups = [...new Set(r.permissions.map(p => p.group))];
  const count = r.permissions.filter(p => p.on).length;
  return <div className="card sd-card" style={{ marginTop: 14 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}><b style={{ fontSize: 17 }}>{r.label}</b>{!r.editable && <Chip variant="outline">Fixed</Chip>}<span className="muted">{count} of {r.permissions.length} permissions{r.areas.length ? ` · ${r.areas.filter(a => a.on).map(a => a.label.replace(' console', '')).join(', ') || 'no consoles'}` : ''}</span>
      <span style={{ marginLeft: 'auto' }}><Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : r.editable ? 'Edit' : 'View'}</Button></span></div>
    {open && <div style={{ marginTop: 12 }}>
      {r.areas.length > 0 && <><h3 style={{ fontSize: 14, margin: '8px 0' }} className="muted">Can sign in to</h3>{r.areas.map(a => <div key={a.area} className="tr" style={{ alignItems: 'center' }}><div className="t">{a.label}</div><Switch on={!!areas[a.area]} label={`${r.label} can sign in to the ${a.label}`} onChange={v => !a.locked && r.editable && setAreas({ ...areas, [a.area]: v })} /></div>)}</>}
      {groups.map(g => <div key={g}><h3 style={{ fontSize: 14, margin: '14px 0 4px' }} className="muted">{g}</h3>{r.permissions.filter(p => p.group === g).map(p => <div key={p.key} className="tr" style={{ alignItems: 'center', opacity: !r.editable || p.locked ? 0.7 : 1 }}><div className="t">{p.label}{p.locked && r.editable ? ' (admin only)' : ''}</div><Switch on={!!perms[p.key]} label={`${r.label}: ${p.label}`} onChange={v => r.editable && !p.locked && setPerms({ ...perms, [p.key]: v })} /></div>)}</div>)}
      {err && <div className="err" role="alert">{err}</div>}{note && <p role="status" className="muted">{note}</p>}
      {r.editable && <div style={{ display: 'flex', gap: 10, marginTop: 14 }}><Button size="sm" disabled={busy || !changed} onClick={save}>Save changes</Button><Button size="sm" variant="ghost" disabled={busy} onClick={reset}>Back to default</Button></div>}
    </div>}
  </div>;
}

/** What each role may do and which consoles it may enter. Admin always has everything, so nobody can lock the platform. */
export function RolesPage() {
  const { data, reload } = useApi<{ roles: RoleView[] }>('/api/admin/roles');
  return <Page title="Roles and access" sub="Choose what each kind of staff member and each maker team role can do. Changes apply straight away and are written to the audit log. Admin always keeps full access.">
    {(data?.roles ?? []).filter(r => r.kind === 'staff').length > 0 && <h2 className="serif" style={{ fontSize: 20, marginTop: 20 }}>Staff</h2>}
    {(data?.roles ?? []).filter(r => r.kind === 'staff').map(r => <RoleCard key={r.role} r={r} onSaved={reload} />)}
    <h2 className="serif" style={{ fontSize: 20, marginTop: 28 }}>Maker teams</h2>
    {(data?.roles ?? []).filter(r => r.kind === 'maker').map(r => <RoleCard key={r.role} r={r} onSaved={reload} />)}
  </Page>;
}
