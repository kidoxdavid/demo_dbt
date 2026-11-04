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
