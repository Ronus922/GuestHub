// ============================================================
// Fail-closed BUILD guard. Runs as npm "prebuild" — BEFORE `next build`, so it
// refuses before .next is removed or modified.
//
// Rule: a checkout marked as the production runtime (a `.production-runtime`
// file at its root) must NOT be built directly. Production is only ever built
// through the canonical deploy (scripts/deploy-production.sh), which sets
// PROD_DEPLOY_OK=1. Feature worktrees carry no marker, so their builds are
// always allowed — this hook is a no-op there.
// ============================================================
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marked = existsSync(join(root, ".production-runtime"));
const optedIn = process.env.PROD_DEPLOY_OK === "1";

if (marked && !optedIn) {
  console.error("✗ BUILD BLOCKED (fail-closed): this is the PRODUCTION runtime checkout (.production-runtime present).");
  console.error("  Direct `npm run build` is refused here so a stray build cannot corrupt the live .next.");
  console.error("  Deploy production only via: npm run deploy:prod   (scripts/deploy-production.sh, sets PROD_DEPLOY_OK=1)");
  console.error("  Do feature builds in a worktree under /var/www/guesthub-worktrees/ (no marker → allowed).");
  process.exit(1);
}
// ponytail: marker-presence is the whole check; no config, no allowlist.
