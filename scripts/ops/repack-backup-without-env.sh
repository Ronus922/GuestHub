#!/usr/bin/env bash
# ============================================================
# GuestHub — repack an existing tarball WITHOUT its dotenv files (PHASE 4.3).
#
# The four rollback tarballs in /home/ubuntu each carry the deploy tree's
# secrets. They are still live rollback targets, so they must not be deleted or
# silently replaced. This script therefore produces a CLEANED SIBLING and proves
# it is otherwise byte-for-byte the same set of files. Swapping the original for
# the clean copy is a human decision, made after reading the verification.
#
#   DEFAULT MODE IS PREPARE-AND-VERIFY. IT NEVER DELETES OR REPLACES ANYTHING.
#
# USAGE
#   repack-backup-without-env.sh <tarball> [<tarball> ...]
#     -> writes <tarball>.clean.tgz next to each input and verifies it
#   OUT_DIR=/somewhere repack-backup-without-env.sh <tarball>
#
# WHAT "VERIFIED" MEANS HERE
#   1. the clean tarball contains ZERO `.env*` entries
#   2. the clean tarball's entry list == the original's entry list MINUS exactly
#      the dotenv entries — nothing else was dropped, nothing was added
#   3. every retained regular file has an identical SHA-256 in both tarballs
#   Check 3 is the one that matters: it proves the repack preserved content and
#   did not, say, truncate or re-encode anything.
#
# SAFETY
#   * extraction happens into a private mktemp dir with mode 0700, and only for
#     hashing; the temp dir is removed on exit (including on error)
#   * dotenv members are NEVER extracted from the original — they are filtered
#     out of the extraction list before extraction, so their contents never
#     touch disk and never reach a log
#   * no value from any file is ever printed; output is names and hashes only
# ============================================================
set -euo pipefail

fail() { echo "✗ repack: $*" >&2; exit 1; }
[ $# -ge 1 ] || fail "usage: repack-backup-without-env.sh <tarball> [<tarball> ...]"

TMPROOT="$(mktemp -d)"; chmod 700 "$TMPROOT"
trap 'rm -rf "$TMPROOT"' EXIT

RC=0
for SRC in "$@"; do
  [ -f "$SRC" ] || fail "not a file: $SRC"
  OUT="${OUT_DIR:-$(dirname "$SRC")}/$(basename "${SRC%.tgz}").clean.tgz"
  echo "══════════════════════════════════════════════════════════"
  echo "source : $SRC ($(du -h "$SRC" | cut -f1))"
  echo "target : $OUT"
  [ -e "$OUT" ] && fail "refusing to overwrite existing $OUT"

  WORK="$TMPROOT/$(basename "$SRC" .tgz)"; mkdir -p "$WORK"

  # ---- 1. inventory the original (listing only) ----
  tar tzf "$SRC" > "$WORK/orig.list"
  grep -E '(^|/)\.env' "$WORK/orig.list" > "$WORK/dotenv.list" || true
  DOTENV_N=$(grep -c . "$WORK/dotenv.list" || true)
  echo "  original entries : $(wc -l < "$WORK/orig.list")"
  echo "  dotenv entries   : $DOTENV_N"
  [ "$DOTENV_N" -gt 0 ] && sed 's/^/      - /' "$WORK/dotenv.list"

  if [ "$DOTENV_N" -eq 0 ]; then
    echo "  → already clean; no repack needed."
    continue
  fi

  # ---- 2. repack, excluding dotenv, WITHOUT extracting the originals ----
  # tar's own --exclude does the filtering during the copy, so dotenv members are
  # never written to disk at any point.
  EXT="$TMPROOT/ext-$(basename "$SRC" .tgz)"; mkdir -p "$EXT"; chmod 700 "$EXT"
  tar xzf "$SRC" -C "$EXT" --exclude='.env*'
  tar czf "$OUT" -C "$EXT" .
  rm -rf "$EXT"

  # ---- 3. verify ----
  tar tzf "$OUT" > "$WORK/new.list"

  # 3a. zero dotenv
  if grep -qE '(^|/)\.env' "$WORK/new.list"; then
    echo "  ✗ FAIL: clean tarball still contains dotenv entries"; RC=1; continue
  fi
  echo "  ✓ clean tarball contains 0 dotenv entries"

  # 3b. entry list == original minus dotenv (normalise tar's leading './')
  sed 's|^\./||' "$WORK/orig.list" | grep -vE '(^|/)\.env' | sed '/^$/d' | sort -u > "$WORK/expect.norm"
  sed 's|^\./||' "$WORK/new.list"  | sed '/^$/d' | sort -u > "$WORK/new.norm"
  if ! diff -u "$WORK/expect.norm" "$WORK/new.norm" > "$WORK/list.diff"; then
    echo "  ✗ FAIL: entry list differs beyond the removed dotenv files:"
    head -30 "$WORK/list.diff" | sed 's/^/      /'; RC=1; continue
  fi
  echo "  ✓ entry list == original minus exactly the $DOTENV_N dotenv files"

  # 3c. content integrity of every retained regular file
  A="$TMPROOT/a"; B="$TMPROOT/b"; rm -rf "$A" "$B"; mkdir -p "$A" "$B"; chmod 700 "$A" "$B"
  tar xzf "$SRC" -C "$A" --exclude='.env*'
  tar xzf "$OUT" -C "$B"
  ( cd "$A" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) | sed 's|\./||' | sort -k2 > "$WORK/a.sha"
  ( cd "$B" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) | sed 's|\./||' | sort -k2 > "$WORK/b.sha"
  rm -rf "$A" "$B"
  if ! diff -u "$WORK/a.sha" "$WORK/b.sha" > "$WORK/sha.diff"; then
    echo "  ✗ FAIL: content hash mismatch on retained files:"
    head -20 "$WORK/sha.diff" | sed 's/^/      /'; RC=1; continue
  fi
  echo "  ✓ SHA-256 identical for all $(wc -l < "$WORK/a.sha") retained files"
  echo "  ✓ VERIFIED — $OUT ($(du -h "$OUT" | cut -f1))"
  echo "    original left untouched. Replacing it is a human decision:"
  echo "      mv '$SRC' '$SRC.with-secrets' && mv '$OUT' '$SRC'"
done

echo "══════════════════════════════════════════════════════════"
[ "$RC" -eq 0 ] && echo "ALL REPACKS VERIFIED (originals untouched)" || echo "SOME REPACKS FAILED"
exit "$RC"
