#!/usr/bin/env bash
# ============================================================
# GuestHub — canonical pre-deploy TREE snapshot (PHASE 4.3).
#
# WHY THIS EXISTS
#   The four rollback tarballs in /home/ubuntu (guesthub-backup-*.tgz) were made
#   by hand. No script produced them, so nothing enforced an exclude list — and
#   every one of them swallowed the deploy tree's secrets:
#       .env.local  .env.local.bak-roles-2026-07-19
#       .env.local.pre-merge.bak  .env.staging
#   A one-off `tar czf` is exactly how that happens. The fix is not "remember to
#   pass --exclude next time"; it is to stop taking snapshots by hand.
#
#   This is the ONLY approved way to take a tree snapshot. It reproduces the
#   shape of the existing tarballs (top-level `guesthub/`, node_modules omitted,
#   .git and .next kept so the snapshot is a true rollback target) and adds the
#   exclusions that should always have been there.
#
# USAGE
#   guesthub-tree-snapshot.sh <label>          # -> /home/ubuntu/guesthub-backup-<stamp>-<label>.tgz
#   SRC=/var/www/other DEST_DIR=/tmp guesthub-tree-snapshot.sh <label>
#
# READ-ONLY against the source tree. Never deletes anything.
# ============================================================
set -euo pipefail

SRC="${SRC:-/var/www/guesthub}"
DEST_DIR="${DEST_DIR:-/home/ubuntu}"
LABEL="${1:-snapshot}"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="$DEST_DIR/guesthub-backup-${STAMP}-${LABEL}.tgz"

fail() { echo "✗ tree-snapshot: $*" >&2; exit 1; }

[ -d "$SRC" ] || fail "source tree not found: $SRC"
[ -d "$DEST_DIR" ] || fail "destination dir not found: $DEST_DIR"
[ -e "$OUT" ] && fail "refusing to overwrite existing snapshot: $OUT"

# The exclude list. `.env*` is the security-critical one; the rest keep the
# tarball a sane size. Keep in sync with scripts/ops/repack-backup-without-env.sh.
EXCLUDES=(
  --exclude='.env*'                 # secrets — the whole point of this script
  --exclude='node_modules'          # reinstallable from pnpm-lock.yaml
  --exclude='.pnpm-store'
  --exclude='*.log'
)

echo "→ snapshot of $SRC"
echo "  excluding: .env*  node_modules  .pnpm-store  *.log"
tar -czf "$OUT" "${EXCLUDES[@]}" -C "$(dirname "$SRC")" "$(basename "$SRC")"

# Fail-closed verification: a snapshot that still contains a dotenv is not a
# snapshot we are willing to hand back. Listing only — never extraction.
LEAKED="$(tar tzf "$OUT" | grep -E '(^|/)\.env' || true)"
if [ -n "$LEAKED" ]; then
  echo "✗ ABORT: snapshot still contains dotenv entries:" >&2
  printf '%s\n' "$LEAKED" | sed 's/^/    /' >&2
  rm -f "$OUT"
  exit 1
fi

echo "✓ $OUT ($(du -h "$OUT" | cut -f1), $(tar tzf "$OUT" | wc -l) entries, 0 dotenv entries)"
