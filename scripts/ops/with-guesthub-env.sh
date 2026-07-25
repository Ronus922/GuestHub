#!/usr/bin/env bash
# ============================================================
# GuestHub — out-of-tree environment loader (PHASE 4.2).
#
# WHY THIS EXISTS
#   Today both PM2 apps read secrets from `.env.local` *inside the deploy tree*
#   (/var/www/guesthub):
#     * the web app  — `npm start` → Next.js auto-loads .env.local from cwd
#     * the worker   — ecosystem.config.cjs: `--env-file-if-exists=.env.local`
#   Secrets living in the deploy tree are what let a plain `tar` of the tree
#   swallow them (see docs/BACKUP_HYGIENE.md). Moving the file out of the tree
#   removes the whole class of accident.
#
#   The `billing` project on this host already does the out-of-tree thing:
#   /etc/billing/billing.env (root:root 0600) wired as a systemd
#   `EnvironmentFile=` in billing.service. systemd reads the file AS ROOT and
#   injects the variables, so the unprivileged service never needs read access.
#
#   PM2 has no equivalent. Proven on this host:
#     * pm2 6.0.14 has no `env_file` option (absent from lib/API/schema.json)
#     * node's `--env-file` cannot be injected via the environment —
#       `node: --env-file= is not allowed in NODE_OPTIONS`
#   So under PM2 the only mechanism is this wrapper: a shell that reads the
#   file itself and execs the real command. Because the *wrapper* does the
#   reading (not systemd), the file must be readable by the PM2 uid, which
#   means it CANNOT be root-owned 0600. See the trade-off table in
#   docs/ENV_OUT_OF_TREE_RUNBOOK.md before choosing.
#
# USAGE
#   with-guesthub-env.sh <command> [args...]
#   GUESTHUB_ENV_FILE=/path/to/other.env with-guesthub-env.sh <command>
#
# CONTRACT
#   * never echoes a value — only variable NAMES and counts
#   * refuses to run if the env file is world- or group-readable
#   * refuses to run if the env file is missing (fail-closed: a silently
#     env-less start is how you get an app talking to the wrong database)
# ============================================================
set -euo pipefail

ENV_FILE="${GUESTHUB_ENV_FILE:-/etc/guesthub/guesthub.env}"

fail() { echo "✗ with-guesthub-env: $*" >&2; exit 1; }

[ $# -ge 1 ] || fail "usage: with-guesthub-env.sh <command> [args...]"
[ -f "$ENV_FILE" ] || fail "env file not found: $ENV_FILE (fail-closed)"
[ -r "$ENV_FILE" ] || fail "env file not readable by uid $(id -u): $ENV_FILE"

# permission gate — 0600/0400 only. A group- or world-readable secrets file is
# the same exposure we are trying to remove, just in a different directory.
MODE="$(stat -c '%a' "$ENV_FILE")"
case "$MODE" in
  600|400) ;;
  *) fail "env file $ENV_FILE has mode $MODE — refusing (want 600 or 400)" ;;
esac

# Load. `set -a` exports everything the file defines; the subshell-free source
# keeps the exec below in the same process so signals reach the real command.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Report NAMES ONLY, never values (iron rule 13).
if [ "${GUESTHUB_ENV_VERBOSE:-0}" = "1" ]; then
  NAMES="$(grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$ENV_FILE" \
            | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]*=$//' | sort -u)"
  echo "with-guesthub-env: loaded $(printf '%s\n' "$NAMES" | grep -c .) vars from $ENV_FILE (mode $MODE)"
  printf '%s\n' "$NAMES" | sed 's/^/  - /'
fi

exec "$@"
