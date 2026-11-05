import { Link, Route, Routes } from 'react-router-dom';
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

const Soon = ({ what }: { what: string }) => <main className="pad" style={{ paddingTop: 60, textAlign: 'center' }}><h1 className="serif">{what}</h1><p className="muted" style={{ marginTop: 8 }}>This part of eazystores is still being built.</p><Link to="/" className="btn" style={{ marginTop: 18 }}>Back to the shop</Link></main>;

function Routed() {
  return <Routes>
    <Route path="/_design" element={<DesignPage />} />
    <Route path="/shop/:slug" element={<ShopPage />} />
    <Route element={<BuyerLayout />}>
      <Route path="/" element={<Home />} /><Route path="/c/:slug" element={<CategoryPage />} /><Route path="/search" element={<SearchPage />} /><Route path="/p/:id" element={<ProductPage />} />
      <Route path="/basket" element={<BasketPage />} /><Route path="/checkout" element={<CheckoutPage />} /><Route path="/orders/:token" element={<OrderPage />} />
      <Route path="/saved" element={<SavedPage />} /><Route path="/account" element={<AccountPage />} />
      <Route path="/studio/*" element={<Soon what="Seller Studio" />} /><Route path="/guides" element={<Soon what="Gift guides" />} /><Route path="/makers" element={<Soon what="Meet the makers" />} />
      <Route path="*" element={<Soon what="We could not find that page" />} />
    </Route>
  </Routes>;
}
function WithSession() { const { refresh } = useCart(); return <SessionProvider onChange={() => { void refresh(); }}><Routed /></SessionProvider>; }
export default function App() { return <CartProvider><WithSession /></CartProvider>; }
