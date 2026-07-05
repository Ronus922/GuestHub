#!/usr/bin/env bash
# Nightly GuestHub backup: schema-scoped pg_dump + room-image uploads.
# Keeps 14 days. Installed via cron (see D49 closure audit):
#   15 3 * * * bash /var/www/guesthub-production/scripts/nightly-backup.sh >> /home/ubuntu/logs/guesthub-backup.log 2>&1
set -euo pipefail

DEST="${DEST:-/home/ubuntu/guesthub-backups}"
PROD_DIR="${PROD_DIR:-/var/www/guesthub-production}"
STAMP="$(date +%Y%m%dT%H%M%S)"
KEEP_DAYS=14

mkdir -p "$DEST"

# 1. database — guesthub schema only, via the supabase-db container
docker exec supabase-db pg_dump -U supabase_admin -d postgres --schema=guesthub \
  > "$DEST/guesthub_db_${STAMP}.sql"

# 2. uploaded media — the durable store outside the app tree (lib/rooms/uploads.ts)
UPLOADS_DIR="${UPLOADS_DIR:-/var/www/guesthub-uploads}"
if [ -d "$UPLOADS_DIR" ]; then
  tar -czf "$DEST/guesthub_uploads_${STAMP}.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
fi

# 3. rotate
find "$DEST" -name 'guesthub_db_*.sql' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name 'guesthub_uploads_*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "✓ backup ${STAMP}: db=$(du -h "$DEST/guesthub_db_${STAMP}.sql" | cut -f1) uploads=$([ -f "$DEST/guesthub_uploads_${STAMP}.tar.gz" ] && du -h "$DEST/guesthub_uploads_${STAMP}.tar.gz" | cut -f1 || echo none)"
