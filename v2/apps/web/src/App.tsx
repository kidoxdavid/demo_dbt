import { Link, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { ProductArt } from './art/ProductArt';
import type { ArtKind, Tone } from './art/tones';
import { CartProvider, useCart } from './cart';
import { BuyerLayout } from './components/Layout';
import { DesignPage } from './design/DesignPage';
import { AccountPage } from './screens/Account';
import { BasketPage } from './screens/Basket';
import { CheckoutPage, OrderPage } from './screens/Checkout';
import { Home } from './screens/Home';
import { CategoryPage, SavedPage, SearchPage } from './screens/Listing';
import { MyMessages, MyThread } from './screens/Messages';
import { ProductPage } from './screens/Product';
import { ShopPage } from './screens/Shop';
import { SessionProvider } from './session';
import { FlagsProvider } from './flags';
import { ConsoleLayout, ConsoleLogin, ConsoleProvider } from './console/ConsoleShell';
import { AdminOverview, ModerationPage, PeoplePage, PersonPage, SellerPage, SellersPage, SettingsPage } from './console/Admin';
import { AdsAdmin, FinanceOverview, HomeEditor, Reports, SellerBalances, Synonyms } from './console/FinanceMarketing';
import { OrderSearch, OrderView, PeopleLookup, PersonView } from './console/Support';
import { AuditPage } from './console/shared';
import { AdEditor, AdsPage } from './studio/Ads';
import { NotificationsView } from './components/Notifications';
import { Unsubscribe } from './screens/Unsubscribe';
import { Dashboard } from './studio/Dashboard';
import { Inbox, InboxThread, StudioReviews } from './studio/Inbox';
import { Onboarding } from './studio/Onboarding';
import { OrderDetail, OrdersPage, StudioLogin } from './studio/Orders';
import { NewProduct, ProductEditor, ProductsPage } from './studio/Products';
import { ShippingPage, ShopSettings, Soon } from './studio/Settings';
import { StudioLayout, StudioProvider } from './studio/StudioShell';

const Later = ({ what }: { what: string }) => <main className="pad" style={{ paddingTop: 60, textAlign: 'center' }}><h1 className="serif">{what}</h1><p className="muted" style={{ marginTop: 8 }}>This part of eazystores is still being built.</p><Link to="/" className="btn" style={{ marginTop: 18 }}>Back to the shop</Link></main>;

/** Development only: one illustration filling the window. The visual tests screenshot it to upload as a real photo. */
function ArtOnly() { const { kind, tone } = useParams(); return <div style={{ width: '100vw', height: '100vh' }}><ProductArt kind={kind as ArtKind} tone={tone as Tone} /></div>; }
function Routed() {
  return <Routes>
    <Route path="/_design" element={<DesignPage />} />
    {import.meta.env.DEV && <Route path="/_art/:kind/:tone" element={<ArtOnly />} />}
    <Route path="/shop/:slug" element={<ShopPage />} />
    <Route path="/studio" element={<StudioProvider><Outlet /></StudioProvider>}>
      <Route path="login" element={<StudioLogin />} /><Route path="start" element={<Navigate to="/studio/start/1" replace />} /><Route path="start/:step" element={<Onboarding />} />
      <Route element={<StudioLayout />}><Route index element={<Dashboard />} /><Route path="orders" element={<OrdersPage />} /><Route path="orders/:id" element={<OrderDetail />} /><Route path="products" element={<ProductsPage />} /><Route path="products/new" element={<NewProduct />} /><Route path="products/:id" element={<ProductEditor />} />
        <Route path="shop" element={<ShopSettings />} /><Route path="shipping" element={<ShippingPage />} /><Route path="messages" element={<Inbox />} /><Route path="messages/:id" element={<InboxThread />} /><Route path="reviews" element={<StudioReviews />} /><Route path="notifications" element={<div className="sd-page" style={{ padding: 0 }}><NotificationsView area="studio" /></div>} /><Route path="ads" element={<AdsPage />} /><Route path="ads/:id" element={<AdEditor />} /><Route path="promotions" element={<Soon what="promotions" />} /><Route path="insights" element={<Soon what="insights" />} /><Route path="payouts" element={<Soon what="payouts" />} /></Route></Route>
    <Route path="/admin" element={<ConsoleProvider area="admin" />}><Route path="login" element={<ConsoleLogin />} /><Route element={<ConsoleLayout />}><Route index element={<AdminOverview />} /><Route path="users" element={<PeoplePage />} /><Route path="users/:id" element={<PersonPage />} /><Route path="sellers" element={<SellersPage />} /><Route path="sellers/:id" element={<SellerPage />} /><Route path="moderation" element={<ModerationPage />} /><Route path="settings" element={<SettingsPage />} /><Route path="audit" element={<AuditPage />} /></Route></Route>
    <Route path="/support" element={<ConsoleProvider area="support" />}><Route path="login" element={<ConsoleLogin />} /><Route element={<ConsoleLayout />}><Route index element={<OrderSearch />} /><Route path="orders/:id" element={<OrderView />} /><Route path="users" element={<PeopleLookup />} /><Route path="users/:id" element={<PersonView />} /><Route path="audit" element={<AuditPage />} /></Route></Route>
    <Route path="/finance" element={<ConsoleProvider area="finance" />}><Route path="login" element={<ConsoleLogin />} /><Route element={<ConsoleLayout />}><Route index element={<FinanceOverview />} /><Route path="sellers" element={<SellerBalances />} /><Route path="orders" element={<OrderSearch />} /><Route path="orders/:id" element={<OrderView />} /><Route path="reports" element={<Reports />} /><Route path="audit" element={<AuditPage />} /></Route></Route>
    <Route path="/marketing" element={<ConsoleProvider area="marketing" />}><Route path="login" element={<ConsoleLogin />} /><Route element={<ConsoleLayout />}><Route index element={<HomeEditor />} /><Route path="ads" element={<AdsAdmin />} /><Route path="synonyms" element={<Synonyms />} /></Route></Route>
    <Route element={<BuyerLayout />}>
      <Route path="/" element={<Home />} /><Route path="/c/:slug" element={<CategoryPage />} /><Route path="/search" element={<SearchPage />} /><Route path="/p/:id" element={<ProductPage />} />
      <Route path="/basket" element={<BasketPage />} /><Route path="/checkout" element={<CheckoutPage />} /><Route path="/orders/:token" element={<OrderPage />} />
      <Route path="/saved" element={<SavedPage />} /><Route path="/account" element={<AccountPage />} /><Route path="/account/notifications" element={<div className="screen pad" style={{ paddingTop: 10 }}><NotificationsView area="me" /></div>} /><Route path="/account/messages" element={<MyMessages />} /><Route path="/unsubscribe" element={<Unsubscribe />} /><Route path="/account/messages/:id" element={<MyThread />} />
      <Route path="/guides" element={<Later what="Gift guides" />} /><Route path="/makers" element={<Later what="Meet the makers" />} />
      <Route path="*" element={<Later what="We could not find that page" />} />
    </Route>
  </Routes>;
}
function WithSession() { const { refresh } = useCart(); return <SessionProvider onChange={() => { void refresh(); }}><FlagsProvider><Routed /></FlagsProvider></SessionProvider>; }
export default function App() { return <CartProvider><WithSession /></CartProvider>; }
