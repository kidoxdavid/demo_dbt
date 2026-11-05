import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { BUYER_TABS, Button, Chip, Pills, ProductCard, SearchField, SectionHead, TabBar, Wordmark } from '../components/ui';
import { ProductArt } from '../art/ProductArt';
import { CATEGORY_PILLS, HOME_CARDS } from '../design/fixtures';

/** Buyer home on a phone. Matches design/eazystores/reference/buyer-home.png. */
export function BuyerHome() {
  return <div className="screen">
    <div className="pad home-top"><Wordmark /><span style={{ flex: 1 }} /><Icon name="heart" /><Icon name="bag" /></div>
    <div className="pad" style={{ marginTop: 12 }}><SearchField placeholder="Search pottery, art, perfume…" /></div>
    <div className="pad" style={{ marginTop: 14 }}><Pills items={CATEGORY_PILLS} /></div>
    <div className="pad" style={{ marginTop: 16 }}>
      <div className="hero"><Chip variant="surf">New season</Chip>
        <h1 className="serif">Made by hand.<br />Chosen with care.</h1>
        <Button size="sm" style={{ marginTop: 16 }} to="/c/pottery-ceramics">Shop new arrivals</Button>
        <div className="tile" style={{ right: -18, bottom: -14, width: 170, height: 170, borderRadius: 20, transform: 'rotate(6deg)' }}><ProductArt kind="pottery" tone="blush" /></div>
        <div className="tile" style={{ right: 112, bottom: -30, width: 120, height: 120, borderRadius: 18, transform: 'rotate(-7deg)' }}><ProductArt kind="perfume" tone="butter" /></div></div></div>
    <div className="pad" style={{ marginTop: 22 }}>
      <SectionHead title="New from makers" action="See all" />
      <div className="grid2">{HOME_CARDS.map(c => <ProductCard key={c.id} p={c} />)}</div>
      <div style={{ marginTop: 20 }}><Link to="/shop/clay-ember" className="card spotlight"><div className="round64"><ProductArt kind="pottery" tone="warm" /></div>
        <div style={{ flex: 1 }}><div className="muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>Maker spotlight</div><div className="serif" style={{ fontSize: 18, marginTop: 2 }}>Clay &amp; Ember</div><div className="muted" style={{ fontSize: 12, marginTop: 2 }}>Wheel-thrown stoneware, Calgary</div></div><Icon name="chev" /></Link></div></div>
    <TabBar items={BUYER_TABS} active={0} />
  </div>;
}
