#!/usr/bin/env node
// check:supply-chain (Stage 6, V2 §19 supply-chain) — dependency audit clean of
// high/critical advisories, lockfile present + committed, and the Node runtime +
// package manager are pinned.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// 1) lockfile present + tracked
if (!existsSync(join(root, "pnpm-lock.yaml"))) flag("pnpm-lock.yaml missing");
else {
  const tracked = execFileSync("git", ["ls-files", "pnpm-lock.yaml"], { cwd: root, encoding: "utf8" }).trim();
  if (!tracked) flag("pnpm-lock.yaml is not committed");
  else pass("pnpm-lock.yaml present + committed (reproducible installs)");
}

// 2) Node + package-manager pinned
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!pkg.engines?.node) flag("package.json engines.node not pinned");
else pass(`Node pinned via engines: ${pkg.engines.node}`);
if (!pkg.packageManager) flag("packageManager not pinned");
else pass(`package manager pinned: ${pkg.packageManager}`);
if (!existsSync(join(root, ".nvmrc"))) flag(".nvmrc missing");
else pass(`.nvmrc present (${readFileSync(join(root, ".nvmrc"), "utf8").trim()})`);

// 3) audit clean of high/critical (moderate/low documented, not blocking)
let audit;
try {
  audit = execFileSync("pnpm", ["audit", "--prod", "--json"], { cwd: root, encoding: "utf8" });
} catch (e) {
  // pnpm audit exits non-zero when advisories exist; the JSON is still on stdout
  audit = String(e.stdout || "");
}
let counts = {};
try {
  const parsed = JSON.parse(audit);
  counts = parsed.metadata?.vulnerabilities ?? parsed.vulnerabilities ?? {};
} catch {
  // fall back to the summary line
  const m = audit.match(/(\d+)\s+critical/);
  const h = audit.match(/(\d+)\s+high/);
  counts = { critical: m ? Number(m[1]) : 0, high: h ? Number(h[1]) : 0 };
}
const critical = Number(counts.critical ?? 0);
const high = Number(counts.high ?? 0);
const moderate = Number(counts.moderate ?? 0);
const low = Number(counts.low ?? 0);
if (critical > 0 || high > 0) flag(`unresolved high/critical advisories: ${high} high, ${critical} critical`);
else pass(`no high/critical advisories (moderate=${moderate}, low=${low} — documented if any)`);

if (fail) { console.log(`\ncheck:supply-chain — FAIL (${fail})`); process.exit(1); }
console.log("check:supply-chain — PASS");
