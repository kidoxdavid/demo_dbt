import { Link, Route, Routes } from 'react-router-dom';
import { Landing, Login, Signup, ForgotPassword, ResetPassword, VerifyEmail } from './pages/Auth';
import { Marketplace, ProductPage } from './pages/Market';
import { SellerShell } from './pages/Seller';
import { AdminShell } from './pages/Admin';
import { TermsPage, SellerTermsPage, PrivacyPage, RulesPage } from './pages/Legal';
import { Account, CustomerSignup } from './pages/Customer';
import { Storefront, StoreCheckout, OrderStatus } from './pages/Store';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Marketplace />} />
      <Route path="/sell" element={<Landing />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/login" element={<Login />} />
      <Route path="/forgot" element={<ForgotPassword />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/seller-terms" element={<SellerTermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/rules" element={<RulesPage />} />
      <Route path="/reset" element={<ResetPassword />} />
      <Route path="/verify" element={<VerifyEmail />} />
      <Route path="/account" element={<Account />} />
      <Route path="/account/signup" element={<CustomerSignup />} />
      <Route path="/dashboard/*" element={<SellerShell />} />
      <Route path="/admin/*" element={<AdminShell />} />
      <Route path="/store/:slug" element={<Storefront />} />
      <Route path="/store/:slug/p/:id" element={<ProductPage />} />
      <Route path="/store/:slug/checkout" element={<StoreCheckout />} />
      <Route path="/order/:token" element={<OrderStatus />} />
      <Route path="*" element={<div className="wrap"><h1>Page not found</h1><Link to="/">Go home</Link></div>} />
    </Routes>
  );
}
