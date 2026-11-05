#!/usr/bin/env bash
# Prove a backup can be restored: load it into a scratch database and compare it with the manifest taken at backup time.
#   usage: ops/restore-verify.sh <backup-folder> [target-database-url]
# The target must be a SCRATCH database (name must contain "restore" or "test"); it is dropped and recreated.
# To really restore production, point the target at the new, empty production database after stopping the app.
set -euo pipefail
src="${1:?usage: restore-verify.sh <backup-folder> [target-database-url]}"
target="${2:-postgres://es2:es2_pw@localhost:5432/eazystores2_restore}"
dbname="${target##*/}"; admin="${target%/*}/postgres"
case "$dbname" in *restore*|*test*) ;; *) echo "refusing: target database name must contain 'restore' or 'test'"; exit 2;; esac
( cd "$src" && sha256sum -c db.dump.sha256 )
start=$(date +%s)
psql "$admin" -q -c "DROP DATABASE IF EXISTS \"$dbname\"" -c "CREATE DATABASE \"$dbname\""
psql "$target" -q -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" -c "CREATE EXTENSION IF NOT EXISTS citext" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$target" "$src/db.dump" 2>&1 | grep -v "already exists" || true
fail=0
while IFS='|' read -r name expected; do
  case "$name" in
    ledger_sum) actual=$(psql "$target" -At -c "SELECT coalesce(sum(amount_cents),0) FROM ledger_entries");;
    migrations) actual=$(psql "$target" -At -c "SELECT count(*) FROM schema_migrations");;
    *)          actual=$(psql "$target" -At -c "SELECT count(*) FROM $name");;
  esac
  if [ "$actual" = "$expected" ]; then echo "ok    $name = $actual"; else echo "FAIL  $name expected $expected got $actual"; fail=1; fi
done < "$src/manifest.txt"
[ "$(psql "$target" -At -c "SELECT coalesce(sum(amount_cents),0) FROM ledger_entries")" = "0" ] && echo "ok    ledger balances to zero" || { echo "FAIL  ledger does not balance"; fail=1; }
echo "restore took $(( $(date +%s) - start )) s"
[ $fail = 0 ] && echo "RESTORE VERIFIED" || { echo "RESTORE FAILED"; exit 1; }
