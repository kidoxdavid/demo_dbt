# EAZYstores v2: project status
## Phase D0 (design system): done
Tokens, fonts, icons, art, components, `/_design`, visual-regression harness. Buyer home passes against its references (Atelier, Noir, Sage, dark auto-switch). See `docs/DESIGN.md`.
## Phase 1 (foundation): done
Verified by 20 API integration tests on a real Postgres and by running the CLI and server: migrations (forward-only, idempotent, audit log immutable), buyer sign-up, per-window sign-in with separate sessions and roles, lockout, rate limit, origin check, role grant/revoke with audit and last-admin protection, per-seller permission checks, settings and feature flags with audit, categories and attributes (public tree, inherited attributes, admin CRUD, validation), plain JSON errors.
Not done in this phase (by design, later phases): email verification and password reset (need the email outbox), staff two-factor, sellers/shops/products, orders, payments, search, uploads, push.
## Not verified
Nothing in v2 has run on a real device, with Stripe, with real email or with push notifications.
## Next
Phase 2: shops and sellers, products, variants (one-of-a-kind and made-to-order), images and video pipeline, search and filters, and the demo seed (shops, products and orders with the fixed values from the brief) that the remaining screen tests need.
