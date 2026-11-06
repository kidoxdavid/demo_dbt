# EAZYfoods portals compared with EAZYstores portals

**How this was made (2026-11-06).** Read from the EAZYfoods source (`kidoxdavid/eazyfoods`): the route table of every portal (`apps/web/src/portal/*/App.jsx`), the admin page sections, the permission table (`perms.js`), the vendor catalogue API, the cart page and the project status document. **I could not run EAZYfoods** (the tool that runs another codebase's install scripts was blocked), so nothing here comes from its screens, only from its code. If you want me to run it and walk its screens, allow that and say so.

Rows marked **n/a** belong to groceries and delivery (drivers, dispatch, zones, slots, pack sizes) and a makers' marketplace that ships by post does not need them.

## Admin (EAZYfoods `/admin`: 31 routes) vs ours (`/admin`: 11)
| EAZYfoods | Ours |
|---|---|
| Operations dashboard: queues for orders not accepted, open support tickets, refunds waiting or failed, payment anomalies, 30-day numbers | Overview with counts only. **Missing: action queues** |
| Orders list and detail with history | Orders only in Support and Finance. **Missing in Admin** |
| Support tickets list and ticket detail with replies | **Missing** (Support has notes, not tickets) |
| Refunds queue: request, approve, fail | Refunds issued in Finance. **No request/approve split** |
| Customers list and detail (account, tickets, orders, reviews, gift cards) | People (list, roles, disable). **No tickets, orders or reviews on a person** |
| Vendors: business, people, stores, **documents with approve/reject**, commercial terms, commission override, payout account, danger zone (delete) | Sellers: status, tier, commission override, switches, act-as. **Missing: documents, payout account, delete** |
| Vendor messages (threads with unread badges) | **Missing** |
| Catalogue list and product editor, taxonomy editor | Review queue only. **Missing: catalogue editor and category editor screen** |
| Promotions (coupons), ads review, storefront studio (themes, banners), content (homepage, pages and policies, email templates, recipes) | Store promotions, ads review (in Marketing), pages, emails, names and looks. **Missing: coupons, banners and themes** |
| CRM: vendor prospects pipeline with activity log | **Missing** |
| Finance, insights, reports | Finance in its own portal. **Missing: Insights in Admin** |
| Control centre (feature switches, vendor permissions, menus and notices, platform rules), Settings, System (error log) | Settings and features, Roles and access. **Missing: menu hiding, portal notices, error log screen** |
| Waiting badges on every menu item | **Missing** |
| Delete accounts and vendors with typed confirmation; "Start from scratch" | **Missing** (command line only) |

## Vendor portal (EAZYfoods `/vendor`: 35 routes) vs ours (`/studio`)
| EAZYfoods | Ours |
|---|---|
| Products: list, new, edit, **delete (confirm; deleted if unused, otherwise taken off sale and kept)**, import CSV (check first), barcode and labels | Products: list, new, edit, duplicate, **delete (now matches, 2026-11-06)**. **Missing: CSV import, labels** |
| Inventory with stock history and scan | Stock edited per variant. **Missing: inventory screen and history** |
| Orders and order detail, chat with the buyer | Orders, order detail, messages |
| Promotions (discount codes and sales), multi-buy | Store promotion banner only. **Missing: discount codes** |
| Ads with a designer | Ads (campaigns) |
| Reviews with replies, product questions with answers | Reviews with replies. **Missing: questions** |
| Analytics / Insights | Insights (built 2026-11-06) |
| Payouts, statement, reports (CSV) | Payouts page (built 2026-11-06). **Missing: statement and CSV** |
| Staff team (invite, roles) | Roles exist, **no screen** |
| Profile, documentation / onboarding documents | Shop page settings. **Missing: documents upload** |
| Support (tickets to staff) and messages with staff | **Missing** |
| Storefront (colour, tagline, announcement, story, links, featured products) | Shop page: look, story, policies |

## Marketing (EAZYfoods `/marketing`: 18 routes) vs ours (4)
EAZYfoods: analytics, **email campaigns** (editor, preview, test send, A/B subject, schedule, stats), email templates, **audiences** (rule-based, consent-safe), **automations** (welcome, win-back, abandoned basket; all off), social planner, budget, calendar, media library, **coupons**, ads, storefront studio, **rewards** (cashback, invite a friend, store credit, gift codes), settings.
Ours: home page editor, ads review, store promotions, search words. **Biggest gap in the whole comparison.**

## Finance (EAZYfoods `/finance`: 12 routes) vs ours (5)
EAZYfoods: balances, refunds (approve), **settlements**, **reconciliation**, gift cards, **pricing rules (versioned, approval, simulator)**, insights, reports, orders, system.
Ours: overview, seller balances, orders and refunds, GST and exports, audit. **Missing: settlements, reconciliation, pricing rules, insights.**

## Support (inside EAZYfoods Admin) vs ours (`/support`: 3 pages)
EAZYfoods: tickets with replies and context panels. Ours: orders, people, audit, notes. **Missing: tickets and a help centre with a contact form.**

## Shopper side (not a portal, but where the cart lives)
EAZYfoods keeps its full header and footer on every page, including the basket; an empty basket offers "Browse products"; it has a group-order basket, shopping lists, store credit, gift cards, help centre, French, installable app. Ours now has a way out of the basket and checkout (fixed 2026-11-06); **still missing:** shopping lists, store credit, gift cards, help centre, French, installable app.

## Suggested order (each is its own phase; your call)
1. **Operations basics:** Admin action queues and waiting badges, Admin Orders and Refunds queue, Insights for Admin and Finance, delete accounts and makers, "Start from scratch", portal notices.
2. **Support:** tickets with replies, help centre with a contact form, maker-to-staff messages.
3. **Makers:** CSV import, inventory screen with history, staff team screen, documents upload and review, questions.
4. **Marketing:** discount codes first (also fills the old Promotions idea), then email campaigns with consent safeguards, audiences, automations, rewards and store credit.
5. **Money:** the Stripe adapter and Connect payouts (still the launch blocker), then settlements, reconciliation and the pricing rules engine.
6. **Shopper extras:** shopping lists, gift cards, installable app, French.
