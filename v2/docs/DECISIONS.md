# Decisions (each is a setting or easy to change; tell me if you disagree)
1. **Built in `v2/`** beside the first app so nothing was overwritten.
2. **Phone references are 798 px tall** (the original generator cut them to 780). See `docs/DESIGN.md`.
3. **Home "New from makers" has two different fourth cards in the brief** (phone: Body wave bundle, desktop: Amber & oud). One query cannot give both. The API returns the five newest in a fixed order (Dusk, Cedar, Geometric, Body wave, Amber & oud). The phone shows the first four. For the desktop row the storefront phase will use staff-curated home picks (a setting) so the fourth slot can be Amber & oud, as the mockup shows. Nothing is hard-coded to match a screenshot.
4. **"412 pieces from 38 makers"** on the category mockup is reproduced with real rows: 35 filler ceramics makers and 405 filler pieces, plus the six listed pieces and the product-page vase. The filler is dev-only demo data.
5. **Shop ratings in the demo are seeded aggregates** (4.9, 128 reviews for Clay & Ember). Real reviews arrive in the engagement phase and will recompute them.
6. **Cards show "Handmade" or "One of a kind" as the chip; the product page shows "Handmade · Made in <place>".** "Limited" (and similar) is an explicit label a product can carry.
7. **A product cannot be published with zero stock** unless it is made to order; an already live product that sells out stays live and shows as sold out.
8. **Restricted categories** (toys, perfume, hair) go live immediately after the seller reads and confirms the extra rules, and are queued for staff review afterwards. Prohibited keywords (counterfeits, weapons, drugs and vapes, stolen goods, explosives, protected brands and characters) block publishing with a plain reason. The keyword list is a first line only: staff review and take-downs are the real control.
9. **Search is exact-first.** Typo tolerance only runs when nothing matches exactly. Synonyms are a human-verified table (wig and hair piece, mug and cup, ...); a pair is added only after someone checks it.
10. **Public media is served only if attached to something live**; sellers see their own drafts through the studio media route. File names and declared types are ignored: the first bytes decide, and images are re-encoded (metadata and GPS stripped, orientation fixed).
11. **A seller has one shop** in v2 (multi-shop is out of scope).

## Phase 3 decisions
- Payment rows stay `pending` when an unpaid order expires, so a late provider success can still be settled (re-reserve stock, or refund in full if it is gone).
- Orders become paid only from a verified, idempotent webhook (HMAC over the raw body, event ids deduplicated). The dev-only simulate route signs a real event and goes through the same path; it does not exist in production.
- Validation failures return 400 `validation_failed`; business-rule failures return 409/422 with a code.
- Basket shows items + shipping; GST is added at checkout (shown as a note in the basket).
- Default shipping profile for a new shop is $9.00 flat, 5 to 8 days transit.
- Only a mock payment provider exists. A Stripe adapter must implement `PaymentProvider` in `lib/payments.ts`.

## Phase 4 decisions
- **Home is curated by settings**: `home_picks_phone`, `home_picks_desktop` (product ids; empty = newest), `home_categories` (tile label, art, tone) and `home_spotlight` (shop, quote, art). The demo seed sets them so the phone and desktop mockups (which differ in the fourth card) both reproduce. An admin screen for them comes with Phase 6.
- **One request builds the home page** (`GET /api/home`). The delivery dates in the demo screens need a fixed "today": `EAZY_FAKE_NOW` pins the clock in development and tests only (ignored in production).
- **Pottery gets Material and Size filters** (and every category can use `freeShipping=true`, meaning the shop's default profile ships that piece free on its own) so the filter row of the category mockup is real, not painted.
- **Hearts and Follow are real now** (migration 006, `/api/me/saved`, `/api/shops/:slug/follow`): guests are sent to sign in and returned to the page.
- **Demo seed gained a Clay & Ember candle**, because the basket mockup has that shop selling a candle (2 makers, ships separately).
- The checkout screen has a **test-mode payment panel** that exists only while the mock provider is active; with no provider, checkout answers 503 and the screen says payments are not connected.

## Phase 5 decisions
- **The studio is its own window** (`/studio`, cookie `es_studio`): signed-out visitors are sent to `/studio/login`; a person can hold a buyer session and a seller session at once.
- **Studio home numbers come from orders, stock and page views.** Sales = items + shipping (no GST), last 7 days against the 7 before; visits = shop page views (`shop_views`, one row per shop per day); "Running low" = a variant with 1 or 2 left; the checklist is computed (payouts is always undone until a payment provider is connected).
- **Category suggestion** ranks only the categories the seller picked at sign-up, by words in the title plus a small hint list ("vase" means pottery). It never invents a category.
- **Onboarding autosaves a draft product** (900 ms after the last edit) and cannot publish until the same readiness list the product editor uses is empty. Restricted categories need the seller to tick the extra-rules box.
- **Money screens show the seller what they earn:** items + shipping - commission; GST is shown as collected for the tax authority, not as the seller's.
- **Payouts, messages, promotions and insights are honest placeholders**, not fake screens.

## Phase 6 decisions
- **Four windows, four sign-ins** (`/admin`, `/support`, `/finance`, `/marketing`; cookie per window; the server decides the window from the API path). A role decides who may sign in where: admin and catalogue to admin; support and admin to support; finance and admin to finance; marketing and admin to marketing.
- **New permission `catalogue.moderate`** (admin and catalogue) for the review queue, so the catalogue role can review without being able to manage people.
- **Sellers become payable after delivery plus `payout_hold_days`.** Available = ledger seller-payable on orders delivered at least that long ago, less payouts already made. A payout is recorded after the bank transfer is sent outside the app, and posts a balanced ledger entry (cash out, seller payable down) in one transaction under a lock on the seller, so two staff members cannot pay the same money twice.
- **Suspending a seller hides the shop and blocks new sales at once** (every storefront query already requires an active seller); orders already paid stay with the seller to fulfil.
- **Support can see everything about an order but change nothing about money**; finance alone can refund. Every staff action that changes something writes the audit log with who, what, old and new values and a reason.
- **Notes are internal**: stored apart from orders, never returned by any buyer or seller route.
- **CSV exports neutralise spreadsheet formulas** (a cell starting with = + - @ gets a leading apostrophe) and are audited.
- **The sign-in rate limit stays at 10 a minute**; the browser flows raise it with `AUTH_RATE_LIMIT_MAX` on the development server only.

## Phase 7 decisions
- **Reviews are verified by delivery**, not by account: the order link proves the order, the seller order must be `delivered`, and a database unique key (seller order, product) allows one review each. Shortening the name happens when the review is written.
- **A shop's rating is a blend**: `rating_base_avg/count` (seeded demo rating, zero for real shops) plus published reviews. Hiding a review recomputes it. The shop's displayed rating column stays what every card already reads.
- **Reporting a review is the seller's only lever**; it is not a takedown. A review a seller reported and staff kept cannot be reported again. Replies are one per review and public.
- **Conversations are threads**: per order (one per seller order, works with the order link) or per buyer, shop and product. Email to the other side is throttled to one pending message email per thread. Staff see conversations only through the order (support, read only).
- **The shop window hides seller roles**, so "you cannot message your own shop" asks the database, not the session.
- **Every storefront field a new shop may leave empty (tagline, city, story) must be null-safe**: the new-shop path is now part of the browser flows.

## Phase 8 decisions
- **Ads are paid from earnings, not a wallet.** A charged click debits the seller's ledger balance (`seller_payable`) and credits `ad_revenue`, so there is no card top-up to build before a payment provider exists, finance sees ad revenue next to commission, and payouts automatically shrink by what was spent. A campaign stops serving when the seller's earnings cannot cover the next click.
- **Generalised second price with a floor.** The winner pays one cent over the next bid, at least `ads_min_bid_cents`, at most its own bid. The price is fixed when the ad is served and signed into the click token, so a click always costs what the shopper's page promised.
- **Only billable clicks are counted.** A replayed, expired or forged token does nothing; a repeat click from the same address on a campaign within 30 minutes and any click by the seller's own team are filtered (not counted, not charged); a click after a budget is used up or the balance is empty is not charged. Impressions count when an ad is served.
- **Restricted categories cannot be advertised** (toys, perfume, hair), and a staff stop is a hard stop the seller cannot undo.
- **Sponsored pieces take a fixed slot and replace their organic copy**; organic ranking is never changed by a bid.
- **`AD_SECRET` must be set in production** (the server refuses to start without it); development uses a fixed dev-only secret.

## Phase 9 decisions
- **Preferences are by email address, not account**, so a guest who clicks "unsubscribe" in a review request is honoured, and the same choice shows when they later sign up. Receipts and order updates are exempt on purpose (and say so).
- **`enqueue()` is the single gate for email**: it consults the preference and returns whether it queued, so no caller can forget. The inbox and push are written by `notifyUsers()` in the same transaction as the event, so a rolled-back order or refund never notifies anyone.
- **Push defaults:** on for orders and messages, off for reviews. Push bodies are short (60 characters of a message) because lock screens show them. A push is only queued if the server has VAPID keys, the person has a device and has push on for that kind.
- **A device the browser forgot (404 or 410) is deleted**; other failures retry up to five times. Ten devices per person.
- **Signed links use their own secret** (`NOTIFY_SECRET`, required in production) and carry no expiry: an unsubscribe link should keep working. Order links are unchanged.
- **The web server raises Fastify's URL-parameter limit to 600** because signed tokens exceed the default 100.
- **Mail and push configuration lives in the environment**: `SMTP_URL`, `EMAIL_FROM`, `PUBLIC_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `NOTIFY_SECRET`, `AD_SECRET`.
