# Operations

## Where to look
- **Logs:** Render service > Logs. One JSON line per request (method, safe path, status, ms, request id; no query strings, cookies or tokens) and `error` lines with a request id. A buyer who sees "something went wrong" gets that request id; search the logs for it.
- **Health:** `/healthz` (process up), `/readyz` (database answers). Render uses `/readyz` and restarts the service after repeated failures.
- **Staff consoles:** `/admin`, `/support`, `/finance`, `/marketing` each have their own sign-in. The audit log (admin and support) shows who changed what.
- **Alerts:** Render notifications (deploy failed, service unhealthy, disk nearly full, database nearly full) to the owner's email. Add an uptime check on `https://<site>/readyz` (any free monitor, alert after 2 failures). No error-tracking service is wired (see Known gaps in `LAUNCH_READINESS.md`).

## Daily (5 minutes)
1. Finance console: ledger total is 0.00 (it must always be zero). Any non-zero value: stop, do not issue payouts, investigate.
2. Support console: orders stuck unpaid for more than a day; new support notes.
3. Admin > moderation: new reports and new makers waiting for review.
4. Logs: search `"level":"error"` for the last 24 hours; every error line should be explained or ticketed.
5. Email outbox: failed rows (five tries then stop) mean a mail provider problem; check provider status and SMTP settings.

## Weekly
1. Confirm last night's `ops/backup.sh` produced a folder with a recent date and the manifest looks sane.
2. Finance: payout balances against what is owed to makers; release payouts that have passed the hold period.
3. Review failed sign-in spikes and rate-limit hits in the logs.
4. `npm audit --omit=dev` on `main`; update and redeploy if anything high appears.
5. Disk and database usage in Render.

## Quarterly
- Run the restore drill (`docs/BACKUP_RECOVERY.md`) and add a line to the log below.
- Rotate staff passwords that are old; remove staff who have left.

## Before every release
`npx tsc --noEmit` in `apps/api` and `apps/web`; `npm run lint:tokens -w @eazystores/web`; `npm test -w @eazystores/api`; on a fresh demo seed: `node apps/e2e/visual.mjs` (23 screens within 1.5%) then the browser flows (`flow`, `studio-flow`, `console-flow`, `engagement-flow`, `ads-flow`, `notifications-flow`) and `a11y.mjs`.

## Incident basics
1. Is `/readyz` failing? Database down or out of connections: Render database page; restart the service after the database recovers.
2. Many 500s after a deploy: roll back by redeploying the previous commit in Render (migrations are forward-only, so only roll back when the release added no migration, otherwise fix forward).
3. Orders paid but not marked paid: the payment webhook did not arrive. Re-deliver it from the provider's dashboard; processing is idempotent, so repeats are safe.
4. A maker or buyer reports a data problem: use the support console (notes are audited); never edit the ledger by hand, it is append-only by design. Corrections are new entries through refunds.
5. Suspected account compromise: admin console > people > disable (needs a reason, audited), then reset the password.

## Restore drill log
| Date | Dump size | Restore time | Result | By |
|---|---|---|---|---|
| 2026-11-05 | 2.6 MB (20,000 products) | 2 s | verified (local scratch database, not Render) | build session |
