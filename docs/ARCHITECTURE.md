# EazyStores: product and technical plan (living document)

Status: Phase 1 (foundation), a thin Phase 3 commerce slice, a web UI, product images, CSV import, a customer marketplace, per-store theming, refunds, customer customisation, share links/QR, an admin area, sales tax, transactional email, password reset, two-factor sign-in, store review and moderation are implemented. Payments are still simulated. Items marked Built are real and tested; everything else is plan.
Last updated: 2026-11-04

## 0. Where I challenge the brief

| Idea | Recommendation |
|---|---|
| Build everything in the brief | The brief is about 5 years of roadmap. Ship a **thin end-to-end loop** first: sign up → add products → share a link → customer pays → seller sees profit. Everything else earns its place after that. |
| Marketplace as pillar #1 | Marketplace traffic is a cold-start problem. **Lead with storefront + EazyLink (share links/QR).** The marketplace is a free by-product (all published stores are indexed into it) until it has real traffic. |
| Multi-seller single checkout (parent order + sub-orders) | Correct end state, but it multiplies payments complexity (split payments, partial refunds, per-seller disputes). **MVP: one seller per checkout** from storefronts. Keep the schema parent/sub-order shaped so marketplace cart comes later without migration. |
| Stripe Connect vs Helcim | **Must be validated against current provider docs before any payment code.** I have not verified provider capabilities; do not treat any claim here as validated. Likely default to evaluate first: Stripe Connect (Canada supported, Express accounts handle KYC). Put behind a `PaymentProvider` interface. |
| AI features (Snap, Launch, Assist) | High value but costly and risky (hallucinated claims). Order: bulk import first (cheap, deterministic), then Snap (human approves every field), then Assist **only as templated queries over real data** (not free-form financial advice). |
| Visual drag-and-drop store builder | The most expensive item in the brief. MVP: **template + section toggles/reorder + colours/fonts** (JSON-driven sections). Full builder only after demand. |
| Custom domains, native card-terminal POS, WhatsApp API, SMS, subscriptions products, loyalty/referrals, ads | Defer. Each needs a vendor integration and ongoing ops. |
| Free tier | Yes, but fund it with a small transaction fee on the free plan, not subscription revenue. Plan numbers in the seed are **placeholders**. |
| "Eazy ecosystem" shared services | Design seams now (identity, notifications, payments behind interfaces, `tenant_id` everywhere), **do not** build a shared platform before a second product exists. Reading Eazyfoods code was not possible: it is not in this repo or session. |

## 1. Product architecture

Five surfaces, one backend: (A) marketplace, (B) storefronts at `/store/:slug`, (C) seller dashboard, (D) admin, (E) growth/intelligence. A seller is a **tenant**. Customers are global identities with per-tenant relationships (CRM rows are tenant-owned).

Principle: storefront works without the marketplace. Marketplace = read-model over published stores/products.

## 2. System architecture

Modular monolith, not microservices.

- API: Node 22 + TypeScript + Fastify, REST, zod validation (OpenAPI generation to follow).
- DB: PostgreSQL 16. Plain SQL migrations (`apps/api/migrations`).
- Web (not yet built): React + TS + Vite; storefront needs SSR/pre-render for SEO (evaluate Next.js vs Vite SSR when we start Phase 2).
- Jobs: Postgres-backed queue first (pg-boss) to avoid Redis until needed. Redis only for rate limiting/cache at scale.
- Files: S3-compatible object storage, signed uploads, image resizing worker.
- Search: Postgres FTS + `pg_trgm` for typo tolerance and synonyms table at MVP; Meilisearch/Typesense when catalogue size or relevance demands.
- Payments/notifications/AI/shipping: ports and adapters; each adapter labelled `live | sandbox | simulated | awaiting-credentials` in an integration registry shown to admins.
- Modules (folder per bounded context): identity, tenancy, onboarding, catalogue, inventory, cart/checkout, orders, payments, ledger, shipping, crm, messaging, marketing, insights, subscriptions, admin, audit.

### Tenant isolation (Built)
Three layers: (1) tenant id is **derived server-side from the session's membership**, never from client input; (2) every query runs inside `withTx`, which sets transaction-local `app.tenant_id`; (3) **PostgreSQL RLS** (`FORCE ROW LEVEL SECURITY`) on all tenant tables, with the app connecting as a non-owner, non-superuser role. Tests prove that read, update and insert across tenants fail at the database level.

Known caveat: the `app.platform_admin` and `app.signup` flags are set by application code. A bug that lets attacker-controlled SQL run would defeat them, so queries must remain parameterised. Hardening option: separate DB roles for admin and signup paths.

## 3. Entity design

Built (migration 001): `users, sessions, platform_roles, platform_role_permissions, platform_staff, plans, tenants, memberships, businesses, stores, reserved_slugs, audit_logs, platform_settings`.

Planned, by phase:
- Catalogue: `categories, products, product_variants, product_attributes(+values, jsonb for custom), product_media, collections, bundles`.
- Inventory: `locations, inventory_levels(variant, location, on_hand, reserved), inventory_movements(append-only), reservations(expires_at), suppliers, purchase_orders`. Oversell protection via `UPDATE ... SET reserved = reserved + n WHERE on_hand - reserved >= n` in the checkout transaction.
- Commerce: `customers(global), tenant_customers(CRM), addresses, carts, cart_items, checkout_sessions, orders(parent), seller_orders, order_items, shipments`.
- Money: `payments, refunds, payouts, ledger_accounts, ledger_entries` (double-entry, append-only, balanced via deferred constraint trigger; integer minor units + currency; idempotency keys on every provider call; webhook inbox table for exactly-once processing).
- Shipping: `shipping_profiles, delivery_zones, rates`.
- Marketing/CRM: `discount_codes, promotions, campaigns, segments, messages, conversations, notifications, notification_prefs, reviews (verified purchase only)`.
- Subscriptions: `subscriptions, invoices, plan_versions`.
- Verification: `verification_requirements, verification_submissions` (badge from requirements only, never from plan).

## 4. Roles and permissions

Seller side (per tenant membership): `owner` (all, publish, billing, staff), `manager` (catalogue, orders, marketing, settings except billing/ownership), `staff` (orders, inventory, POS), `support` (conversations, order read). Built: owner/manager/staff/support roles exist; owner-only publish and owner/manager profile edit enforced.

Platform side (data-driven, Built): `super_admin` (all), `support` (read sellers, audit), `finance` (plans, read), `moderator` (suspend/reinstate). Permissions: `sellers.read, sellers.suspend, plans.write, audit.read, staff.manage, settings.write`. No role is implicitly unrestricted. Sensitive actions require a reason.

Customer: owns own account/orders/reviews/wishlist only.

## 5. Journeys

Seller: signup (email, business name, store URL) → resumable onboarding (category → location → fulfilment) → add first products (import/Snap) → payments setup (KYC by provider, only needed before taking card payments) → publish → share link/QR → first order → fulfil → payout → dashboard shows profit.

Customer: lands from link/QR/marketplace → product page → add to cart → guest checkout → pay → tracking email → message seller → review (verified purchase).

Admin: monitor KPIs → review new sellers/verification queue → moderate listings → handle disputes → adjust plans/fees (with reason, audited) → review payout discrepancies.

## 6. Feature breakdown and MVP scope

**MVP (ship first)**: signup/onboarding (Built), tenancy/RBAC/audit (Built), store settings + 3 templates, products with variants + custom attributes, CSV import with mapping/preview/dupe detection, inventory with reservations, single-seller checkout (guest + account), one payment provider, orders and statuses, pickup + flat/local delivery, share links + QR, basic profit dashboard (revenue, COGS, fees, gross profit), email notifications, admin basics, storefront SEO (sitemap, JSON-LD, OG).

**Soon after**: marketplace home/search, reviews, discount codes, CRM and inbox, EazySnap (human-approved), EazyCustom fields/uploads/quotes, bundles/quantity discounts, subscriptions billing, abandoned cart, weight/zone shipping, EazyPOS (cash + manual card entry).

**Wait for demand**: multi-seller checkout, drag-drop builder, custom domains, card-terminal POS, WhatsApp/SMS, loyalty/referrals, advertising, EazyAssist free-form, multi-warehouse transfers/POs, Eazy Group shared identity.

## 7. Subscription and revenue model (placeholder numbers)

Seeded plans are admin-editable (`PATCH /api/admin/plans/:code`, reason required, audited): Starter free (50 products, 3.0% platform fee), Growth, Professional, Enterprise. **These prices and fees are not validated** against payment-processor costs, competitor pricing or willingness to pay. Do a unit-economics check: processor fees (roughly 2.9% + fixed fee for card processing on common providers; verify) leave very little room beneath a 3% platform fee on small tickets. Revenue stack: subscription, platform fee on sales, later featured placement, optional add-ons. Verified badge is never purchasable.

## 8. Security and privacy

Built: scrypt password hashing, opaque session tokens (only SHA-256 stored), HttpOnly SameSite=Lax cookies, origin check on mutations, login rate limit and 5-failure/15-minute lockout with timing equalisation, zod validation with strict unknown-key rejection, helmet headers, RLS, append-only audit log, parameterised SQL only.

Planned: email verification and password reset, TOTP MFA (required for platform staff), secure uploads (type sniffing, size caps, malware scan, private bucket, signed URLs), field-level encryption for sensitive seller data (KYC refs, tokens), secrets via env/secret manager, dependency scanning, backups with tested restore, PIPEDA/Alberta PIPA review by a qualified professional, no raw card data (provider-hosted fields only), configurable tax (GST/HST/PST tables, not hard-coded). **No compliance is claimed.**

## 9. Deployment and infrastructure

Containers (API, worker, web), managed Postgres with PITR, object storage + CDN, one region in Canada for data residency, staging and prod, migrations run as a release step with the owner role while the app runs as `eazy_app`, health checks, structured logs, error monitoring (Sentry-class), uptime checks, IaC. Not yet built.

## 10. Testing strategy

Unit (pricing, ledger balance, shipping rules), integration against real Postgres including RLS (Built: 14 tests), concurrency tests (last-item race, slug race Built), provider webhook replay/idempotency tests, Playwright E2E for the 25 scenarios in the brief at 3 viewports, axe accessibility checks in CI, load tests for catalogue and checkout, security tests (IDOR, tenant isolation, upload abuse).

## 11. Major risks

1. Payments scope and provider fit (split payments, KYC, disputes, payouts). Validate before building.
2. Marketplace cold start: no traffic means no value. Mitigated by link-first selling.
3. Scope breadth: the brief equals several companies. Mitigated by the MVP cut.
4. Free-tier economics versus processor fees.
5. Trust and fraud: fake sellers, prohibited items, chargebacks. Needs verification rules and moderation tooling.
6. AI accuracy and liability (specs, safety claims). Human approval and no invented specs.
7. Canadian tax and privacy correctness.
8. Search quality at scale.
9. Tenant data leakage (mitigated by RLS and tests; keep adding tests per table).
10. Single-developer-sized bus factor on a very large surface.

## 12. Roadmap

| Phase | Content | State |
|---|---|---|
| 1 Foundation | schema, auth, tenancy + RLS, signup/onboarding, publish, admin RBAC/audit/plans | **Built (API only)** |
| 1b | web app shell, email verification/reset, MFA, admin UI | next |
| 2 Store | templates, settings, categories, SEO pages | |
| 3 Commerce | products, variants, inventory, cart, checkout, orders, payments (after provider validation), ledger | **Thin slice built (API, simulated payments)**; see report below |
| 4 Marketplace | home, search, accounts, reviews | |
| 5 Business | dashboard, profit reporting, CRM, notifications | |
| 6 Differentiators | import assistant, Snap, Launch, Link, Custom, POS, Assist, Grow | |
| 7 Commercial | subscription billing, fee engine, ads, payouts | |
| 8 Hardening | audits, perf, a11y, backup/restore, monitoring | |

## Phase 1 report

**Implemented and tested** (14 integration tests against real Postgres, all passing; type-check clean): seller signup creating user, tenant, business and draft store atomically; sessions; login with lockout; resumable onboarding PATCH; owner-only publish with completeness check; public storefront lookup that exposes only published stores; admin seller list, suspend and reinstate (mandatory reason, store hidden, publish blocked); plan editing with before/after audit; immutable audit log; RLS isolation at DB level; slug race and cross-origin tests.

**Not built**: any frontend, email delivery, password reset, MFA, email verification, file uploads, payments, everything from Phase 2 onward.

**Problems found while testing**: my own signup rate limit starved the test run (now configurable); `FORCE RLS` also hides rows from the table owner, so DB-level test helpers need platform context; audit `DELETE` silently affects zero rows rather than raising (still immutable; tests assert the real guarantee).

**Decisions needed**: (1) payment provider shortlist and who validates it; (2) real plan prices and fees; (3) SSR strategy for storefronts; (4) whether Eazyfoods code can be shared for review; (5) hosting region/provider.

**Next**: Phase 1b (web shell, verification/reset, MFA for staff) then Phase 2/3 thin vertical slice.

## Phase 3 thin-slice report (commerce core)

**Implemented and tested** (32 integration tests total, all passing): products with variants, custom attributes and plan-limit enforcement; stock adjustments with an append-only movement history; single-seller guest checkout with server-side pricing; stock reservation with a 15-minute expiry and sweeper; order state machine; seller order list/detail; public order lookup by unguessable token; a balanced, append-only double-entry ledger (platform fee from the seller's plan); a dashboard that separates gross sales, COGS, gross profit and fees and flags missing costs.

Edge cases covered by tests: six buyers racing for one unit (exactly one wins); payment failure releases stock; abandoned checkouts expire; **payment succeeds after expiry with stock gone** (money kept, order not fulfilled, `needs_refund` flagged); webhook replay is idempotent; a DB CHECK refuses oversell even if app logic is bypassed; an unbalanced ledger group is rejected at commit.

**Payments are SIMULATED.** `PaymentProvider` is a port; the only adapter moves no money and is labelled `simulated` in every checkout response. The simulate endpoint exists only when that adapter is active, and checkout returns 503 when no provider is configured. No real provider has been validated or integrated.

**Bug found and fixed this phase (Phase 1 regression):** the seller business endpoint queried `stores` without a tenant filter, and the public-store RLS policy made other tenants' published stores visible to it. Lesson recorded: any table with a permissive public policy needs an explicit `tenant_id` filter in tenant-scoped queries. Regression test added.

**Not built:** real payments, refunds (so orders cannot be cancelled after payment), taxes, shipping rules beyond a flat delivery fee, product images/uploads, bulk import, discounts, customer accounts, notifications (no emails are sent on orders), variant editing after creation, multi-location inventory, any UI.

**Known gaps to decide:** `needs_refund` payments have no resolution workflow yet; the dashboard has no payment-processor fees, so no net profit is shown (deliberately); the order token endpoint relies on an unguessable token with no rate limit beyond defaults.

## Web UI report (apps/web)

**Implemented:** React + Vite + TypeScript. Seller: signup, login, overview with get-started checklist and profit panel, products (multi-option create, stock +/-, publish/hide/archive), orders (detail, status progression), store settings (profile, fulfilment, delivery fee, publish, shareable link). Customer: public storefront, cart (localStorage), guest checkout, simulated-payment step, order status page by token.

**Tested:** `apps/web/e2e/flow.cjs` drives the real UI against the real API and Postgres in headless Chromium, at 375px mobile and 1280px desktop: signup, blocked publish on incomplete profile, settings, publish, product with two options, stock adjustment, guest delivery checkout, simulated payment, order progression, dashboard. It asserts no horizontal overflow on every page. 34 API integration tests also pass. Screenshots were reviewed by eye.

**Found and fixed:** dashboard showed COGS and gross profit as $0.00 when sold items had no cost recorded; the API now returns null and the UI shows "Unknown". Dev-proxy requests were rejected by the same-origin check; replaced with an explicit `ALLOWED_ORIGINS` allowlist (dev default only, empty in production).

**Known UI gaps:** no product images (placeholder tile with initial), no search/filters, no pagination controls (lists load up to 100), seller nav tabs scroll horizontally on small phones and the active tab can clip the first one, no automated accessibility audit yet (labels, focus rings, 44px targets and 16px inputs are in place by design but unverified by axe), no password reset or email verification, no admin UI, no emails sent.

## Images, import and visual redesign report

**Implemented and tested** (48 API tests, plus the browser E2E at 375px and 1280px):
- **Product images:** raw binary upload (JPG/PNG/WebP, 5 MB cap, max 8 per product). Type is decided from the file's magic bytes, never the declared content type or filename, so a script labelled `image/png` is refused (415). Files sit behind a `Storage` port (local disk now; S3-compatible adapter to come). Keys are unguessable and validated against path traversal. Images are served publicly only for ACTIVE products, with `nosniff`. Rejected DB writes remove the stored file (no orphans). Cross-tenant attach/delete returns 404.
- **CSV import assistant:** RFC 4180 parser (quotes, embedded newlines, CRLF, BOM); column mapping suggested from header synonyms and editable; per-row validation with line numbers (missing name, bad price/quantity, repeated SKU in file); duplicates against the existing catalogue by SKU and by product name are skipped, never merged or overwritten; rows with the same name become options of one product; preview writes nothing; commit imports only clean rows, defaults to drafts, honours plan limits, writes stock movements, and is audited.
- **Redesign:** a design system with warm neutrals, deep-forest brand and gold accent, serif display type, soft shadows, pill buttons, focus rings and `prefers-reduced-motion`. Seller app uses a sidebar on desktop and a bottom tab bar on phones (this also removed the clipped-tab problem). New landing page, storefront with hero, photo cards, sold-out badges and a sticky cart bar.

**Problems found and fixed:**
1. `FORCE ROW LEVEL SECURITY` also applies inside `SECURITY DEFINER` functions, so image serving returned 404. A public read policy on `products` would have re-created the Phase 1 leak (seller list queries have no tenant filter), so the lookup function now elevates privileges only for its own query and restores the previous setting. A test proves the elevated flag cannot leak to later statements.
2. The dev database lagged one migration behind the test database (tests build a fresh schema), which hid the problem above from the browser run. Lesson: run `npm run migrate` against the dev database after every migration.
3. The Vite dev proxy forwarded `/api` but not `/media`.
4. A link styled as a ghost button rendered as a solid button.

**Known gaps:** no image resizing, thumbnails or CDN (originals are served, so large photos load slowly on mobile; add `sharp`-based variants before launch); no virus scanning; no alt text field; image order cannot be changed; import accepts CSV only (not .xlsx), has no attribute columns, and the 200-row preview limit is display-only; the landing page has no product imagery; no automated accessibility audit has been run; payments remain simulated.

## Customer marketplace and theming report

**Implemented and tested** (56 API tests; browser E2E now covers a typo search, product page and add-to-cart at 375px and 1280px):
- `/` is now the customer marketplace: search, category chips, featured stores (3-image mosaic in the store's accent colour), product grid with sort and "show more". The seller pitch moved to `/sell`.
- Product pages: gallery, option buttons, price, made-to-order notice, delivery/pickup summary, description, and the seller's **custom attributes** as a details table. Because attributes are free-form, a perfume (concentration, family), a 3D print (material, print time) and a serum (skin type, ingredients) each show what matters for them without per-category code.
- Search: name, brand, store and category, plus typo tolerance via `pg_trgm` word similarity; `%` and `_` are treated literally.
- Store theming: accent colour (hex-validated), light/dark header, compact/spacious layout, saved per store and applied on the storefront and product pages.
- Privacy: marketplace reads run with platform context but select only public columns; a test walks every key and value of the responses to prove no cost, stock counts, tenant ids or emails leak. Draft products, unpublished stores and suspended sellers never appear.

**Found:** deleting a tenant that has order history is (correctly) blocked by the append-only ledger and inventory history. Account closure and privacy-erasure requests therefore need a purpose-built anonymise-and-retain procedure. Added to the risk list.

**Honest limits:** demo products are generated placeholder illustrations, not photographs; the marketplace orders by newest, so one store's batch can dominate (needs ranking and mixing before launch); no per-category product templates (attributes are free-form and unsuggested); personalisation inputs at checkout (names, uploaded photos, quotes) are not built, so made-to-order products can only be sold as fixed options; there is no multi-store cart (each store checks out separately); no reviews, ratings, wishlists or customer accounts; no location-based "near me" filtering; store accent colours are not contrast-checked, so a very light accent could produce unreadable button text.

**Demo data:** `node apps/web/e2e/seed-demo.cjs` seeds six stores (fragrance, 3D printing, jewellery, beauty, fashion, phone accessories) through the real API. Dev only.

## Public design v3 report (editorial, store-first)

**Why:** feedback was that the customer side felt like a big catalogue marketplace. The traits behind that feel were a dominant search bar, category pills, a dense wall of identical product cards with a price and "Add to cart" on each, and rounded boxes. v3 removes those on purpose.

**What changed** (customer pages only, scoped to `body.pub`; the seller dashboard keeps its own tool-like system):
- Marketplace home is curated and brand-first: one featured maker, category tiles, a "makers" list, and only four products under "New this week" (one per store). The full product grid exists, but only behind "View all products", a category, or a search.
- Header: wordmark, categories as plain text links, search that opens on demand.
- Cards: sharp 4:5 images, hairline rules, small-caps store name, quiet price, and a hover swap to the second photo. No add-to-cart on the grid; shoppers choose options on the product page.
- Product page: vertical thumbnails, large image, sticky details, option squares, and accordion sections for description, attributes and delivery.
- Store pages: oversized light display title in the store's own accent (light or dark header), a "Collection" grid.
- Typography: Inter for UI, a single `--display` font variable for headings (currently Newsreader). Alternatives rendered and compared: Instrument Serif and Inter Tight.

**Tested:** 56 API tests and the browser E2E (updated for product-page checkout flow) pass at 375px and 1280px, including a typo search, product page and add-to-cart.

**Bugs found while building:** a class-name collision (`.feature`) between the new hero and the old landing cards; global public button padding overriding the thumbnail padding (specificity); duplicated "brand · store" label when they are identical; the near-black accent producing a flat grey hero tint (reduced).

**Update:** the seller dashboard (`body.seller`), `/sell`, signup and login are now restyled to the same family (warm neutrals, hairlines, serif titles and key numbers, normal-case buttons for working screens).

**Open:** font choice awaits the owner's decision (one-line change, currently Newsreader); the featured maker is simply the newest store (needs curation controls in admin); category tiles use the newest store's first photo; placeholder illustrations stand in for photography.

## Refunds, customisation, share links and admin: report

**Tests:** 83 API integration tests (8 files) and two browser end-to-end flows (`e2e/flow.cjs`, `e2e/flow2.cjs`) at 375/390px and 1280px, all passing.

### Refunds (`modules/refunds.ts`, migration 007)
- Full and partial refunds by owner/manager. Aggregate refunds can never exceed the order total (row lock plus a database CHECK); two simultaneous refunds that together exceed it have exactly one winner (tested).
- Ledger stays balanced: cash out, platform fee returned pro rata (floor), seller payable reduced. Refund records are append-only.
- Idempotent on a client key (a double click or retry cannot refund twice); a key reused on another order is rejected.
- Restocking is offered only for a whole-order refund (a partial refund cannot say which units came back).
- Payments that succeeded after stock was gone (`needs_refund`) are listed on the seller overview and can be refunded once.
- Dashboard: partial refunds reduce profit; fully refunded orders drop out of sales. Staff-role members can fulfil but not refund.
- **Limits:** the provider call runs inside the DB transaction holding the order lock. Acceptable for the simulated adapter; a real provider needs record-intent-first plus reconciliation. No chargeback or dispute handling. Fully refunded orders drop out of COGS even if goods were not restocked (stated in the dashboard notes).

### Customisation (EazyCustom) (`lib/custom.ts`, `modules/commerce.ts`)
- Sellers define up to 10 customer inputs per product: short text, long text, choice list, reference photo; each optionally required.
- The server validates every checkout answer against the product's current fields (required, length, allowed choices, unknown keys). Lines with different answers stay separate; stock is reserved per variant in total.
- The order item stores a snapshot of question and answer, so later product edits cannot rewrite history.
- Customer photos go to private storage (magic-byte check, 5 MB cap, rate limited), are never served by the public media route, can be viewed only by the owning seller, can be attached to one order only (atomic claim; concurrent reuse has a single winner), and expire after 24 hours if never ordered.
- **Not built:** custom pricing, quotes, customer approval workflows, file types other than images, date pickers, per-option price changes.

### Share links and QR (EazyLink) (`modules/share.ts`)
- Channel-tagged store and product links (Instagram, WhatsApp, Facebook, TikTok, email, QR) and SVG QR codes. QR is generated only for the seller's own store/product paths (not an arbitrary-URL service).
- The tag travels from the link through the cart to the order; the overview shows sales by channel.
- Set `PUBLIC_URL` in production so links and QR codes point at the real domain (default is the dev origin).
- **Not built:** discount links, embeddable widgets and buy buttons, link click analytics (only orders are attributed).

### Admin (`/admin`)
- Overview figures, seller search with owner/products/orders, suspend and reinstate (reason required, store hidden, audit entry), plan editing (reason required, old and new values audited), featured maker (editorial, never purchasable; needs `settings.write` and a reason; a suspended or empty store silently stops leading), audit log viewer.
- Staff accounts are created with `npm run make-staff -- <email> <role> [password]`. The UI hides actions a role cannot do; the server enforces every permission.
- **Not built:** verification review queue, product moderation, payout and dispute tools, staff management screens, **staff MFA (must exist before real launch)**, subscription billing.

### Found and fixed during this round
- The browser overflow check passed on phones when it should not have: in phone emulation the layout width widens to fit overflow, so `scrollWidth - innerWidth` is always 0. The check now compares against the real device width, and all pages were re-verified.
- A real mobile bug it exposed: screen-reader-only text in a table header was absolutely positioned outside its scroll container and widened the whole page. Fixed with a positioned container.
- Product pages with zero or one photo squeezed the main image into the 76px thumbnail column.
- Plan ordering sorted Enterprise (price 0, custom) before Starter; plans now have an explicit sort order.
- Public product detail did not include custom fields (only the store list did).
- Test-quality fixes: a vacuous staff-role test was replaced with a real one; a helper that fired a stray extra checkout was removed; a tie in channel ordering made a result nondeterministic and is now deterministic.
- Deleting a seller that has orders is blocked by the append-only ledger (by design); an anonymise-and-retain closure process is still needed.

## Launch-readiness round: report

**Tests:** 142 API integration tests (12 files) and four browser end-to-end flows (`flow.cjs`, `flow2.cjs`, `flow3.cjs`, `flow4.cjs`) at 375/390px and 1280px, all passing, with the strict phone overflow check. The two-factor and email tests run against real RFC 6238 vectors and a real local SMTP server.

### Stage 1: make it real
- **Sales tax** (`lib/tax.ts`, migration 009). Rates are rows in `tax_rates` (admin-editable with a reason, audited), not code. GST/HST follows the destination at the destination's rate; PST/QST/RST applies only where the seller says they are registered. Integer, half-up rounding per component. Collected tax goes to a `tax_payable` ledger account (a liability, never seller income). Refunds return tax and fee pro rata, and the final refund returns the exact remainder (no rounding residue). The cart shows the real total, including tax, before paying (one pricing code path serves both quote and checkout).
  *Limits:* starting rates were entered by the developer and **have not been verified against CRA or provincial sources** (admin screen says so); every product is treated as taxable (no zero-rated or exempt goods); delivery fees are taxed; sellers outside Canada are not handled; the tool does not tell a seller whether they must register.
- **Email** (`lib/mail.ts`, migration 010). Transactional outbox written in the same transaction as the event (rolled-back events send nothing), SMTP sending verified against a real local SMTP server, retry with backoff and a hard stop after 5 attempts, HTML escaping and header-injection protection. Templates: order confirmation, new order, status updates, refund, low stock (once, when crossing the threshold), verification, reset, password changed, store approved/rejected, verification decision, product removed, account closed.
  *Limits:* templates live in code (not admin-editable); no marketing email, and no seller notification preferences; with no `SMTP_URL`, mail is recorded as "simulated" and not sent.
- **Password reset and email verification.** One-time, hashed, expiring links; newest link wins; two simultaneous uses have one winner; reset signs out every session and does not bypass two-factor; the form does not reveal which emails have accounts. Publishing is blocked until the email is verified (production default).
- **Two-factor sign-in** (`lib/totp.ts`, `modules/account.ts`). TOTP matching the RFC 6238 vectors, secrets encrypted at rest (AES-256-GCM), 10 single-use recovery codes, replay protection, a 5-attempt limit per challenge that cannot be bypassed, and **mandatory for platform staff**: admin screens show nothing but the enrolment prompt until a verified session exists. Sessions created before enrolment stay locked out.
  *Limits:* no WebAuthn/passkeys, no SMS; recovery for a lost phone and codes is an operator action (`npm run reset-mfa`).
- **Payments:** research and plan only (`docs/PAYMENTS.md`). Nothing real is integrated.

### Stage 2: make it trustworthy
- **Store review** (optional switch, staff-controlled, audited): new stores wait for approval, reviewers see the products and prices, a rejection needs a reason the seller sees, and the seller can resubmit. Already-live stores are unaffected when the switch is turned on.
- **Verified badge** is requested by the owner and decided by staff with a reason. It is never granted by a plan (tested: an unverified seller on the top plan is still unverified).
- **Product moderation:** staff remove or restore with a reason; removed products disappear everywhere, cannot be republished by the seller, and the seller is told why.
- **Terms acceptance** recorded at signup (and via banner for older accounts) and required to publish in production.
- **Draft legal pages** (terms, seller agreement, privacy, prohibited items), each carrying a banner that says it is a draft **not reviewed by a lawyer**. They must be reviewed and completed by Canadian counsel before launch.
- **Account closure:** blocked while orders are open or a customer is owed money; deletes personal details and product photos, anonymises and disables the seller login, cancels unpaid checkouts and returns their stock, and keeps orders, refunds and the ledger.
- **Customer erasure** (staff, `privacy.write`): replaces a customer's name, email, address, customisation answers and uploaded photos on past orders, redacts stored email history, keeps amounts and the ledger, refuses while any of their orders is in progress, and logs a hash of the address rather than the address.
  *Limits:* **retention periods are undecided and need legal advice**; closure keeps customers' personal data on retained orders until the customer-erasure tool is used; there is no self-service export of a person's data.
- **Images:** every upload is decoded and re-encoded (EXIF/GPS stripped, camera rotation applied, capped at 1600px, thumbnails for grids), disguised files, SVG and decompression bombs are refused, and storefronts search and page (24 at a time).
- **Search:** exact matches win; typo tolerance applies only when nothing matches exactly (found when "Item 07" returned every numbered item).
- **Operations:** production build, readiness check, structured logs with cookies redacted, production-mode behaviour verified, backup script and a restore check that fails on a bad backup (both exercised). See `docs/DEPLOY.md`. **Docker files are untested.**

### Bugs found and fixed this round
- A real UI race: the admin "store review" toggle appeared before its current value had loaded and sent the opposite of what the label said. It now waits for the value and sends the chosen value.
- Search returned every near-match for numbered names; fixed as above.
- A reviewer preview link pointed at a store that is not public yet; the queue now shows the products inline.
- Mobile table-scroll overflow and the single-photo gallery (previous round, re-verified under the strict check).
- Several test-quality problems (loose selectors, a timing race on the reset form, and an email batch limit) were fixed in the tests, not the product.

### Not done (the recommendation list was longer than this round)
- **Real payment provider** (needs the owner's decision and credentials; plan in `docs/PAYMENTS.md`).
- **Subscription billing and plan changes**, weight/zone **shipping rules**, **discount codes**, **EazyPOS**, **customer accounts, reviews and wishlists**, and the **AI features** (photo-to-listing, business assistant).
- S3-compatible storage, monitoring/alerting, load testing, tested container images.
- Admin-editable email templates, seller notification preferences, a staff-management screen.
- Lawyer-reviewed legal text and a decided retention policy.
