# Launch readiness

Plain statement of what has been proven, what has not, and what only a person can do. Date: 2026-11-05. **Verdict: not ready to take real orders.** The site can go live as a browsable catalogue with makers onboarding, but no real payment can be taken until a payment provider is built and tested (blocker 1).

## Launch blockers (nothing can sell until these are done)
1. **No real payment provider.** Only the simulated provider exists. Production correctly refuses it, so checkout answers "payments not configured". Needed: a Stripe adapter behind the existing `PaymentProvider` interface (payment intents, refunds, signed webhooks), Stripe Connect Express for maker payouts, Stripe Tax decisions, and a go-live pass in Stripe test mode first. This needs your Stripe account and keys and is a build task, not configuration.
2. **Maker payouts are not connected.** The studio payouts page says so honestly; finance can record payouts by hand against the append-only ledger, but no money moves.
3. **Real email not proven.** SMTP delivery is tested against a local server that speaks the protocol, never through a real provider (SPF/DKIM/DMARC, inbox placement).
4. **Legal text** (terms, privacy policy, maker agreement, prohibited items, returns) is not written. The privacy export and deletion mechanism exists; the policies that must describe it do not.

## Verified (by running it, 2026-11-05)
- API: **144 tests** in 15 files pass on real Postgres (money and ledger, stock races, webhooks, authorisation, privacy, ops, performance, web serving). `tsc` clean for api and web; token lint clean; `npm audit --omit=dev` 0 findings.
- Security sweep over every registered route (sign-in, window and role, cross-site origin check, no server errors on malformed input); deny-by-default guard; production start-up refuses unsafe settings; mock payments refused.
- Concurrency: 40 buyers for 10 units gives exactly 10 orders; 20 identical payment webhooks apply once; ledger sums to zero.
- 20,000-product load data: category 154 ms, filtered 82 ms, product 79 ms single request; broad search about 970 ms at 20 concurrent.
- **Production build served by the production server** (`NODE_ENV=production`, built website served by the API, strict page security policy): pages, API, health, caching and headers checked; 20 of the visual screens match the approved mockups on that build (largest difference within the 1.5% limit). The other 3 are development-only by design (two `?look=` design previews and the draft screen that needs the dev photo helper); they pass on the development build (23 of 23).
- Browser flows on the development stack: buyer, studio, staff consoles, engagement, ads, notifications all pass.
- A scripted new maker goes from landing on step 1 to a live shop with a first listing in **2.9 s** on a phone-sized browser. This is a lower bound; the 10-minute target for a real person has **not** been measured with people.
- Backup and restore round trip verified on two databases (scratch restore, counts, ledger, migrations).
- Accessibility: axe on 34 screens (light and dark), no sideways scrolling at 320 px, visible focus. Open: tag contrast 4.26:1 (needs your decision, see `PROJECT_STATUS.md`).
- `render.yaml` parses and its production settings pass the start-up check.

## Not verified
- **The Render blueprint has never been deployed.** Plan names, region, disk and the `rootDir` setting follow Render's documented format but were not run against a real account. Expect to adjust on first deploy. Postgres extensions (`pgcrypto`, `citext`, `pg_trgm`) are standard on Render but not yet confirmed on your plan.
- Custom domain, TLS certificate, DNS records, and the email DNS records.
- Backup and point-in-time recovery on Render; restore time on production-sized data.
- Load on real hardware and real traffic; the persistent disk's behaviour under deploys.
- Real devices: iPhone Safari, Android Chrome, push on a phone, installing to the Home Screen (there is no web app manifest yet, so "install" is not offered).
- Screen reader use; keyboard use beyond six screens.
- Email rendering in real mail apps.
- Canadian tax (GST/PST by province) with an accountant, and privacy-law wording with a lawyer.

## Person-only tasks
Create the Render, Stripe, email-provider and domain accounts; buy the domain; set DNS; enter secrets in Render (never in the repository); create the first admin; write and approve the legal text; recruit the first makers; decide the contrast change; run the real-device checklist below.

## Setup
Follow `docs/DEPLOYMENT.md` (first deploy, settings, domain, email DNS) and `docs/BACKUP_RECOVERY.md` (nightly dump, restore drill). Do the restore drill against the real database before opening.

## Daily and weekly operations
See `docs/OPERATIONS.md` (daily 5-minute checks, weekly, quarterly, release checks, incidents).

## Payments go-live checks (after the Stripe adapter exists)
1. Test mode end to end: card success, decline, 3-D Secure, refund (full and partial), webhook delivered twice, webhook delayed, webhook with a bad signature.
2. Ledger after each: sums to zero; tax, commission and seller payable as expected.
3. Connect: a test maker onboards, a payout is created, a failed payout is handled.
4. Live mode: set live keys and the live webhook secret in Render only; place and refund one real small order; confirm funds, fees and the ledger; then open.
5. Disputes and chargebacks: who is notified, how the ledger records them (not built; define before launch).

## Real-device checklist
On an iPhone (Safari) and an Android phone (Chrome), on mobile data: browse, search, filters, add to basket, checkout form with the keyboard open, pay (test mode), order page; sign up as a maker and publish a listing with a camera photo; messages and notifications; dark mode; text size at 200%; rotate; slow connection (throttled) behaviour. Time a real person doing maker sign-up to live listing (target: under 10 minutes).

## Known gaps (built later or not at all)
- Studio pages "Promotions", "Insights" and "Payouts", and the buyer pages "Gift guides" and "Meet the makers", are placeholders.
- No web app manifest or installable app; push works through the service worker only.
- No French / translation layer (English only).
- No error-tracking service (`SENTRY_DSN` is not wired): errors are in the logs with request ids, and an uptime monitor is the alert.
- No `ADMIN_EMAILS` variable: the first admin is created with `make-staff` from the Shell (deliberate).
- Uploads live on a single disk: one instance only, brief pause on deploy; object storage is the next step before scaling out.
- Search is database search (trigram and text); fine at 20,000 products, to be revisited well beyond that.
- Hosting is a single region, single instance, no staging environment.
