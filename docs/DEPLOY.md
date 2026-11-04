# Deployment and operations

Status: the **application build, production-mode behaviour, backups and restore check were tested**. The **Dockerfiles, compose file and nginx config were written but NOT built or run**, because the build sandbox had no Docker daemon. Build them in CI and fix whatever the first run shows before relying on them.

## What was verified

- `npm run build` compiles the API; the compiled server was started with `NODE_ENV=production` and checked:
  `/health` and `/ready` respond; session cookies are `HttpOnly; Secure; SameSite=Lax`; checkout answers `payments_not_configured` without a real provider; the simulated-payment endpoint does not exist (404); logs are structured JSON; cookies and auth headers are redacted from logs.
- `ops/backup.sh` produced a dump; `ops/restore-check.sh` restored it into a throwaway database, confirmed all migrations, a balanced ledger and valid stock rows, and dropped the database. A truncated dump makes the check **fail with a non-zero exit** and still cleans up.

## Environment

Copy `.env.example` to `.env` (never commit it). Required in production:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime connection. Must use the restricted `eazy_app` role (row-level security applies to it). |
| `MIGRATION_DATABASE_URL` | Owner role, used only to run migrations. |
| `PUBLIC_URL`, `ALLOWED_ORIGINS` | Public web origin: share links, QR codes, email links, and the cross-site-request check. |
| `MFA_ENC_KEY` | 64 hex characters (`openssl rand -hex 32`). Encrypts two-factor secrets. **Losing it locks out every enrolled user. Back it up separately from the database.** |
| `SMTP_URL`, `MAIL_FROM` | Real email. If `SMTP_URL` is empty, mail is recorded but not sent. |
| `TRUST_PROXY=true` | When behind a load balancer, so rate limits see real client addresses. |

Switches (production defaults): `REQUIRE_EMAIL_VERIFICATION=true`, `REQUIRE_TERMS=true`, `REQUIRE_STAFF_MFA=true`, `PAYMENT_PROVIDER` unset (no real provider is integrated). Turn on store review in the admin area before launch.

## Database

- Two roles: an **owner** (runs migrations) and a **restricted app role** (`NOSUPERUSER NOBYPASSRLS`) used at runtime. Tenant isolation relies on the app role never being a superuser or table owner.
- Run `node dist/migrate.js` as part of release, before starting the new version. Migrations are forward-only SQL files.
- Use managed Postgres with **point-in-time recovery** as the primary safety net, in a Canadian region if data residency matters. `ops/backup.sh` is the portable second copy.
- **Backups contain personal data.** Store them encrypted, restrict access, and delete old copies on your retention schedule.
- **Rehearse restores on a schedule**: `RESTORE_ADMIN_URL=... ops/restore-check.sh backup.dump` (needs a superuser because the schema uses forced row-level security).

## Staff accounts and recovery

- Create staff: `npm run make-staff -- email@example.com super_admin 'a-long-password'` (database owner access). Staff must enrol in two-factor at first sign-in.
- Lost phone **and** recovery codes: `npm run reset-mfa -- email@example.com` (clears two-factor, signs the user out everywhere, audited). It needs database owner access, so it is an operator action, not something support can do in the app.

## Files and images

Images are decoded and re-encoded (EXIF stripped, capped at 1600px, thumbnail made). Storage is a local directory (`UPLOAD_DIR`) behind a `Storage` interface. **For more than one server, or any production use, an S3-compatible adapter is needed** (not built): local disk on one container is lost with the container unless a volume is mounted, and cannot be shared between instances.

## Not done

- Monitoring and alerting (no error-tracking vendor chosen; the API logs JSON and exposes `/ready`).
- S3-compatible storage adapter and CDN.
- Container images, compose stack and nginx config **untested** (see top).
- Load and performance testing.
- An uptime check, log shipping, and a documented incident process.
- Secrets management beyond environment variables.
