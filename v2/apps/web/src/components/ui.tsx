import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { ProductArt } from '../art/ProductArt';
import type { ArtKind, Tone } from '../art/tones';

export const Wordmark = ({ studio, large, word }: { studio?: boolean; large?: boolean; word?: string }) => <span className={`logo${large ? ' lg' : ''}`}>eazy<b>{word ?? (studio ? 'studio' : 'stores')}</b></span>;
export const Chip = ({ children, variant = '' }: { children: ReactNode; variant?: '' | 'surf' | 'outline' | 'ok' }) => <span className={`chip ${variant}`.trim()}>{children}</span>;
export const Stars = ({ n = 5 }: { n?: number }) => <span className="stars" aria-hidden="true">{'★'.repeat(n)}</span>;

export function Button({ children, variant = '', size = '', block, to, onClick, type = 'button', style, className = '', ...rest }: { children: ReactNode; variant?: '' | 'ghost'; size?: '' | 'sm'; block?: boolean; to?: string; onClick?: () => void; type?: 'button' | 'submit'; style?: CSSProperties } & Record<string, unknown>) {
  const cls = `btn ${variant} ${size} ${block ? 'block' : ''} ${className as string}`.replace(/\s+/g, ' ').trim();
  return to ? <Link className={cls} to={to} style={style} {...rest}>{children}</Link> : <button type={type} className={cls} onClick={onClick} style={style} {...rest}>{children}</button>;
}

export function SearchField({ placeholder, large }: { placeholder: string; large?: boolean }) {
  return <div className={`card search${large ? ' lg' : ''}`} role="search"><span className="muted"><Icon name="search" /></span><span className="muted" style={{ fontSize: 14 }}>{placeholder}</span></div>;
}
export function Pills({ items, selected = 0, filter }: { items: string[]; selected?: number; filter?: boolean }) {
  return <div className="pills">{items.map((c, i) => <span key={c} className={`pill${!filter && i === selected ? ' on' : ''}${filter ? ' filter' : ''}`}>{c}{filter ? ' ⌄' : ''}</span>)}</div>;
}

export interface CardData { id: string; title: string; seller: string; price: string; was?: string; chip?: string; art?: { kind: ArtKind; tone: Tone }; photo?: string; href?: string; soldOut?: boolean; heart?: { on: boolean; toggle: () => void } }
/** Every card is the same size. Only the heart and an optional chip ever sit on the image. */
export function ProductCard({ p }: { p: CardData }) {
  const h = p.heart;
  const body = <>
    <div className="im">{p.photo ? <img src={p.photo} alt="" loading="lazy" /> : p.art ? <ProductArt kind={p.art.kind} tone={p.art.tone} /> : null}
      {h ? <button type="button" className={`heart${h.on ? ' on' : ''}`} aria-label={h.on ? 'Remove from saved' : 'Save'} aria-pressed={h.on} onClick={e => { e.preventDefault(); e.stopPropagation(); h.toggle(); }}><Icon name="heart" /></button> : <span className="heart" aria-hidden="true"><Icon name="heart" /></span>}
      {p.chip && <span className="chip tag">{p.chip}</span>}</div>
    <h4>{p.title}</h4><div className="by">{p.seller}</div><div className="pr">{p.soldOut ? <span className="muted">Sold out</span> : <>{p.price}{p.was && <s>{p.was}</s>}</>}</div></>;
  return p.href ? <Link className={`pcard${p.soldOut ? ' soldout' : ''}`} to={p.href}>{body}</Link> : <div className="pcard">{body}</div>;
}

export type TabItem = { icon: IconName; label: string; to: string };
export function TabBar({ items, active }: { items: TabItem[]; active: number }) {
  return <nav className="tabbar" aria-label="Main">{items.map((t, i) => <Link key={t.label} to={t.to} className={i === active ? 'on' : ''} aria-current={i === active ? 'page' : undefined}><Icon name={t.icon} /><span>{t.label}</span></Link>)}</nav>;
}
export const BUYER_TABS: TabItem[] = [{ icon: 'home', label: 'Shop', to: '/' }, { icon: 'grid', label: 'Browse', to: '/c/pottery-ceramics' }, { icon: 'heart', label: 'Saved', to: '/saved' }, { icon: 'bag', label: 'Basket', to: '/basket' }, { icon: 'user', label: 'Account', to: '/account' }];
export const STUDIO_TABS: TabItem[] = [{ icon: 'home', label: 'Home', to: '/studio' }, { icon: 'box', label: 'Orders', to: '/studio/orders' }, { icon: 'tag', label: 'Products', to: '/studio/products' }, { icon: 'msg', label: 'Messages', to: '/studio/messages' }, { icon: 'chart', label: 'Insights', to: '/studio/insights' }];

export function Progress({ step, total = 5, left }: { step: number; total?: number; left?: string }) {
  return <div className="pad" style={{ paddingTop: 4 }}><div className="progress" role="progressbar" aria-label={`Step ${step} of ${total}`} aria-valuemin={1} aria-valuemax={total} aria-valuenow={step}>{Array.from({ length: total }, (_, i) => <i key={i} className={i < step ? 'on' : ''} />)}</div>
    <div className="progress-cap"><span>Step {step} of {total}</span><span>{left}</span></div></div>;
}
export const StickyBar = ({ children, gradient }: { children: ReactNode; gradient?: boolean }) => <div className={`stickybar${gradient ? ' gradient' : ''}`}>{children}</div>;
export const SectionHead = ({ title, action }: { title: string; action?: string }) => <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}><div className="serif" style={{ fontSize: 22 }}>{title}</div>{action && <span className="muted" style={{ fontSize: 13 }}>{action}</span>}</div>;
