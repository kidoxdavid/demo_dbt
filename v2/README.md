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
