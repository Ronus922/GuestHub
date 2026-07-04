// ============================================================
// Fail-closed PRODUCTION DEPLOY guard. Root cause of the incident's exposure:
// production was left serving an UNMERGED feature branch. This refuses to
// build/restart production unless the checkout is provably the approved main.
//
// Run as the first step of any production deploy (before build/restart):
//   PROD_DEPLOY_OK=1 node scripts/production-deploy-guard.mjs
// Exits non-zero (blocking) when any condition fails. `git` only — no network
// beyond the fetch the caller already did; compares against origin/main.
// ============================================================
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// True iff `ref` is an ancestor of (i.e. already merged into) origin/main.
export function isAncestorOfOriginMain(ref) {
  try { execFileSync("git", ["merge-base", "--is-ancestor", ref, "origin/main"]); return true; }
  catch { return false; }
}

// Pure-ish: evaluate the git/deploy preconditions. Fail-closed.
export function evaluateDeployGuard(env = process.env) {
  const reasons = [];
  const head = git(["rev-parse", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const originMain = git(["rev-parse", "origin/main"]);
  const approved = env.APPROVED_MAIN_COMMIT || originMain;

  const dirty = git(["status", "--porcelain"]).split("\n").filter((l) => l && !l.startsWith("??"));
  if (dirty.length) reasons.push(`working tree not clean (${dirty.length} tracked change(s))`);

  if (!isAncestorOfOriginMain("HEAD")) reasons.push("current commit is not reachable from origin/main");
  if (branch !== "main" && head !== approved) reasons.push(`not on main and HEAD (${head.slice(0, 8)}) != approved (${approved.slice(0, 8)})`);
  if (env.PROD_DEPLOY_OK !== "1") reasons.push("missing explicit opt-in: PROD_DEPLOY_OK=1");

  // Unapproved migrations = migrations that exist on HEAD but NOT on origin/main
  // (i.e. added on this branch since it diverged). Use three-dot (merge-base…HEAD)
  // so that new APPROVED migrations arriving FROM origin/main — the normal case
  // when production is simply behind main — are not misflagged. Two-dot here would
  // reject every release that adds a migration.
  let pendingMig = [];
  try { pendingMig = git(["diff", "--name-only", "origin/main...HEAD", "--", "db/migrations"]).split("\n").filter(Boolean); } catch { /* no range */ }
  if (pendingMig.length) reasons.push(`migrations outside approved release: ${pendingMig.join(", ")}`);

  return { ok: reasons.length === 0, reasons, info: { head, branch, originMain, approved } };
}

export function assertDeployAllowed(env = process.env, exit = (c) => process.exit(c)) {
  const { ok, reasons, info } = evaluateDeployGuard(env);
  console.log(`deploy target → branch=${info.branch} HEAD=${info.head.slice(0, 8)} origin/main=${info.originMain.slice(0, 8)}`);
  if (!ok) {
    console.error("✗ PRODUCTION DEPLOY BLOCKED (fail-closed) — refusing before build/restart:");
    for (const r of reasons) console.error(`  - ${r}`);
    console.error("Deploy only the approved main: clean tree, on main (or HEAD==approved), reachable from origin/main, no extra migrations, PROD_DEPLOY_OK=1.");
    exit(1);
    return false;
  }
  console.log("✓ deploy guard passed — approved main confirmed.");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertDeployAllowed();
}
