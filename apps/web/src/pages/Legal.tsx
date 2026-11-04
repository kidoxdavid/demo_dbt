import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Header } from './Auth';
import { usePub } from './Store';

/** DRAFT policy pages. They set out the structure and the main points, but they are NOT legal advice and must be reviewed and completed by a qualified Canadian lawyer before launch. */
function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  usePub();
  return <>
    <Header />
    <main className="wrap legal">
      <div className="draftbar" role="note"><b>Draft for legal review.</b> This page is a working draft written by the product team. It is not legal advice and has not been reviewed by a lawyer. Items in [square brackets] still need real decisions.</div>
      <h1>{title}</h1>
      {children}
      <p className="muted small" style={{ marginTop: 40 }}><Link to="/terms">Terms of use</Link> · <Link to="/seller-terms">Seller agreement</Link> · <Link to="/privacy">Privacy policy</Link> · <Link to="/rules">Prohibited items</Link></p>
    </main>
  </>;
}

export const TermsPage = () => <LegalShell title="Terms of use (shoppers)">
  <h2>What EazyStores is</h2><p>EazyStores is a platform where independent businesses ("sellers") run their own online stores. When you buy, you buy from the seller, not from EazyStores. The seller is responsible for the product, its description, delivery and returns.</p>
  <h2>Your order</h2><p>Prices are shown in Canadian dollars. Tax is added at checkout where the seller is registered to collect it. An order is confirmed when payment succeeds and you receive a confirmation email. Made-to-order items are produced after you order, so allow extra time.</p>
  <h2>Returns and refunds</h2><p>Each seller decides its return policy within the law. Refunds go back to the original payment method. If you have a problem, contact the seller first; [EazyStores dispute process to be defined].</p>
  <h2>Your account and conduct</h2><p>Keep your details accurate. Do not misuse the service, attempt to access other people's data, or upload content you have no right to share.</p>
  <h2>Limits of liability and governing law</h2><p>[To be written by counsel: limitation of liability, governing law and jurisdiction (Alberta, Canada), consumer-protection carve-outs, changes to these terms.]</p>
  <h2>Contact</h2><p>[Company legal name and contact email.]</p>
</LegalShell>;

export const SellerTermsPage = () => <LegalShell title="Seller agreement">
  <h2>Your business, your responsibility</h2><p>You are the seller. You are responsible for the accuracy of your listings, the quality and legality of what you sell, delivering orders, honouring your stated policies, and handling returns.</p>
  <h2>Taxes</h2><p>You are responsible for deciding whether you must register for and collect GST/HST and provincial taxes, and for reporting and remitting them. EazyStores calculates tax from the rates it holds and the registrations you tell us about; it does not give tax advice and does not remit tax for you.</p>
  <h2>Fees and payouts</h2><p>[Fee schedule, payment processing fees, payout timing, reserves, and refund and chargeback liability: to be set once the payment provider is chosen. Every fee will be shown before you pay it.]</p>
  <h2>What you may sell</h2><p>You must follow the <Link to="/rules">prohibited items policy</Link>. EazyStores may review stores before they go live, remove listings, and suspend accounts that break the rules or the law. Each such action is recorded with a reason.</p>
  <h2>Customer data</h2><p>You may use customers' personal information only to fulfil their orders and answer their questions. You must not sell it, or use it for marketing without their consent.</p>
  <h2>Verification badge</h2><p>A "Verified" badge means EazyStores staff reviewed the registration details you submitted and found them consistent. It is never sold or included in a plan, and it is not a guarantee about your products.</p>
  <h2>Closing your account</h2><p>You can close your account once your open orders are finished. Your personal details and product photos are removed; order, refund and tax records are kept for [retention period to be set by counsel].</p>
  <h2>Liability, disputes, changes</h2><p>[To be written by counsel.]</p>
</LegalShell>;

export const PrivacyPage = () => <LegalShell title="Privacy policy">
  <h2>What we collect</h2>
  <ul><li><b>Sellers:</b> name, email, business details, tax registration details you provide, and store content.</li>
    <li><b>Shoppers:</b> name, email, delivery address and order details, plus any text or photos you add to a customised item.</li>
    <li><b>Technical:</b> a sign-in cookie for sellers and staff, and your cart saved in your browser. We do not run advertising trackers.</li></ul>
  <h2>Why</h2><p>To run stores and orders, take payment, send order emails, prevent fraud and abuse, and meet legal duties.</p>
  <h2>Who can see it</h2><p>A seller sees the orders and customers of their own store only. EazyStores staff can see information needed to run and protect the service, and their actions are recorded. [Service providers (payments, email, hosting) to be listed.]</p>
  <h2>Photos</h2><p>Photos are re-saved without hidden location data. Photos a shopper attaches to an order are private to the seller who needs them.</p>
  <h2>How long we keep it</h2><p>Order, refund and tax records are kept for [period to be set by counsel]. Customers can ask us to erase their personal details from past orders; amounts and dates are kept for accounting.</p>
  <h2>Your rights</h2><p>You can ask to see, correct or erase your personal information. [Contact for privacy requests and privacy officer to be named.] We will tell affected people and the regulator if a breach creates a real risk of significant harm, as the law requires.</p>
  <h2>Security</h2><p>Passwords are stored as one-way hashes, two-factor secrets are encrypted, staff must use two-factor sign-in, and sellers' data is isolated from each other in the database.</p>
</LegalShell>;

export const RulesPage = () => <LegalShell title="Prohibited items">
  <p>These are examples, not a complete list. Anything illegal in Canada, or that puts people at risk, cannot be sold here.</p>
  <ul>
    <li>Illegal goods or services, and stolen goods.</li>
    <li>Weapons, ammunition and explosives.</li>
    <li>Cannabis, tobacco, vaping products and alcohol (until age verification exists).</li>
    <li>Prescription medicines, medical devices and unproven health or cure claims.</li>
    <li>Counterfeit or replica brand-name goods and anything that infringes someone's intellectual property.</li>
    <li>Recalled products and goods that do not meet Canadian safety rules (for example some children's products and cosmetics).</li>
    <li>Hateful, violent or sexually explicit material.</li>
    <li>Products from endangered species, and human remains.</li>
    <li>Lists of personal information, and gift cards or vouchers.</li>
  </ul>
  <h2>What happens if a rule is broken</h2><p>A moderator can remove a product or suspend a store. The seller is told the reason, and the decision is recorded.</p>
  <h2>Reporting</h2><p>[Reporting channel to be provided.]</p>
</LegalShell>;
