#!/usr/bin/env node
// ============================================================
// deploy-deps — the dependency half of the canonical deploy (D185).
//
// Incident (2026-09-10, #250): the lockfile moved nodemailer 9.0.3 → 9.1.1 and
// scripts/deploy-production.sh, which has never had an install step, built
// against the OLD node_modules and printed "✓ DEPLOYED" for a bundle that
// still shipped the vulnerable 9.0.3. It was caught by hand. This module lets
// the deploy notice on its own, fail-closed:
//
//   trigger <oldRef> <newRef>
//     Prints WHY an install is needed; empty output = nothing to do.
//       · package.json / pnpm-lock.yaml differ between the previously deployed
//         HEAD and the target commit (the normal case), or
//       · the installed tree does not match the lockfile — a deploy that died
//         between fast-forward and install leaves exactly this state, and a
//         git diff alone would call it "unchanged".
//     Exit 0 either way; non-zero only when detection itself fails (bad ref).
//
//   verify
//     Exit 0 iff every direct dependency installed in node_modules (what
//     `pnpm ls --depth 0 --json` reports) is the version pnpm-lock.yaml wants
//     for the root importer; exit 1 listing the mismatches otherwise. The
//     deploy runs it after the build and before migrations / any restart.
//
// The pure functions are exported for check:deploy-script.
// ============================================================
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEPENDENCY_MANIFESTS = ["package.json", "pnpm-lock.yaml"];

/** the manifests that differ between two commits (subset of DEPENDENCY_MANIFESTS) */
export function changedDependencyFiles(oldRef, newRef, cwd = process.cwd()) {
  const out = execFileSync(
    "git", ["diff", "--name-only", oldRef, newRef, "--", ...DEPENDENCY_MANIFESTS],
    { cwd, encoding: "utf8" },
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** direct dependencies (name → version) the lockfile wants for the root
 *  importer (`importers: → .: → dependencies/devDependencies/optionalDependencies`).
 *  A peer-resolution suffix `(react@19.1.0)` is not part of the version. */
export function wantedDirectDeps(lockText) {
  const wanted = new Map();
  let inImporters = false;
  let inRoot = false;
  let inSection = false;
  let name = null;
  for (const line of lockText.split("\n")) {
    if (/^\S/.test(line)) { inImporters = line.startsWith("importers:"); inRoot = false; continue; }
    if (!inImporters) continue;
    if (/^  \S/.test(line)) { inRoot = line.trim() === ".:"; inSection = false; continue; }
    if (!inRoot) continue;
    if (/^    \S/.test(line)) {
      inSection = /^    (dependencies|devDependencies|optionalDependencies):$/.test(line);
      name = null;
      continue;
    }
    if (!inSection) continue;
    const dep = /^      ('?)([^:']+)\1:$/.exec(line);
    if (dep) { name = dep[2]; continue; }
    const ver = /^        version: (.+)$/.exec(line);
    if (ver && name) { wanted.set(name, ver[1].replace(/\(.*$/, "")); name = null; }
  }
  return wanted;
}

/** direct dependencies (name → version) actually installed, from the JSON of
 *  `pnpm ls --depth 0 --json` (one project, the root) */
export function installedDirectDeps(lsJson) {
  const parsed = JSON.parse(lsJson);
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const installed = new Map();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, info] of Object.entries(root?.[section] ?? {})) {
      installed.set(name, typeof info?.version === "string" ? info.version : null);
    }
  }
  return installed;
}

/** every wanted direct dependency whose installed version differs (or is absent) */
export function directDepMismatches(wanted, installed) {
  const out = [];
  for (const [name, version] of wanted) {
    const have = installed.get(name) ?? null;
    if (have !== version) out.push({ name, wanted: version, installed: have });
  }
  return out;
}

/** the real tree: lockfile vs `pnpm ls`. Any failure to read either side is a
 *  mismatch (fail-closed), never a pass. */
export function verifyInstalled(cwd = process.cwd()) {
  const lock = readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8");
  const wanted = wantedDirectDeps(lock);
  if (wanted.size === 0) {
    return [{ name: "(pnpm-lock.yaml)", wanted: "a root importer with dependencies", installed: "none parsed" }];
  }
  let ls;
  try {
    ls = execFileSync("pnpm", ["ls", "--depth", "0", "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    if (e && typeof e.stdout === "string" && e.stdout.trim().startsWith("[")) ls = e.stdout;
    else return [{ name: "(pnpm ls)", wanted: "a readable node_modules", installed: String(e?.message ?? e).split("\n")[0] }];
  }
  let installed;
  try { installed = installedDirectDeps(ls); }
  catch { return [{ name: "(pnpm ls)", wanted: "JSON output", installed: "unparseable" }]; }
  return directDepMismatches(wanted, installed);
}

export function describeMismatches(mismatches) {
  return mismatches.map((m) => `${m.name} wanted ${m.wanted}, installed ${m.installed ?? "nothing"}`).join("; ");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, oldRef, newRef] = process.argv.slice(2);
  if (cmd === "trigger") {
    if (!oldRef || !newRef) { console.error("usage: deploy-deps.mjs trigger <oldRef> <newRef>"); process.exit(2); }
    const reasons = [];
    const changed = changedDependencyFiles(oldRef, newRef);
    if (changed.length) reasons.push(`manifest changed ${oldRef.slice(0, 8)}..${newRef.slice(0, 8)}: ${changed.join(", ")}`);
    const mismatches = verifyInstalled();
    if (mismatches.length) reasons.push(`installed tree ≠ lockfile: ${describeMismatches(mismatches)}`);
    process.stdout.write(reasons.join("; "));
    process.exit(0);
  }
  if (cmd === "verify") {
    const mismatches = verifyInstalled();
    if (mismatches.length === 0) {
      console.log("✓ installed dependencies match pnpm-lock.yaml (every direct dependency)");
      process.exit(0);
    }
    console.error(`✗ installed dependencies do not match pnpm-lock.yaml: ${describeMismatches(mismatches)}`);
    process.exit(1);
  }
  console.error("usage: deploy-deps.mjs trigger <oldRef> <newRef> | verify");
  process.exit(2);
}
