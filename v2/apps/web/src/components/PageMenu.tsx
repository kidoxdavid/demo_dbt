import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { useDesktop } from '../hooks';

const LINKS: [IconName, string, string][] = [['home', 'Shop', '/'], ['grid', 'Browse', '/c/pottery-ceramics'], ['store', 'Meet the makers', '/makers'], ['tag', 'Gift guides', '/guides'], ['heart', 'Saved', '/saved'], ['bag', 'Basket', '/basket'], ['user', 'Account', '/account']];
/**
 * A round Menu button in the corner of pages that have no tab bar (basket, product, store). It opens a sheet with every place a shopper might want to go,
 * so Back is never the only way out. Phones only: laptops already have the site header.
 */
export function PageMenu() {
  const desktop = useDesktop(); const [open, setOpen] = useState(false); const { pathname } = useLocation();
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => { if (!open) return; const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc); }, [open]);
  if (desktop) return null;
  return <>
    <button type="button" className="pagemenu" aria-label="Menu" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
    {open && <div className="sheet-scrim" onClick={() => setOpen(false)}><div className="sheet" role="dialog" aria-label="Menu" onClick={e => e.stopPropagation()}>
      <nav aria-label="Shop sections" className="menulist">{LINKS.map(([icon, label, to]) => <Link key={label} to={to} onClick={() => setOpen(false)}><Icon name={icon} />{label}</Link>)}</nav>
      <button type="button" className="btn ghost" style={{ width: '100%', marginTop: 10, minHeight: 48 }} onClick={() => setOpen(false)}>Close</button></div></div>}
  </>;
}
