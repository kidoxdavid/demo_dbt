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
