import { ProductArt } from '../art/ProductArt';
import { SHAPES } from '../art/shapes';
import { TONES, type ArtKind, type Tone } from '../art/tones';
import { ICONS } from '../components/iconPaths';
import { Icon, type IconName } from '../components/Icon';
import { BUYER_TABS, Button, Chip, Pills, ProductCard, Progress, SearchField, StickyBar, Stars, TabBar, Wordmark } from '../components/ui';
import { CATEGORY_PILLS, HOME_CARDS } from './fixtures';

const THEMES: { id: string; name: string; note?: string }[] = [
  { id: 'atelier', name: 'Atelier (default)' }, { id: 'noir', name: 'Noir' }, { id: 'sage', name: 'Sage' },
  { id: 'blush', name: 'Blush', note: 'defined, not mocked' }, { id: 'sky', name: 'Sky', note: 'defined, not mocked' }];
const TOKENS = ['bg', 'surf', 'ink', 'mut', 'line', 'acc', 'accsoft', 'onacc'];

function Block({ title, children }: { title: string; children: React.ReactNode }) { return <section className="dz-block"><h3 className="dz-h">{title}</h3>{children}</section>; }

function ThemePanel({ id, name, note }: { id: string; name: string; note?: string }) {
  return <div className="dz-panel" data-theme={id} data-testid={`panel-${id}`}>
    <div className="dz-panel-head"><Wordmark /><span className="serif" style={{ fontSize: 22 }}>{name}</span>{note && <Chip variant="outline">{note}</Chip>}</div>
    <Block title="Colour tokens"><div className="dz-swatches">{TOKENS.map(t => <div key={t}><i style={{ background: `var(--${t})` }} /><span>--{t}</span></div>)}</div></Block>
    <Block title="Type"><div className="serif" style={{ fontSize: 34 }}>Made by hand. Chosen with care.</div><div className="serif" style={{ fontSize: 22, marginTop: 6 }}>New from makers</div><p style={{ fontSize: 14, marginTop: 6 }}>Body text, Inter 14. Plain language, no jargon.</p><p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Secondary text, Inter 12.</p></Block>
    <Block title="Buttons and chips"><div className="dz-row"><Button>Primary</Button><Button size="sm">Small</Button><Button variant="ghost">Ghost</Button><Chip>New season</Chip><Chip variant="surf">Surface</Chip><Chip variant="outline">Outline</Chip><Chip variant="ok">Shipped</Chip></div></Block>
    <Block title="Search and pills"><div style={{ maxWidth: 360 }}><SearchField placeholder="Search pottery, art, perfume…" /></div><div style={{ marginTop: 12, maxWidth: 380 }}><Pills items={CATEGORY_PILLS.slice(0, 5)} /></div><div style={{ marginTop: 10, maxWidth: 380 }}><Pills items={['Price', 'Material', 'Size']} filter /></div></Block>
    <Block title="Product cards"><div className="dz-cards">{HOME_CARDS.slice(0, 2).map(c => <ProductCard key={c.id} p={c} />)}</div></Block>
    <Block title="Glass tab bar, progress, sticky bar"><div className="dz-frame"><TabBar items={BUYER_TABS} active={0} /></div>
      <div style={{ marginTop: 14, maxWidth: 360 }}><Progress step={2} left="About 7 min left" /></div>
      <div className="dz-frame sm"><StickyBar><div className="muted" style={{ fontSize: 12 }}>Total<div style={{ fontWeight: 600, fontSize: 18, color: 'var(--ink)' }}>$48.00</div></div><Button block>Add to basket</Button></StickyBar></div></Block>
    <Block title="Studio cards"><div className="dz-row" style={{ alignItems: 'stretch' }}><div className="card task" style={{ maxWidth: 220 }}><div className="serif n">3</div><b>Orders to ship</b><p>Ship by tomorrow to stay on time</p><Button size="sm" style={{ marginTop: 14 }}>Open orders</Button></div>
      <div className="card" style={{ padding: '10px 18px', minWidth: 220 }}><div className="check done"><i>✓</i><span>Create your shop</span></div><div className="check"><i /><span>Set up payouts</span></div></div></div>
      <div className="card" style={{ padding: '0 16px', marginTop: 12, maxWidth: 520 }}><div className="orderrow" style={{ borderTop: 0 }}><div style={{ width: 44, height: 44, borderRadius: 10, overflow: 'hidden', flex: 'none' }}><ProductArt kind="pottery" tone="blush" /></div><div style={{ flex: 1 }}><b style={{ fontWeight: 500 }}>Tall bud vase, Medium</b><div className="muted" style={{ fontSize: 12 }}>Maya R. · Edmonton · 10 min ago</div></div><b>$57.00</b><Chip>Ship today</Chip></div></div></Block>
    <Block title="Rating"><span style={{ fontSize: 13 }}><Stars /> 4.9 (128)</span></Block>
  </div>;
}

export function DesignPage() {
  return <main className="dz">
    <header className="dz-top"><Wordmark large /><h1 className="serif" style={{ fontSize: 34 }}>Design system</h1><p className="muted" style={{ fontSize: 14, maxWidth: 640 }}>Every shared component in every look. Atelier, Noir and Sage match the approved mockups. Blush and Sky are defined by derivation and have no mockup.</p></header>
    {THEMES.map(t => <ThemePanel key={t.id} {...t} />)}
    <div className="dz-panel" data-theme="atelier">
      <Block title="Icons (approved set, 24px viewBox, stroke 1.6)"><div className="dz-icons">{Object.keys(ICONS).map(k => <div key={k}><Icon name={k as IconName} size={28} /><span>{k}</span></div>)}</div></Block>
      <Block title="Product art (placeholders for photos)"><div className="dz-art">{(Object.keys(SHAPES) as ArtKind[]).map(k => <div key={k}><ProductArt kind={k} tone={(Object.keys(TONES) as Tone[])[(k.length) % 7]} /><span>{k}</span></div>)}</div></Block>
      <Block title="Not mocked: built from the same tokens, listed here for review"><ul className="dz-list">
        <li>Hover, focus (accent outline) and pressed states for every control</li><li>Loading skeletons (neutral line tone, no spinners) and empty states</li><li>Error messages and form validation</li><li>Dialogs, sheets and toasts</li>
        <li>Tables that become cards on phones (orders, products, payouts)</li><li>Admin, support, finance and marketing consoles (plain and dense, same tokens)</li><li>Blush and Sky shop looks (tokens derived, no mockup)</li><li>Dark mode switching is automatic from the system setting for Atelier and Sage</li></ul></Block>
    </div>
  </main>;
}
