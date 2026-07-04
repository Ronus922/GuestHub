#!/usr/bin/env bash
# ============================================================
# Canonical GuestHub production deploy. The ONLY approved way to build+restart
# production. Fail-closed at every step: it never deploys an arbitrary branch,
# a dirty tree, or a commit not reachable from origin/main.
#
#   PROD_DEPLOY_OK=1 npm run deploy:prod
#
# Runs inside the marked production checkout (/var/www/guesthub-production).
# ============================================================
set -euo pipefail

PROD_DIR="${PROD_DIR:-/var/www/guesthub-production}"
PORT="${PORT:-3007}"
PM2_APP="${PM2_APP:-guesthub}"

fail() { echo "✗ DEPLOY FAILED: $*" >&2; exit 1; }

# 1. explicit opt-in
[ "${PROD_DEPLOY_OK:-}" = "1" ] || fail "missing opt-in — run with PROD_DEPLOY_OK=1"

# must be the marked production runtime (never a feature worktree)
[ -f "$PROD_DIR/.production-runtime" ] || fail "$PROD_DIR is not the marked production runtime (.production-runtime absent)"
cd "$PROD_DIR"

BEFORE_BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo none)"
BEFORE_COMMIT="$(git rev-parse HEAD)"
echo "→ before: commit=${BEFORE_COMMIT:0:8} build=$BEFORE_BUILD_ID"

# 7. fetch origin
git fetch origin --prune --quiet

# 2-6. git preconditions (branch=main, clean tree, reachable from origin/main,
#      HEAD==approved release, no unapproved migrations). Fail-closed.
PROD_DEPLOY_OK=1 node scripts/production-deploy-guard.mjs || fail "deploy guard rejected the target"

# 8. fast-forward main only (never a merge, never another branch)
git checkout --quiet main || fail "cannot checkout main"
git merge --ff-only origin/main || fail "main is not a fast-forward of origin/main — refusing"

# re-assert after ff: HEAD must now equal origin/main, tree still clean
PROD_DEPLOY_OK=1 node scripts/production-deploy-guard.mjs || fail "post-fast-forward guard failed"

TARGET_COMMIT="$(git rev-parse HEAD)"
[ "$TARGET_COMMIT" = "$(git rev-parse origin/main)" ] || fail "HEAD != origin/main after fast-forward"

# 9. build (marker present → prebuild-guard requires this same opt-in)
echo "→ building $TARGET_COMMIT ..."
PROD_DEPLOY_OK=1 npm run build || fail "build failed"
NEW_BUILD_ID="$(cat .next/BUILD_ID)"
[ -n "$NEW_BUILD_ID" ] || fail "no BUILD_ID produced"

# 10. restart ONLY the guesthub process (unrelated PM2 services untouched)
pm2 restart "$PM2_APP" --update-env || fail "pm2 restart failed"

# verify PM2 is running this exact directory (app name passed as argv[1])
RUN_CWD="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=process.argv[1];const a=JSON.parse(s).find(p=>p.name===n);process.stdout.write(a&&a.pm2_env?(a.pm2_env.pm_cwd||""):"")})' "$PM2_APP")"
[ "$RUN_CWD" = "$PROD_DIR" ] || fail "PM2 cwd is '$RUN_CWD', expected '$PROD_DIR'"

# 11. verify port answers
ok=0; for i in $(seq 1 30); do curl -sf -o /dev/null "http://localhost:$PORT/login" && { ok=1; break; }; sleep 1; done
[ "$ok" = 1 ] || fail "port $PORT not answering after restart"

# 13. verify critical routes (any non-5xx is healthy; unauth routes 307 to /login)
for r in / /login /calendar; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$r")"
  [ "$code" -lt 500 ] || fail "route $r returned $code"
  echo "  route $r → $code"
done

# 12. report deployed commit / build id
echo "✓ DEPLOYED  commit=${TARGET_COMMIT:0:8}  build=$NEW_BUILD_ID  cwd=$PROD_DIR  port=$PORT"
