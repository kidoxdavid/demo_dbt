# EazyStores

Multi-tenant commerce platform for small businesses. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the plan, status and decisions.

## Run the API (Phase 1)

```bash
cd apps/api && npm install
# Postgres 16 with roles eazy_owner (owns schema, runs migrations) and eazy_app (runtime, RLS applies)
export MIGRATION_DATABASE_URL=postgres://eazy_owner:...@localhost:5432/eazystores
export DATABASE_URL=postgres://eazy_app:...@localhost:5432/eazystores
npm run migrate && npm start
npm test        # uses database eazystores_test, drops and recreates its public schema
```

Never commit credentials. The URLs above show the variable names; the defaults in `src/config.ts` are for local development only.

## Run the web app

```bash
cd apps/web && npm install && npm run dev      # http://localhost:5173, proxies /api to :3000
node e2e/flow.cjs ./shots                      # browser end-to-end test (needs API + web running, Playwright installed)
```

Payments are **simulated** in development (`PAYMENT_PROVIDER=simulated`, the default outside production). Nothing moves real money.
In production set `ALLOWED_ORIGINS` to the public web origin.

## Admin and end-to-end tests

```bash
cd apps/api && npm run make-staff -- you@example.com super_admin 'a-long-password'   # creates/promotes a platform staff user
# log in at /login: staff accounts without a store are sent to /admin
cd apps/web
node e2e/seed-demo.cjs                  # six demo stores through the real API (dev only)
node e2e/flow.cjs ./shots               # seller + customer journey
node e2e/flow2.cjs ./shots              # customisation, share/QR, refunds, admin (needs e2e-admin@eazystores.test staff user)
```
Set `PUBLIC_URL` (share links and QR codes) and `ALLOWED_ORIGINS` in production.

## More end-to-end tests and operations

```bash
node e2e/flow3.cjs ./shots              # email verification, sales tax, password reset, seller two-factor
ONLY=desktop node e2e/flow4.cjs ./shots # store review, verification, moderation, search, legal pages, account closure (also ONLY=mobile)
npm run build && npm run start:prod     # in apps/api: compiled production server (see docs/DEPLOY.md for required environment)
ops/backup.sh and ops/restore-check.sh  # backup and a restore test that fails on a bad backup
```
See `docs/PAYMENTS.md` (provider research and plan) and `docs/DEPLOY.md` (operations). The legal pages in the app are **drafts that a lawyer must review**.
