#!/usr/bin/env bash
# GuestHub restore drill (Stage 2, defect H4) — proves a backup actually restores.
#
# 2026-08-08: the drill now exercises the OFF-HOST copy first. When
# B2_APPLICATION_KEY is set it downloads the newest encrypted object from the
# B2 bucket, age-decrypts it with the on-host private key, openssl-decrypts,
# and restores THAT — so "we have an off-host backup" means "we restored from
# it this week". Without the key it falls back to the newest LOCAL backup and
# says so LOUDLY: a local-only pass does NOT verify the remote copy.
#
# Restores into a scratch database on the DISPOSABLE test instance, then
# reports table + row counts. Never touches production or the source.
#
# Config (env, optional):
#   DEST             backup dir                    (default: /home/ubuntu/guesthub-backups)
#   BACKUP_KEY_FILE  AES passphrase file           (default: /home/ubuntu/.guesthub-backup-key)
#   AGE_KEY_FILE     age private key               (default: /home/ubuntu/.guesthub-backup-age.key)
#   B2_APPLICATION_KEY  enables the off-host leg   (no default — see /etc/guesthub-backup-b2.env)
#   RESTORE_CONTAINER disposable pg container       (default: guesthub-testdb)
#   RESTORE_DB       scratch db name (recreated)   (default: guesthub_restore_drill)
set -euo pipefail

DEST="${DEST:-/home/ubuntu/guesthub-backups}"
KEY_FILE="${BACKUP_KEY_FILE:-/home/ubuntu/.guesthub-backup-key}"
AGE_KEY_FILE="${AGE_KEY_FILE:-/home/ubuntu/.guesthub-backup-age.key}"
RC="${RESTORE_CONTAINER:-guesthub-testdb}"
RDB="${RESTORE_DB:-guesthub_restore_drill}"
B2_KEY_ID="0033adeb8c0d9230000000001"
B2_BUCKET="guesthub-backup"

SOURCE_LEG="local"
LATEST=""
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

if [ -n "${B2_APPLICATION_KEY:-}" ]; then
  # ---- off-host leg: newest remote object, downloaded and age-decrypted ----
  export RCLONE_B2_ACCOUNT="$B2_KEY_ID"
  export RCLONE_B2_KEY="$B2_APPLICATION_KEY"
  REMOTE_NAME="$(rclone lsf ":b2:${B2_BUCKET}" --files-only | grep '^guesthub_full_.*\.sql\.enc\.age$' | sort | tail -1)"
  [ -n "$REMOTE_NAME" ] || { echo "ABORT: off-host leg enabled but no guesthub_full_*.sql.enc.age object exists in b2:${B2_BUCKET}"; exit 1; }
  echo "off-host leg: downloading ${REMOTE_NAME} from b2:${B2_BUCKET}"
  rclone copyto ":b2:${B2_BUCKET}/${REMOTE_NAME}" "$WORK/${REMOTE_NAME}" -q
  age -d -i "$AGE_KEY_FILE" -o "$WORK/restore.sql.enc" "$WORK/${REMOTE_NAME}"
  LATEST="$WORK/restore.sql.enc"
  SOURCE_LEG="remote(b2)"
else
  echo "=========================================================================="
  echo "WARNING: OFF-HOST LEG SKIPPED — B2_APPLICATION_KEY is not set."
  echo "         This run verifies the LOCAL backup only; the remote copy in B2"
  echo "         was NOT verified. H4 is only half-proven until the key is set."
  echo "=========================================================================="
  LATEST="$(ls -t "$DEST"/guesthub_full_*.sql.enc 2>/dev/null | head -1)"
  [ -n "$LATEST" ] || { echo "ABORT: no encrypted backup found in $DEST"; exit 1; }
fi
echo "restoring (${SOURCE_LEG}): $LATEST"

TMP="$WORK/restore.sql"
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

echo "restore drill result: source=$SOURCE_LEG load-errors=$ERRS guesthub_tables=$GH auth_tables=$AU reservations=$RES auth.users=$USERS"
[ "$ERRS" = "0" ] && [ "$GH" -ge 60 ] && [ "$AU" -ge 1 ] && echo "RESTORE DRILL PASSED (source=$SOURCE_LEG)" || { echo "RESTORE DRILL FAILED"; exit 1; }
