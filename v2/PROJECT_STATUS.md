# EAZYstores v2: project status
## Phase D0 (design system): done
Tokens, fonts, icons, art, components, `/_design`, visual-regression harness. Buyer home passes against its references (Atelier, Noir, Sage, dark auto-switch). See `docs/DESIGN.md`.
## Phase 1 (foundation): done
Verified by 20 API integration tests on a real Postgres and by running the CLI and server: migrations (forward-only, idempotent, audit log immutable), buyer sign-up, per-window sign-in with separate sessions and roles, lockout, rate limit, origin check, role grant/revoke with audit and last-admin protection, per-seller permission checks, settings and feature flags with audit, categories and attributes (public tree, inherited attributes, admin CRUD, validation), plain JSON errors.
Not done in this phase (by design, later phases): email verification and password reset (need the email outbox), staff two-factor, sellers/shops/products, orders, payments, search, uploads, push.
## Phase 2 (sellers, shops, catalogue, media, search, demo data): done
Verified by 43 API tests in total (23 new): seller sign-up through the studio window, shop settings, the media pipeline (three WebP sizes, metadata stripped, orientation fixed, disk and database copies, self-healing, Range requests, video conversion with ffmpeg, fake/corrupt/oversize refusals, public vs owner access), drafts with live readiness, publishing rules (required attributes, restricted-category confirmation and review queue, prohibited items, human-hair sourcing), options and variants, one-of-a-kind enforcement (even by raw SQL), made to order, duplicate, bulk edit, per-seller isolation, listing and filters and facets, multi-category membership, search (exact first, verified synonyms, typo fallback, injection-safe), product detail, and the fixed demo catalogue (412 pieces from 38 makers).
Not done here: collections and gift guides, reviews, shipping profiles and delivery estimates (commerce phase), CSV import (studio phase), email and push.
Run `npm run seed:demo -w apps/api` for the demo shops. Seller login: amara@clayember.test (password demo-password-2026).

## Not verified
Nothing in v2 has run on a real device, with Stripe, with real email or with push notifications.
## Next
Phase 3: commerce core (cart per seller, checkout, stock reservations, seller orders, payments with a mock provider and webhook, ledger, refunds, notifications outbox, jobs, shipping profiles and delivery estimates).
