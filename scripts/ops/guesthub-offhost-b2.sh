#!/usr/bin/env bash
# GuestHub off-host copy → Backblaze B2 (H4 closure, 2026-08-08).
#
# Called by guesthub-backup.sh as:  $BACKUP_OFFHOST_CMD <file>
# (one call per artifact: the encrypted DB dump, then the uploads tar; a
# non-zero exit here fails the WHOLE nightly backup unit — deliberately).
#
# PIPELINE (fail-loud, set -euo pipefail):
#   1. age-encrypt the artifact to <name>.age for the PUBLIC recipient below.
#      Asymmetric on purpose: restoring after total server loss needs only
#      the age PRIVATE key Ronen keeps off-host — never the on-host openssl
#      passphrase file. The DB dump arrives here already openssl-encrypted,
#      so the object at rest in B2 is double-wrapped; the uploads tar gets
#      its first (and only) encryption here. Nothing is uploaded plaintext.
#   2. upload via rclone's NATIVE b2 backend. Chosen over S3-compat: it is
#      the first-party API for this provider (sha1 verified on upload, no
#      endpoint/signature translation layer), and the connection is written
#      inline (:b2:) so NO rclone.conf exists and no secret can land in one.
#   3. verify the remote object exists AND matches the local byte size —
#      an upload nobody verified is a hope, not a copy.
#
# SECRETS: B2_APPLICATION_KEY comes from the environment ONLY (in prod:
# EnvironmentFile /etc/guesthub-backup-b2.env, root 0600, loaded by the
# guesthub-backup.service drop-in). It is never echoed and never written.
# The keyID and the bucket name are identity, not secrets.
#
# REMOTE RETENTION (deliberate, 2026-08-08): NONE. The existing backup
# system rotates locally only (KEEP_DAYS), and adding remote rotation is
# Ronen's call — not taken here. NOTE for whoever adds one: the bucket has
# Object Lock with a 30-day default retention; a rotation window must be
# LONGER than 30 days or every delete of a locked object fails and the
# rotation reports failure on every run. Until then B2 grows unbounded at
# roughly one nightly set (~64MB) per day (~1.9GB/month).
set -euo pipefail

B2_KEY_ID="0033adeb8c0d9230000000001"
B2_BUCKET="guesthub-backup"
AGE_RECIPIENT="age122df9ymyeaf94r4lsw0qnj7lqf4yd8sefqt439wzuqpf6g8h8pzs3j5gmg"

SRC="${1:?usage: guesthub-offhost-b2.sh <file>}"
[ -s "$SRC" ] || { echo "OFFHOST FAIL: source ${SRC} is missing or empty" >&2; exit 1; }
: "${B2_APPLICATION_KEY:?OFFHOST FAIL: B2_APPLICATION_KEY is not set — fill /etc/guesthub-backup-b2.env}"

# 1. encrypt BEFORE upload
AGE_OUT="${SRC}.age"
age -r "$AGE_RECIPIENT" -o "$AGE_OUT" "$SRC"

# 2. upload (native b2 backend, inline remote — no config file, no secret on disk)
NAME="$(basename "$AGE_OUT")"
export RCLONE_B2_ACCOUNT="$B2_KEY_ID"
export RCLONE_B2_KEY="$B2_APPLICATION_KEY"
rclone copyto "$AGE_OUT" ":b2:${B2_BUCKET}/${NAME}" --no-traverse -q

# 3. verify the object landed with the right size — fail-loud on any mismatch
LOCAL_BYTES="$(wc -c < "$AGE_OUT")"
REMOTE_BYTES="$(rclone lsl ":b2:${B2_BUCKET}/${NAME}" | awk 'NR==1{print $1}')"
if [ "${REMOTE_BYTES:-none}" != "$LOCAL_BYTES" ]; then
  echo "OFFHOST FAIL: remote size ${REMOTE_BYTES:-none} != local ${LOCAL_BYTES} for ${NAME}" >&2
  exit 1
fi

rm -f "$AGE_OUT"
echo "off-host: ${NAME} → b2:${B2_BUCKET} (${LOCAL_BYTES}B, size-verified)"
