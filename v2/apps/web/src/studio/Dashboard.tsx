import { Link } from 'react-router-dom';
import { useApi } from '../api';
import { ProductArt } from '../art/ProductArt';
import type { ArtKind, Tone } from '../art/tones';
import { Icon } from '../components/Icon';
import { Button, Chip, Wordmark } from '../components/ui';
import { dateRange, money } from '../format';
import { useDesktop } from '../hooks';
import { useStudio } from './StudioShell';

interface Dash {
  firstName: string; shop: { name: string; slug: string };
  tasks: { ordersToShip: number; shipBy: string | null; messagesToAnswer: number | null; lowStock: { productId: string; title: string; variant: string | null; left: number }[] };
  week: { salesCents: number; orders: number; visits: number; changePct: number | null; daily: { day: string; cents: number }[] };
  checklist: { key: string; label: string; done: boolean }[];
  recent: { id: string; number: number; title: string; variant: string | null; shipBy: string | null; qty: number; buyerName: string; city: string; createdAt: string; salesCents: number; status: string; art: { kind: ArtKind; tone: Tone } | null; image: string | null }[];
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d: Date) => `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const greeting = (d: Date) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');
export function ago(iso: string, now = new Date()) {
  const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60000); if (m < 1) return 'Just now'; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24 && new Date(iso).getDate() === now.getDate()) return `${h} hr ago`;
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(new Date(iso).getFullYear(), new Date(iso).getMonth(), new Date(iso).getDate()).getTime()) / 86400000); return days <= 1 ? 'Yesterday' : `${days} days ago`;
}
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
const sales = (c: number) => `$${Math.round(c / 100).toLocaleString('en-CA')}`;
const today = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

function Spark({ daily, h, vb }: { daily: Dash['week']['daily']; h: number; vb: number }) {
  const max = Math.max(1, ...daily.map(d => d.cents)); const top = 8, bottom = vb - 4; const pts = daily.map((d, i) => [(i / Math.max(1, daily.length - 1)) * 300, bottom - (d.cents / max) * (bottom - top)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(0)} ${p[1].toFixed(0)}`).join(' ');
  return <svg viewBox={`0 0 300 ${vb}`} style={{ width: '100%', height: h }} role="img" aria-label="Sales over the last seven days"><path d={line} fill="none" stroke="var(--acc)" strokeWidth="3" strokeLinecap="round" /><path d={`${line} L300 ${vb} L0 ${vb}Z`} fill="var(--acc)" opacity=".08" /></svg>;
}
const Thumb = ({ o }: { o: Dash['recent'][number] }) => (o.image ? <img src={o.image} alt="" /> : o.art ? <ProductArt kind={o.art.kind} tone={o.art.tone} /> : null);
function statusChip(o: Dash['recent'][number], now: Date) {
  if (o.status === 'shipped') return <Chip variant="ok">Shipped</Chip>; if (o.status === 'delivered') return <Chip variant="ok">Delivered</Chip>; if (o.status === 'cancelled') return <Chip variant="outline">Cancelled</Chip>;
  const due = o.shipBy && o.shipBy.slice(0, 10) <= today(now); return <Chip>{o.status === 'accepted' ? 'Accepted' : due ? 'Ship today' : 'To ship'}</Chip>;
}
const rowTitle = (o: Dash['recent'][number]) => `${o.title}${o.qty > 1 ? ` ×${o.qty}` : o.variant ? `, ${o.variant}` : ''}`;
const shipHint = (t: Dash['tasks'], now: Date) => { if (!t.ordersToShip) return 'You are all caught up'; const d = (t.shipBy ?? '').slice(0, 10); const tm = new Date(now.getTime() + 86400000); return d <= today(now) ? 'Ship today to stay on time' : d === today(tm) ? 'Ship by tomorrow to stay on time' : `Next ship-by date: ${dateRange(d, d)}`; };
const lowText = (t: Dash['tasks']) => { const l = t.lowStock[0]; return l ? `${l.title}${l.variant ? ` · ${l.variant}` : ''} · ${l.left} left` : 'Nothing is running low'; };
const shortName = (n: string) => n.replace(/ (\w)\w*$/, ' $1.');

/** Studio home. Matches reference studio-desktop.png and studio-phone.png. */
export function Dashboard() {
  const desktop = useDesktop(); const { data: d } = useApi<Dash>('/api/studio/dashboard'); const { shop, user } = useStudio(); const now = new Date();
  if (!d || !shop) return <div className="pad" style={{ paddingTop: 30 }}><div className="skeleton" style={{ height: 300 }} /></div>;
  const done = d.checklist.filter(c => c.done).length; const next = d.checklist.find(c => !c.done);
  const change = d.week.changePct === null ? null : `${d.week.changePct >= 0 ? '+' : ''}${d.week.changePct}%`;
  if (!desktop) return <div>
    <div className="pad sp-top"><Wordmark studio /><span className="av" aria-hidden="true">{(user?.fullName ?? d.firstName).split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}</span></div>
    <div className="pad" style={{ marginTop: 16 }}><div className="muted" style={{ fontSize: 13 }}>{DAYS[now.getDay()]}</div><div className="serif" style={{ fontSize: 30 }}>{greeting(now)}, {d.firstName}</div>
      <div className="sp-cards"><div className="card task ph"><div className="n serif">{d.tasks.ordersToShip}</div><b>Orders to ship</b><Button size="sm" to="/studio/orders">Open</Button></div>
        <div className="card task ph"><div className="n serif">{d.tasks.messagesToAnswer ?? 0}</div><b>Messages</b><Button size="sm" to="/studio/messages">Reply</Button></div></div>
      <div className="card sp-week"><div className="muted" style={{ fontSize: 12 }}>This week</div><div className="big"><div className="serif">{sales(d.week.salesCents)}</div>{change && <b className="up" style={{ fontSize: 13 }}>{change}</b>}</div><Spark daily={d.week.daily} h={56} vb={70} /></div>
      <div className="card sp-week"><b style={{ fontSize: 14 }}>Finish setting up</b><div className="bar6"><i style={{ width: `${(done / d.checklist.length) * 100}%` }} /></div><div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{done} of {d.checklist.length} done{next ? ` · Next: ${next.label.charAt(0).toLowerCase()}${next.label.slice(1)}` : ''}</div></div>
    </div></div>;
  return <div>
    <div className="sd-top"><div><div className="date">{longDate(now)}</div><h1 className="serif">{greeting(now)}, {d.firstName}</h1></div>
      <div className="acts"><Button variant="ghost" size="sm" to={`/shop/${shop.slug}`}>View my shop</Button><Button size="sm" to="/studio/products/new"><Icon name="plus" /> Add product</Button></div></div>
    <div className="sd-tasks">
      <div className="card task"><div className="n serif">{d.tasks.ordersToShip}</div><b>Orders to ship</b><p>{shipHint(d.tasks, now)}</p><Button size="sm" to="/studio/orders">Open orders</Button></div>
      <div className="card task"><div className="n serif">{d.tasks.messagesToAnswer ?? 0}</div><b>Messages to answer</b><p>{(d.tasks.messagesToAnswer ?? 0) > 0 ? 'Buyers are waiting for a reply' : 'You are all caught up'}</p><Button size="sm" to="/studio/messages">Reply</Button></div>
      <div className="card task"><div className="n serif">{d.tasks.lowStock.length}</div><b>Running low</b><p>{lowText(d.tasks)}</p><Button size="sm" to={d.tasks.lowStock[0] ? `/studio/products/${d.tasks.lowStock[0].productId}` : '/studio/products'}>Restock</Button></div></div>
    <div className="sd-row"><div className="card sd-card" style={{ flex: 1.5 }}><div className="hd"><b>This week</b><span>{change ? <>vs last week <b className="up">{change}</b></> : 'First week'}</span></div>
      <div className="stat"><div><div className="n serif">{sales(d.week.salesCents)}</div><div className="l">Sales</div></div><div><div className="n serif">{d.week.orders}</div><div className="l">Orders</div></div><div><div className="n serif">{k(d.week.visits)}</div><div className="l">Shop visits</div></div></div><Spark daily={d.week.daily} h={80} vb={80} /></div>
      <div className="card sd-card" style={{ flex: 1 }}><b>Finish setting up</b><div className="muted" style={{ fontSize: 13, margin: '2px 0 10px' }}>{done} of {d.checklist.length} done</div>
        {d.checklist.map(c => <div key={c.key} className={`check${c.done ? ' done' : ''}`}><i>{c.done ? '✓' : ''}</i><span>{c.label}</span></div>)}</div></div>
    <div className="card sd-recent"><div className="hd"><b>Recent orders</b><Link to="/studio/orders"><span>See all</span></Link></div>
      {d.recent.length === 0 ? <p className="muted" style={{ fontSize: 14, padding: '14px 0 4px' }}>Orders will show up here as soon as someone buys.</p> : d.recent.map(o => <Link key={o.id} to={`/studio/orders/${o.id}`} className="orderrow orow"><div className="th"><Thumb o={o} /></div><div className="t"><b>{rowTitle(o)}</b><div>{shortName(o.buyerName)} · {o.city} · {ago(o.createdAt, now)}</div></div><b>{money(o.salesCents)}</b>{statusChip(o, now)}</Link>)}</div></div>;
}
