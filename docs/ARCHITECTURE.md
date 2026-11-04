# EazyStores: product and technical plan (living document)

Status: Phase 1 (foundation), a thin Phase 3 commerce slice, and a first web UI (seller dashboard, storefront, checkout) are implemented. Items marked Built are real and tested; everything else is plan.
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
