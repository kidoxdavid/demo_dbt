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
