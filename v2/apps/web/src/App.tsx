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
import { ProductPage } from './screens/Product';
import { ShopPage } from './screens/Shop';
import { SessionProvider } from './session';
import { Dashboard } from './studio/Dashboard';
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
        <Route path="shop" element={<ShopSettings />} /><Route path="shipping" element={<ShippingPage />} /><Route path="messages" element={<Soon what="messages" />} /><Route path="promotions" element={<Soon what="promotions" />} /><Route path="insights" element={<Soon what="insights" />} /><Route path="payouts" element={<Soon what="payouts" />} /></Route></Route>
    <Route element={<BuyerLayout />}>
      <Route path="/" element={<Home />} /><Route path="/c/:slug" element={<CategoryPage />} /><Route path="/search" element={<SearchPage />} /><Route path="/p/:id" element={<ProductPage />} />
      <Route path="/basket" element={<BasketPage />} /><Route path="/checkout" element={<CheckoutPage />} /><Route path="/orders/:token" element={<OrderPage />} />
      <Route path="/saved" element={<SavedPage />} /><Route path="/account" element={<AccountPage />} />
      <Route path="/guides" element={<Later what="Gift guides" />} /><Route path="/makers" element={<Later what="Meet the makers" />} />
      <Route path="*" element={<Later what="We could not find that page" />} />
    </Route>
  </Routes>;
}
function WithSession() { const { refresh } = useCart(); return <SessionProvider onChange={() => { void refresh(); }}><Routed /></SessionProvider>; }
export default function App() { return <CartProvider><WithSession /></CartProvider>; }
