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
| /_design panels for all five looks | component-library snapshots (self-baselined, 0.00% on re-run) |

## Deviations (reported)
1. **Phone references were 780 px tall, not the documented 798.** The original generator used a 900 px viewport, which cut every phone screenshot 18 px short. `make_reference_offline.js` uses a 1000 px viewport, so references are now the full 390 x 798 screen. Content is otherwise identical.
2. **Offline fonts.** Same families and axes (Fraunces opsz+wght, Inter wght) from the `@fontsource-variable` packages instead of Google Fonts.
3. **Built in `v2/`** next to the earlier app so nothing was overwritten. Tell me if you want it moved to the repo root.
4. The remaining 12 reference screens (desktop home, category, product, basket, four onboarding steps, three shop looks, two studio screens) are **not built yet**; each gets a screen component and a visual test in the following phases. Blush and Sky have tokens but no mockup.

## Not mocked (built from the same tokens, listed on `/_design`)
Hover/focus/pressed states, skeletons and empty states, errors and validation, dialogs and toasts, tables-to-cards on phones, admin/support/finance/marketing consoles, Blush and Sky shop looks.
