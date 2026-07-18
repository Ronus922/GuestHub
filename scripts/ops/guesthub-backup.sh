#!/usr/bin/env bash
# GuestHub backup (Stage 2, defect H4) — replaces the schema-only nightly dump.
#
# Fixes vs the old nightly-backup.sh:
#   * dumps BOTH guesthub AND auth (GoTrue logins) — a restore now keeps auth,
#     so users can still log in (old backup omitted auth entirely).
#   * encrypts the dump at rest (AES-256, openssl pbkdf2).
#   * retention + an off-host copy hook (BACKUP_OFFHOST_CMD).
#
# Container-exec based (like the original), so it needs no published DB port and
# works for the shared source, the dedicated staging container, or a future prod
# container. Read-only against the source.
#
# Config (env, all optional):
#   BACKUP_CONTAINER  docker container running Postgres      (default: supabase-db)
#   BACKUP_DB         database name inside it                (default: postgres)
#   BACKUP_PGUSER     superuser for pg_dump                  (default: supabase_admin)
#   DEST              local backup dir                       (default: /home/ubuntu/guesthub-backups)
#   KEEP_DAYS         retention                              (default: 14)
#   BACKUP_KEY_FILE   AES passphrase file                    (default: /home/ubuntu/.guesthub-backup-key)
#   BACKUP_OFFHOST_CMD  command run as: $CMD <encrypted-file> (e.g. an rclone/scp wrapper).
#                       If unset, an off-host copy is NOT made and the script warns
#                       loudly (fail-visible) — H4 requires an off-host copy in prod.
#   UPLOADS_DIR       room-image store to include            (default: /var/www/guesthub-uploads)
set -euo pipefail

CONTAINER="${BACKUP_CONTAINER:-supabase-db}"
DB="${BACKUP_DB:-postgres}"
PGUSER="${BACKUP_PGUSER:-supabase_admin}"
DEST="${DEST:-/home/ubuntu/guesthub-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
KEY_FILE="${BACKUP_KEY_FILE:-/home/ubuntu/.guesthub-backup-key}"
UPLOADS_DIR="${UPLOADS_DIR:-/var/www/guesthub-uploads}"
STAMP="$(date +%Y%m%dT%H%M%S)"

mkdir -p "$DEST"
# generate an encryption key on first run (store it OFF-HOST too — see docs)
if [ ! -s "$KEY_FILE" ]; then
  umask 077; openssl rand -base64 48 > "$KEY_FILE"; chmod 600 "$KEY_FILE"
  echo "generated new backup key at $KEY_FILE (BACK THIS UP OFF-HOST separately)"
fi

RAW="$DEST/guesthub_full_${STAMP}.sql"
ENC="$RAW.enc"

# 1. dump guesthub + auth (GoTrue) in one file — the pair needed for a working restore
docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$DB" -n guesthub -n auth > "$RAW"
BYTES=$(wc -c < "$RAW")
tail -5 "$RAW" | grep -q "PostgreSQL database dump complete" || { echo "ABORT: dump did not complete"; rm -f "$RAW"; exit 1; }

# 2. encrypt at rest, drop the plaintext
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$RAW" -out "$ENC" -pass "file:$KEY_FILE"
rm -f "$RAW"

# 3. uploaded media (best-effort)
UP=""
if [ -d "$UPLOADS_DIR" ]; then
  UP="$DEST/guesthub_uploads_${STAMP}.tar.gz"
  tar -czf "$UP" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
fi

# 4. off-host copy (H4) — REQUIRED in production; warn if not configured
if [ -n "${BACKUP_OFFHOST_CMD:-}" ]; then
  $BACKUP_OFFHOST_CMD "$ENC"
  [ -n "$UP" ] && $BACKUP_OFFHOST_CMD "$UP"
  echo "off-host copy done via BACKUP_OFFHOST_CMD"
else
  echo "WARNING: BACKUP_OFFHOST_CMD not set — NO off-host copy made. H4 requires one in production."
fi

# 5. retention
find "$DEST" -name 'guesthub_full_*.sql.enc'      -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name 'guesthub_uploads_*.tar.gz'    -mtime +"$KEEP_DAYS" -delete

echo "✓ backup ${STAMP}: db=$(du -h "$ENC" | cut -f1) (plaintext ${BYTES}B, guesthub+auth) uploads=$([ -n "$UP" ] && du -h "$UP" | cut -f1 || echo none)"
echo "  encrypted: $ENC"
