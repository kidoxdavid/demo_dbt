#!/usr/bin/env bash
# Logical backup of the whole database in PostgreSQL custom format.
# Usage: BACKUP_DATABASE_URL=postgres://owner:pw@host/db ops/backup.sh [output-file]
# The dump contains personal data (customers, emails, addresses): store it ENCRYPTED, restrict access, and delete old copies per your retention policy.
# Managed Postgres with point-in-time recovery is the primary safety net; this is the portable, independently restorable second copy.
set -euo pipefail
: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL}"
out="${1:-eazystores-$(date -u +%Y%m%dT%H%M%SZ).dump}"
pg_dump --format=custom --no-owner --no-privileges --file "$out" "$BACKUP_DATABASE_URL"
echo "wrote $out ($(du -h "$out" | cut -f1))"
