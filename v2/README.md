# EAZYstores v2

Marketplace for small makers and sellers of non-food goods. Monorepo: `apps/api` (Fastify, Postgres, zod), `apps/web` (React, Vite), `apps/e2e` (visual regression), `design/` (approved mockups and references).

## Run it (Postgres 14+ with `pg_trgm`, `citext`, `pgcrypto`)
```bash
# one-time database setup (as the Postgres admin)
#   CREATE ROLE es2 LOGIN PASSWORD 'es2_pw' CREATEDB;  CREATE DATABASE eazystores2 OWNER es2;  CREATE DATABASE eazystores2_test OWNER es2;
#   then in BOTH databases:  CREATE EXTENSION pgcrypto; CREATE EXTENSION citext; CREATE EXTENSION pg_trgm;
npm install
export DATABASE_URL=postgres://es2:es2_pw@localhost:5432/eazystores2     # change host/port if yours differs (PowerShell: $env:DATABASE_URL = "...")
npm run migrate -w apps/api          # forward-only migrations + launch categories
npm run seed:demo -w apps/api        # dev only: one demo person per role (password demo-password-2026)
npm run start -w apps/api            # API on :3100
npm run dev -w apps/web              # website on :5180
npm test -w apps/api                 # API tests; the test database name must contain "test" and is rebuilt every run
```
Staff: `npm run make-staff -w apps/api -- you@example.com admin 'a-long-password'`.
Visual tests: `CHROMIUM_PATH=/path/to/chromium node apps/e2e/visual.mjs` (needs the website running on :5180).
Browser flows (buyer, studio, staff consoles, engagement): `node apps/e2e/flow.mjs`, `studio-flow.mjs`, `console-flow.mjs`, `engagement-flow.mjs`, `ads-flow.mjs`, `notifications-flow.mjs` (start the API with `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` from `npm run make-vapid -w apps/api` for the last one). The flows create shops, products and orders in the database, so run the visual tests first on freshly seeded data, then the flows. They need the stack running on the demo data. Start it with a pinned clock and a higher sign-in limit (the flows sign in many times a minute; production keeps 10):
`EAZY_FAKE_NOW=2026-11-05T16:41:00Z npx tsx src/seed-demo.ts` then `AUTH_RATE_LIMIT_MAX=1000 EAZY_FAKE_NOW=2026-11-05T16:41:00Z npm run start -w apps/api` and `npm run dev -w apps/web`.
Demo staff sign-ins (password `demo-password-2026`): admin@, support@, finance@, catalogue@, marketing@eazystores.test at /admin, /support, /finance, /marketing.


Production settings for notifications: `SMTP_URL`, `EMAIL_FROM`, `PUBLIC_URL` (used in email links), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `NOTIFY_SECRET` and `AD_SECRET`. The server refuses to start in production without the two secrets.

## Operations (Phase 10)
- **Production refuses unsafe settings.** With `NODE_ENV=production` the server stops at start-up if the database URL is the development one, `ALLOWED_ORIGINS`/`PUBLIC_URL` are not https, `AD_SECRET`/`NOTIFY_SECRET` are under 32 characters or placeholders, `SMTP_URL` or `EMAIL_FROM` is missing, or `PAYMENT_PROVIDER=mock`. It warns about `TRUST_PROXY` (set it behind a load balancer so rate limits see real addresses), no payment provider, no VAPID keys and `UPLOAD_DIR`.
- **Tuning:** `DB_POOL_MAX` (20), `DB_STATEMENT_TIMEOUT_MS` (30000), `DB_LOCK_TIMEOUT_MS` (15000), `DB_IDLE_TX_TIMEOUT_MS` (30000), `LIST_CACHE_MS` (10000; 0 turns shared listing answers off).
- **Health:** `GET /healthz` (process is up), `GET /readyz` (database answers). Stop the server with SIGTERM; it finishes in-flight requests and exits 0.
- **Backup:** `DATABASE_URL=... BACKUP_DIR=/backups UPLOAD_DIR=/data/uploads ops/backup.sh` (run it nightly from the host's scheduler). **Prove it restores:** `ops/restore-verify.sh /backups/<stamp>` (loads into a scratch database named `...restore...` and checks counts, a zero ledger sum and migrations). To recover for real: stop the app, create an empty database with the three extensions, `pg_restore --no-owner --dbname=<new url> db.dump`, unpack `uploads.tgz`, point `DATABASE_URL` at it, start the app. Recovery point = the last backup; recovery time on the 20,000-product test data was 2 s (measured on one machine, not production).
- **Load test:** `npm run seed:load -w apps/api` builds a 20,000-product database (`eazystores2_load`); `autocannon` is installed for timing.
- **Accessibility check:** `CHROMIUM_PATH=/path/to/chromium node apps/e2e/a11y.mjs` (website on :5180, demo seed).
- **Privacy requests:** a signed-in person downloads their data and deletes their account from Account; sales records stay without personal details.

## Deploying (Phase 11)
The API also serves the built website in production (`npm run build -w @eazystores/web`, then start the API with `NODE_ENV=production`; `WEB_DIST` overrides the folder). `render.yaml` at the repository root is the Render blueprint. Read `docs/DEPLOYMENT.md` to deploy, `docs/OPERATIONS.md` to run it, `docs/BACKUP_RECOVERY.md` for backups, and `docs/LAUNCH_READINESS.md` for what is and is not ready (payments are the blocker).

## Quality checks (run these before anything ships)
`node apps/e2e/crawl.mjs` opens every page of every portal on a phone and a laptop and lists anything a person would trip on (set `ADMIN_PW`, `SUPPORT_PW`, `FINANCE_PW`, `MARKETING_PW`, `MAKER_EMAIL`, `MAKER_PW` for your sign-ins). `node apps/e2e/buyer-journey.mjs` buys something as a brand-new person on a phone and a laptop. Both need the website on :5180 and the API running.
