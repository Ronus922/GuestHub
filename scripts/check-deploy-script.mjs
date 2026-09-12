#!/usr/bin/env node
// ============================================================
// check:deploy-script — the deploy installs dependencies when the manifests
// changed, and never restarts onto a stale node_modules (D185).
//
// Incident (2026-09-10, #250): pnpm-lock.yaml moved nodemailer 9.0.3 → 9.1.1;
// deploy-production.sh had no install step, built against the old
// node_modules and printed "✓ DEPLOYED" for a bundle still shipping 9.0.3.
//
// B2-STYLE. Two halves, each red if its fix is reverted:
//   · STRUCTURE — deploy-production.sh asks scripts/deploy-deps.mjs whether an
//     install is needed (previous HEAD → target), installs INSIDE that
//     conditional with `|| fail`, BEFORE the build; and verifies the installed
//     tree AFTER the build, BEFORE migrations and any pm2 restart, with
//     `|| fail`. Making the install unconditional, moving it after the build,
//     or dropping either `|| fail` turns this red.
//   · BEHAVIOUR — the helper itself, on fixtures: the git detection against a
//     scratch repository (manifest changed / unchanged / only one of the two),
//     the lockfile parser on pnpm's real importer format, and the
//     installed-vs-wanted comparison on the exact incident (9.0.3 installed,
//     9.1.1 wanted). Ignoring the version, or the lockfile section, turns
//     this red. Finally the real tree: the parser reads the real lockfile and
//     the tree this guard runs in is itself in sync.
//
// Usage: node scripts/check-deploy-script.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const deps = await import(pathToFileURL(join(ROOT, "scripts/deploy-deps.mjs")).href);

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

// ---- STRUCTURE: the deploy script carries both steps, in the right order ----
{
  const sh = readFileSync(join(ROOT, "scripts/deploy-production.sh"), "utf8").split("\n");
  const at = (re, from = 0) => { const i = sh.slice(from).findIndex((l) => re.test(l)); return i < 0 ? -1 : i + from; };
  const beforeLine = at(/^BEFORE_COMMIT="\$\(git rev-parse HEAD\)"/);
  const fetchLine = at(/git fetch origin/);
  const targetLine = at(/^TARGET_COMMIT="\$\(git rev-parse HEAD\)"/);
  const triggerLine = at(/^DEPS_TRIGGER="\$\(node scripts\/deploy-deps\.mjs trigger "\$BEFORE_COMMIT" "\$TARGET_COMMIT"\)"/);
  const ifLine = at(/^if \[ -n "\$DEPS_TRIGGER" \]; then$/);
  const installLine = at(/pnpm install --frozen-lockfile/);
  const fiLine = installLine >= 0 ? at(/^fi$/, installLine) : -1;
  const buildLine = at(/npm run build/);
  const verifyLine = at(/node scripts\/deploy-deps\.mjs verify/);
  const migrateLine = at(/apply-pending-migrations\.mjs/);
  const restartLine = at(/pm2 restart/);

  assert.ok(beforeLine >= 0 && fetchLine > beforeLine,
    "the previously deployed HEAD is captured BEFORE the fetch/fast-forward (it is the old side of the manifest diff)");
  assert.ok(triggerLine > targetLine && targetLine >= 0,
    "the deploy asks deploy-deps.mjs whether an install is needed, previous HEAD → target, once the target is known");
  assert.match(sh[triggerLine] ?? "", /\|\| fail /, "a failing detection aborts the deploy (fail-closed), it is never skipped");
  assert.ok(ifLine > triggerLine && installLine > ifLine && fiLine > installLine,
    "the install is CONDITIONAL — inside the DEPS_TRIGGER branch (an unconditional install hides a broken trigger and costs every deploy)");
  assert.equal(sh.filter((l) => /pnpm install/.test(l) && !/^\s*#/.test(l)).length, 1,
    "exactly one install command in the deploy (a second, unconditional one would defeat the trigger)");
  assert.match(sh[installLine] ?? "", /\|\| fail /,
    "an install failure routes through fail() — abort BEFORE the build, no restart");
  assert.ok(installLine >= 0 && buildLine > installLine,
    "the install precedes the build — a build against stale node_modules IS the incident");
  assert.ok(verifyLine > buildLine,
    "the installed tree is verified AFTER the build …");
  assert.ok(verifyLine >= 0 && verifyLine < migrateLine && verifyLine < restartLine,
    "… and BEFORE migrations and any pm2 restart — a mismatch never goes live");
  assert.match(sh[verifyLine] ?? "", /\|\| fail /, "a verify mismatch aborts before restart");
  ok("deploy script: BEFORE_COMMIT → fetch/ff → trigger → conditional install (|| fail) → build → verify (|| fail) → migrations → restart");
}

// ---- BEHAVIOUR 1: git detection on a scratch repository ----
const repo = mkdtempSync(join(tmpdir(), "gh-deploy-deps-"));
try {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "check", GIT_AUTHOR_EMAIL: "check@example.invalid",
    GIT_COMMITTER_NAME: "check", GIT_COMMITTER_EMAIL: "check@example.invalid",
  };
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env }).trim();
  const commit = (msg) => { git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  git("init", "-q");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { nodemailer: "^9.0.3" } }));
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      nodemailer:\n        specifier: ^9.0.3\n        version: 9.0.3\n");
  writeFileSync(join(repo, "src.txt"), "v1");
  const A = commit("A");
  writeFileSync(join(repo, "src.txt"), "v2");
  const B = commit("B: source only");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      nodemailer:\n        specifier: ^9.0.3\n        version: 9.1.1\n");
  const C = commit("C: lockfile only (the #250 shape)");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { nodemailer: "^9.1.1" } }));
  const D = commit("D: package.json only");

  assert.deepEqual(deps.changedDependencyFiles(A, B, repo), [],
    "a source-only release changes no manifest → no install");
  assert.deepEqual(deps.changedDependencyFiles(B, C, repo), ["pnpm-lock.yaml"],
    "a lockfile-only change is detected (the exact #250 shape: same specifier, new resolved version)");
  assert.deepEqual(deps.changedDependencyFiles(C, D, repo), ["package.json"],
    "a package.json-only change is detected");
  assert.deepEqual(deps.changedDependencyFiles(A, D, repo).sort(), ["package.json", "pnpm-lock.yaml"],
    "across several commits both manifests are reported");
  assert.deepEqual(deps.changedDependencyFiles(D, D, repo), [], "same commit on both sides → nothing");
  assert.throws(() => deps.changedDependencyFiles(A, "no-such-ref", repo),
    "an unresolvable ref throws — the deploy must abort, never treat it as 'unchanged'");
  ok("git detection: source-only → none; lockfile-only / package.json-only / both → reported; bad ref → throws");

  // the CLI in a tree with NO node_modules: fail-closed, it reports a reason
  const out = execFileSync(process.execPath, [join(ROOT, "scripts/deploy-deps.mjs"), "trigger", A, B],
    { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.match(out, /installed tree ≠ lockfile/,
    "a tree whose node_modules cannot be read triggers an install (fail-closed) even when git says 'unchanged'");
  ok("CLI trigger: an unreadable node_modules is a reason to install, never a pass");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

// ---- BEHAVIOUR 2: the lockfile parser on pnpm's real importer format ----
{
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "",
    "overrides:",
    "  postcss@<8.5.18: ^8.5.18",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      '@dnd-kit/core':",
    "        specifier: ^6.3.1",
    "        version: 6.3.1(react-dom@19.1.0(react@19.1.0))(react@19.1.0)",
    "      nodemailer:",
    "        specifier: ^9.1.1",
    "        version: 9.1.1",
    "    devDependencies:",
    "      typescript:",
    "        specifier: ^5",
    "        version: 5.9.2",
    "",
    "  packages/other:",
    "    dependencies:",
    "      left-pad:",
    "        specifier: ^1",
    "        version: 1.3.0",
    "",
    "packages:",
    "",
    "  nodemailer@9.1.1:",
    "    resolution: {integrity: sha512-x}",
    "",
    "snapshots:",
    "",
    "  '@dnd-kit/core@6.3.1(react-dom@19.1.0(react@19.1.0))(react@19.1.0)':",
    "    dependencies:",
    "      react:",
    "        version: 19.1.0",
    "",
  ].join("\n");
  const wanted = deps.wantedDirectDeps(lock);
  assert.deepEqual([...wanted.entries()], [
    ["@dnd-kit/core", "6.3.1"], ["nodemailer", "9.1.1"], ["typescript", "5.9.2"],
  ], "root importer: scoped/quoted names, peer suffix stripped, dev deps included; other importers, packages and snapshots ignored");
  ok("lockfile parser: the root importer's direct dependencies, and nothing else");

  const lsEqual = JSON.stringify([{ name: "guesthub", dependencies: {
    "@dnd-kit/core": { from: "@dnd-kit/core", version: "6.3.1" },
    nodemailer: { from: "nodemailer", version: "9.1.1" },
  }, devDependencies: { typescript: { from: "typescript", version: "5.9.2" } } }]);
  assert.deepEqual(deps.directDepMismatches(wanted, deps.installedDirectDeps(lsEqual)), [],
    "an installed tree at the wanted versions has no mismatch");
  const lsIncident = lsEqual.replace('"version":"9.1.1"', '"version":"9.0.3"');
  assert.deepEqual(deps.directDepMismatches(wanted, deps.installedDirectDeps(lsIncident)),
    [{ name: "nodemailer", wanted: "9.1.1", installed: "9.0.3" }],
    "THE INCIDENT: nodemailer 9.0.3 installed while the lockfile wants 9.1.1 is a mismatch");
  const lsMissing = JSON.stringify([{ name: "guesthub", dependencies: {
    "@dnd-kit/core": { version: "6.3.1" }, nodemailer: { version: "9.1.1" } } }]);
  assert.deepEqual(deps.directDepMismatches(wanted, deps.installedDirectDeps(lsMissing)),
    [{ name: "typescript", wanted: "5.9.2", installed: null }],
    "a wanted dependency that is not installed at all is a mismatch");
  ok("installed-vs-wanted: equal → none; 9.0.3 vs 9.1.1 → mismatch; missing → mismatch");
}

// ---- BEHAVIOUR 3: the real tree ----
{
  const real = deps.wantedDirectDeps(readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8"));
  assert.ok(real.size >= 20 && real.has("next") && real.has("nodemailer"),
    `the parser reads the real lockfile (${real.size} direct deps, next + nodemailer present)`);
  const mismatches = deps.verifyInstalled(ROOT);
  assert.deepEqual(mismatches, [],
    `the tree this guard runs in is in sync with its lockfile: ${deps.describeMismatches(mismatches)}`);
  const status = (() => {
    try { execFileSync(process.execPath, [join(ROOT, "scripts/deploy-deps.mjs"), "verify"], { cwd: ROOT, stdio: "ignore" }); return 0; }
    catch (e) { return e.status; }
  })();
  assert.equal(status, 0, "the CLI `verify` exits 0 on the in-sync tree");
  const trigger = execFileSync(process.execPath, [join(ROOT, "scripts/deploy-deps.mjs"), "trigger", "HEAD", "HEAD"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(trigger, "", "the CLI `trigger` prints nothing when neither manifest changed and the tree is in sync");
  ok("real tree: parser reads pnpm's format, verify exits 0, trigger HEAD..HEAD is silent");
}

console.log(`\ncheck-deploy-script: all ${n} assertions passed`);
