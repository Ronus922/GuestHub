#!/usr/bin/env bash
# GuestHub restore drill (Stage 2, defect H4) — proves a backup actually restores.
# Decrypts the latest encrypted backup and restores it into a scratch database on
# the DISPOSABLE test instance, then reports table + row counts. Never touches
# production or the source. Run regularly so "we have backups" means "we can restore".
#
# Config (env, optional):
#   DEST             backup dir                    (default: /home/ubuntu/guesthub-backups)
#   BACKUP_KEY_FILE  AES passphrase file           (default: /home/ubuntu/.guesthub-backup-key)
#   RESTORE_CONTAINER disposable pg container       (default: guesthub-testdb)
#   RESTORE_DB       scratch db name (recreated)   (default: guesthub_restore_drill)
set -euo pipefail

DEST="${DEST:-/home/ubuntu/guesthub-backups}"
KEY_FILE="${BACKUP_KEY_FILE:-/home/ubuntu/.guesthub-backup-key}"
RC="${RESTORE_CONTAINER:-guesthub-testdb}"
RDB="${RESTORE_DB:-guesthub_restore_drill}"

LATEST="$(ls -t "$DEST"/guesthub_full_*.sql.enc 2>/dev/null | head -1)"
[ -n "$LATEST" ] || { echo "ABORT: no encrypted backup found in $DEST"; exit 1; }
echo "restoring: $LATEST"

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -in "$LATEST" -out "$TMP" -pass "file:$KEY_FILE"

PW="$(docker exec "$RC" bash -lc 'printf %s "$POSTGRES_PASSWORD"')"
docker exec -e PGPASSWORD="$PW" "$RC" psql -U supabase_admin -h 127.0.0.1 -d postgres \
  -c "DROP DATABASE IF EXISTS $RDB" -c "CREATE DATABASE $RDB" >/dev/null
# auth schema restore needs its roles; the supabase/postgres image already has them
docker cp "$TMP" "$RC:/tmp/restore.sql"
ERRS=$(docker exec -e PGPASSWORD="$PW" "$RC" psql -U supabase_admin -h 127.0.0.1 -d "$RDB" \
  -v ON_ERROR_STOP=0 -q -f /tmp/restore.sql 2>&1 | grep -c '^ERROR' || true)
docker exec "$RC" rm -f /tmp/restore.sql

GH=$(docker exec -e PGPASSWORD="$PW" "$RC" psql -U supabase_admin -h 127.0.0.1 -d "$RDB" -tAc "select count(*) from pg_tables where schemaname='guesthub'")
AU=$(docker exec -e PGPASSWORD="$PW" "$RC" psql -U supabase_admin -h 127.0.0.1 -d "$RDB" -tAc "select count(*) from pg_tables where schemaname='auth'")
RES=$(docker exec -e PGPASSWORD="$PW" "$RC" psql -U supabase_admin -h 127.0.0.1 -d "$RDB" -tAc "select count(*) from guesthub.reservations" 2>/dev/null || echo '?')
USERS=$(docker exec -e PGPASSWORD="$PW" "$RC" psql -U supabase_admin -h 127.0.0.1 -d "$RDB" -tAc "select count(*) from auth.users" 2>/dev/null || echo '?')

echo "restore drill result: load-errors=$ERRS guesthub_tables=$GH auth_tables=$AU reservations=$RES auth.users=$USERS"
[ "$ERRS" = "0" ] && [ "$GH" -ge 60 ] && [ "$AU" -ge 1 ] && echo "RESTORE DRILL PASSED" || { echo "RESTORE DRILL FAILED"; exit 1; }
