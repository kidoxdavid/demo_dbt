# Design system status (Phase D0)

## What exists
- `design/eazystores/source/` the approved mockup source (Appendix A), plus `make_reference_offline.js` (same output, fonts served locally because Google Fonts is unreachable in the build sandbox).
- `design/eazystores/reference/` the 17 reference PNGs. `design/eazystores/sheets/` the generated mockup pages.
- `apps/web`: self-hosted Fraunces and Inter (`public/fonts`), tokens (`src/styles/tokens.css`: Atelier, Noir, Sage, Blush, Sky, automatic dark), the approved icon set and product-art shapes (ported programmatically from the mockup source, not retyped), shared components (`src/components/ui.tsx`), the hidden `/_design` page, and the first real screen: buyer home on a phone.
- `apps/e2e/visual.mjs`: pixelmatch visual-regression (threshold 0.1, anti-aliasing ignored, pass at most 1.5% of pixels differ, only the 24px bottom corners of phone references masked). `npm run lint:tokens` fails on any raw hex outside tokens and art.

## Measured results (run `CHROMIUM_PATH=... node apps/e2e/visual.mjs`)
| Screen | Result |
|---|---|
| buyer-home (Atelier) | 0.20% differ |
| home-direction-atelier / noir / sage | 0.20% / 0.18% / 0.20% |
| dark auto-switch (Atelier + dark system) vs Noir reference | 0.18% |
| buyer-category (phone) | 0.05% differ |
| buyer-product (phone) | 0.30% differ |
| buyer-basket (phone) | 0.11% differ |
| buyer-home-desktop (1280 wide, full page) | 0.15% differ |
| shop-look-atelier / noir / sage (phone) | 0.35% / 0.33% / 0.13% differ |
| seller-onboarding 1 / 2 / 3 / 4 (phone) | 0.92% / 0.10% / 0.27% / 1.18% differ |
| studio-desktop (1180 x 860) / studio-phone | 0.76% / 0.56% differ |
| /_design panels for all five looks | component-library snapshots (self-baselined, 0.00% on re-run) |

## Deviations (reported)
1. **Phone references were 780 px tall, not the documented 798.** The original generator used a 900 px viewport, which cut every phone screenshot 18 px short. `make_reference_offline.js` uses a 1000 px viewport, so references are now the full 390 x 798 screen. Content is otherwise identical.
2. **Offline fonts.** Same families and axes (Fraunces opsz+wght, Inter wght) from the `@fontsource-variable` packages instead of Google Fonts.
3. **Built in `v2/`** next to the earlier app so nothing was overwritten. Tell me if you want it moved to the repo root.
4. Phases 4 and 5 built every reference screen (all 17 are now covered). Phase 4 built eight of them (desktop home, category, product, basket, three shop looks) from live API data. Phase 5 added the four onboarding steps and the two studio screens. Blush and Sky have tokens but no mockup.
5. **Shop-look tests use the mockup's own data, served by request interception** (`apps/e2e/fixtures/shop-*.json`). The shop mockups show "Bud vase / Speckled mug / Planter / Serving bowl" by Clay & Ember, which contradicts the category mockup ("Speckled stoneware mug", bowl by Studio Marlow). Both cannot come from one catalogue, so the components are tested against the mockup data; the real shop page reads `/api/shops/:slug` and `/api/products?shop=`, covered by the flow test. Noir fixtures use the dark `ink` art tone, as the mockup does.
6. **Basket and product titles are the real titles.** The basket mockup shows "Tall bud vase" and "Dusk over the hills"; the catalogue names are "Tall bud vase in terracotta glaze" and "Dusk over the hills, A4 print", so the basket clamps a title to one line with an ellipsis. Costs a few pixels of text diff.
7. **Small additions the mockups do not show (all tiny in pixels):** a 36 px round back button on phone product and shop pages (no other way back in an installed app); the product page says "taxes **added** at checkout" (the mockup says "included", which would be untrue: GST is added at checkout); the photo dots only appear when a product has more than one photo (the mockup draws three over a single illustration).
8. **One gift card for the whole basket**, as in the mockup; it is stored per maker, so every maker receives the same note.

## Not mocked (built from the same tokens, listed on `/_design`)
Hover/focus/pressed states, skeletons and empty states, errors and validation, dialogs and toasts, tables-to-cards on phones, admin/support/finance/marketing consoles, Blush and Sky shop looks.

## Phase 5 notes (seller onboarding and studio)
9. **Onboarding has five steps; the mockups show four screens.** The mockups' progress bar says "Step 5 of 5" on the "live" screen, so a fourth step exists but was never drawn. It is **Shipping and returns** (time to get an order ready, flat shipping price, free-shipping threshold, returns policy), built from the same tokens and not pixel-tested.
10. **Creating the account** has no mockup: it is a bottom sheet over step 1 (name, shop name, email, password) after "Continue", so the four drawn screens are unchanged. "Already selling? Sign in" sits under "Tell us".
11. **The QR code is real and scannable.** The mockup's is decorative random squares. The live screen still passes (1.18%, limit 1.5%) but that screen is the closest to the limit, almost all of it the QR block.
12. **Studio home shows real numbers.** The mockup's $642 / 14 orders / 1.2k visits / +18% cannot be produced honestly from five demo orders, so those digits differ (the test only checks layout). The Messages card shows 0 with "Buyer messages are coming soon" (messaging is a later phase), status chips read "To ship" (not "Ship today"), and order titles are the real, longer titles.
13. **Onboarding step 3 test** uses a draft with a real uploaded photo: the harness screenshots the app's own illustration (`/_art/:kind/:tone`, development only) and uploads it, because publishing needs a real photo.
14. **Not mocked, built from tokens:** orders list and detail, products list and editor, shop settings, shipping profiles, studio sign-in, "not available yet" pages for Messages, Promotions, Insights and Payouts.
