#!/usr/bin/env bash
# Back up the EAZYstores database (and uploaded files) to a timestamped folder.
#   DATABASE_URL   database to back up            (default: local dev database)
#   BACKUP_DIR     where backups are written      (default: ./backups)
#   UPLOAD_DIR     uploaded media to include      (optional)
#   KEEP_DAYS      delete backups older than this (default: 14)
set -euo pipefail
DATABASE_URL="${DATABASE_URL:-postgres://es2:es2_pw@localhost:5432/eazystores2}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/$stamp"
mkdir -p "$dest"
# custom format: compressed, restorable table by table, consistent snapshot of one moment
pg_dump --format=custom --no-owner --no-privileges --file="$dest/db.dump" "$DATABASE_URL"
if [ -n "${UPLOAD_DIR:-}" ] && [ -d "$UPLOAD_DIR" ]; then tar -czf "$dest/uploads.tgz" -C "$UPLOAD_DIR" .; fi
# the same facts the restore check compares against
psql "$DATABASE_URL" -At -c "SELECT 'ledger_sum', coalesce(sum(amount_cents),0) FROM ledger_entries" > "$dest/manifest.txt"
for t in users sellers products variants orders ledger_entries audit_log; do
  psql "$DATABASE_URL" -At -c "SELECT '$t', count(*) FROM $t" >> "$dest/manifest.txt"
done
psql "$DATABASE_URL" -At -c "SELECT 'migrations', count(*) FROM schema_migrations" >> "$dest/manifest.txt" 2>/dev/null || true
( cd "$dest" && sha256sum db.dump > db.dump.sha256 )
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true
echo "backup written: $dest"
