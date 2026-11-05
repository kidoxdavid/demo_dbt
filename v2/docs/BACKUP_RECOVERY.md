# Backup and recovery

## What is protected, and how
| Thing | Where | Protection |
|---|---|---|
| Orders, ledger, people, catalogue | Postgres | Render's automatic backups and point-in-time recovery (paid Postgres plans; check the retention window of the plan you choose) **plus** our own nightly `ops/backup.sh` dump kept outside Render |
| Photos and videos | disk at `/var/data/uploads` | Render disk snapshots (daily, restorable from the dashboard) plus `uploads.tgz` in the nightly dump |
| Secrets | Render environment | Keep a copy of `AD_SECRET`, `NOTIFY_SECRET`, `VAPID_*` in a password manager; losing `NOTIFY_SECRET` breaks emailed unsubscribe links |

## Targets (what to expect, and what is only a target)
- **Recovery point (RPO):** with Render point-in-time recovery, minutes (not yet verified on a real Render database). With only our nightly dump, up to 24 hours of orders.
- **Recovery time (RTO):** measured locally: a dump of the 20,000-product test database restores in **2 s** (2.6 MB). A production database will be larger and Render provisioning adds minutes; plan for about an hour including DNS and checks. Not yet measured on Render.

## Nightly dump
Run `ops/backup.sh` from any machine that can reach the database (external connection string from Render, with `sslmode=require`) and has `pg_dump` 16 and `psql`. Example cron: `15 3 * * *  DATABASE_URL='...' BACKUP_DIR=/srv/es-backups ops/backup.sh`. Copy the folder off that machine (another provider or bucket). It writes `db.dump`, a checksum, and a manifest of row counts and the ledger sum; it prunes dumps older than 14 days (`KEEP_DAYS`).

## Restore drill (do this before launch, then every quarter)
1. `ops/restore-verify.sh /srv/es-backups/<stamp>` restores into a scratch database named with `restore` in it and compares every count in the manifest, checks the ledger sums to zero and that all migrations are present. It prints `RESTORE VERIFIED` or fails.
2. Record the date, the dump size and how long it took in `docs/OPERATIONS.md`'s drill log.

## Real recovery
1. Put the site in maintenance: suspend the Render web service.
2. Either use Render's point-in-time recovery (creates a new database at the chosen moment) or create an empty database with `pgcrypto`, `citext`, `pg_trgm` and run `pg_restore --no-owner --dbname=<new url> db.dump`.
3. Restore uploads: `tar -xzf uploads.tgz -C /var/data/uploads` (Shell tab), or a disk snapshot.
4. Point `DATABASE_URL` at the new database, deploy (the pre-deploy migration is a no-op if the dump is current), resume.
5. Verify: `/readyz`, an order page, the finance console ledger total is 0.00, a product photo loads.
6. Orders placed after the recovery point are lost from the database. Payment provider records are the source of truth for money: reconcile them against orders (finance console reports) before reopening.
