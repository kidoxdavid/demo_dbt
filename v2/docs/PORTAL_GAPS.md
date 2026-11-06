# What EAZYfoods portals do that EAZYstores portals do not yet

Source: `kidoxdavid/eazyfoods` (PROJECT_STATUS.md and the portal source), read on 2026-11-06. EAZYfoods is a grocery and home-kitchen marketplace with delivery drivers, so some things do not apply to a makers' marketplace that ships by post. Everything below marked **applies** is something a makers' marketplace also needs.

## Already matched
Feature switches enforced by the server; per-vendor switches; admin as the top role; "open their portal" as the vendor; separate sign-in windows; audit log; editable portal names and looks; staff-editable emails and pages; roles and permissions editor; a real maker Insights page and a real maker Payouts page (what is ready, waiting and paid); "Meet the makers" and "Gift guides" pages; one-tap add from product cards; phone menu for every staff console.

## Admin and operations (applies)
| EAZYfoods has | Here |
|---|---|
| Waiting badges on every menu item (new vendors, refunds, support, ads, catalogue approvals, unanswered questions) and red dot / tab-title counts | Missing |
| Insights dashboards for admin and for each vendor: 7/30/90-day KPIs vs the previous period, daily charts, orders by hour/weekday, top products and stores | Maker side built (7/30/90 days, vs the period before, daily chart, best sellers). Admin side and orders-by-hour still missing |
| Vendor documents and verification onboarding (upload, review, approve) | Missing (verification tier is set by hand) |
| Delete or erase accounts and vendors with typed confirmation, and a "Start from scratch" button that removes demo data | Missing (done by command only) |
| Menu hiding per portal and a notice banner at the top of every page of a portal | Missing |
| Vendor-to-staff messages (threads, unread badges, email on reply) and driver chat | Missing (only buyer-to-maker order messages exist) |
| Support: tickets, help centre page with contact form that opens a ticket | Missing (support console is orders, people, audit, notes) |
| Pricing and rules engine: versioned, scoped, approval workflow, simulator | Missing (one commission setting and a per-maker override) |
| Settlements: statements, balances split payable now / in hold / in progress, retry failed transfers, automatic payouts, payout emails | Missing (manual payout record only; no payment provider) |
| Maker staff team screens (invite, roles) | Roles exist, no screen |
| Product questions answered by the maker; review photos; frequently bought together; buy it again; recently viewed | Missing |

## Marketing (applies)
EAZYfoods marketing portal: email campaigns (editor, preview, test send, A/B subject, schedule, click and unsubscribe stats), reusable templates, rule-based audiences with live counts, automations (welcome, win-back, abandoned basket, all off by default), festival calendar, coupons and discount codes, rewards (cashback, invite a friend), store credit wallet, gift cards buyers can purchase, consent (CASL) safeguards, a storefront studio (themes, banners incl. video, homepage section order). Here, marketing has: home page editor, ads review, search words, store promotions. **Coupons and discount codes, email campaigns with consent safeguards, and automations are the biggest gaps.**

## Maker portal (applies)
EAZYfoods vendors also get: CSV import with check-only first, multi-buy price breaks, promotions and coupons, ads with a designer, analytics, reviews management, documentation, settlement report/CSV, barcode scan, support. Here: no CSV import, no discount codes, no analytics page beyond the dashboard, no payouts page (placeholder).

## Customer side (applies, outside the portals)
Installable app (PWA), SEO (sitemap, structured data), French, store credit, gift cards, shopping lists, order tracking stepper, help centre.

## Does not apply (grocery and delivery)
Driver portal, dispatch, delivery zones and fees, pre-order time slots, driver tips, substitutions, home-chef kitchens and food-safety documents, unit pricing, live driver map.

## Suggested order (your call; each is its own phase)
1. **Operations basics:** waiting badges, admin and maker Insights, delete and "start from scratch", portal notices, vendor-to-staff messages.
2. **Support:** tickets, help centre with contact form, staff replies by email.
3. **Maker verification and team:** documents upload and review, maker staff screens.
4. **Marketing:** discount codes first (also fills the studio "Promotions" placeholder), then email campaigns with consent safeguards, audiences, automations.
5. **Money:** the Stripe adapter and Connect payouts (still the launch blocker), then settlements and the pricing rules engine.
6. **Customer extras:** product questions, review photos, store credit and gift cards, PWA manifest, SEO, French.
