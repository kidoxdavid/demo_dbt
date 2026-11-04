#!/usr/bin/env bash
# Proves a backup is restorable: restores it into a throwaway database and checks the data makes sense. A backup you have never restored is a hope, not a backup.
# Usage: RESTORE_ADMIN_URL=postgres://superuser@host/postgres ops/restore-check.sh backup.dump
# Needs a superuser (or a role that can CREATE DATABASE and bypass row-level security) because the schema uses forced row-level security.
set -euo pipefail
: "${RESTORE_ADMIN_URL:?set RESTORE_ADMIN_URL (a superuser connection to the maintenance database)}"
dump="${1:?usage: restore-check.sh backup.dump}"
name="restore_check_$(date +%s)_$$"
cleanup() { psql "$RESTORE_ADMIN_URL" -qAtc "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT
psql "$RESTORE_ADMIN_URL" -qAtc "CREATE DATABASE \"$name\""
target="${RESTORE_ADMIN_URL%/*}/$name"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$target" "$dump"
q() { psql "$target" -qAtc "$1"; }
migrations=$(q "SELECT count(*) FROM schema_migrations")
users=$(q "SELECT count(*) FROM users")
orders=$(q "SELECT count(*) FROM orders")
unbalanced=$(q "SELECT count(*) FROM (SELECT group_id FROM ledger_entries GROUP BY group_id HAVING sum(amount_cents) <> 0) x")
negative_stock=$(q "SELECT count(*) FROM inventory_levels WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand")
echo "restored OK: migrations=$migrations users=$users orders=$orders unbalanced_ledger_groups=$unbalanced invalid_stock_rows=$negative_stock"
[ "$migrations" -gt 0 ] || { echo "FAIL: no migrations recorded" >&2; exit 1; }
[ "$unbalanced" -eq 0 ] || { echo "FAIL: the ledger does not balance in this backup" >&2; exit 1; }
[ "$negative_stock" -eq 0 ] || { echo "FAIL: inventory invariants violated in this backup" >&2; exit 1; }
echo "PASS"
