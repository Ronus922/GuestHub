#!/usr/bin/env node
// ============================================================
// check:deploy-script — the deploy installs dependencies when the manifests
// changed, and never restarts onto a stale node_modules (D185); the base of
// that manifest diff is the last DEPLOYED commit, recorded in .deploy-state,
// never the working-tree HEAD (D191).
//
// Incident (2026-09-10, #250): pnpm-lock.yaml moved nodemailer 9.0.3 → 9.1.1;
// deploy-production.sh had no install step, built against the old
// node_modules and printed "✓ DEPLOYED" for a bundle still shipping 9.0.3.
// Incident (2026-09-12, deploy #1): D185 took the base from HEAD before the
// fetch; a manual `git pull` had already moved HEAD to the target, the range
// collapsed to HEAD..HEAD and the install was skipped for a release that
// changed package.json.
//
// B2-STYLE. Two halves, each red if its fix is reverted:
//   · STRUCTURE — deploy-production.sh resolves the diff base through
//     scripts/deploy-state.mjs (the record; HEAD only as the loud fallback)
//     BEFORE the fetch, asks scripts/deploy-deps.mjs whether an install is
//     needed (deployed → target), installs INSIDE that conditional with
//     `|| fail`, BEFORE the build; verifies the installed tree AFTER the build,
//     BEFORE migrations and any pm2 restart, with `|| fail`; and writes the
//     record ONLY after the restart, the route checks and the success line.
//     Making the install unconditional, moving it after the build, dropping
//     either `|| fail`, deriving BEFORE_COMMIT from `git rev-parse HEAD`, or
//     writing the record before the restart turns this red.
//   · BEHAVIOUR — the helper itself, on fixtures: the git detection against a
//     scratch repository (manifest changed / unchanged / only one of the two),
//     the lockfile parser on pnpm's real importer format, and the
//     installed-vs-wanted comparison on the exact incident (9.0.3 installed,
//     9.1.1 wanted). Ignoring the version, or the lockfile section, turns
//     this red. The record on the same scratch repository: missing → HEAD and
//     the fallback line; present → its commit; HEAD moved by a pull → a
//     WARNING and STILL the record, so the manifest change is detected where
//     HEAD..HEAD found nothing; corrupt or unknown commit → throws. Finally the
//     real tree: the parser reads the real lockfile and the tree this guard
//     runs in is itself in sync.
//
// Usage: node scripts/check-deploy-script.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const deps = await import(pathToFileURL(join(ROOT, "scripts/deploy-deps.mjs")).href);
const st = await import(pathToFileURL(join(ROOT, "scripts/deploy-state.mjs")).href);

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

// ---- STRUCTURE: the deploy script carries both steps, in the right order ----
{
  const sh = readFileSync(join(ROOT, "scripts/deploy-production.sh"), "utf8").split("\n");
  const at = (re, from = 0) => { const i = sh.slice(from).findIndex((l) => re.test(l)); return i < 0 ? -1 : i + from; };
  const headLine = at(/^HEAD_COMMIT="\$\(git rev-parse HEAD\)"/);
  const stateFileLine = at(/^DEPLOY_STATE_FILE="\$\{DEPLOY_STATE_FILE:-\.deploy-state\}"/);
  const beforeLine = at(/^BEFORE_COMMIT="\$\(node scripts\/deploy-state\.mjs read "\$DEPLOY_STATE_FILE" "\$HEAD_COMMIT"\)"/);
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
  const routeLoopLine = at(/^for r in \/ \/login \/calendar; do/);
  const successLine = at(/✓ DEPLOYED/);
  const writeLine = at(/node scripts\/deploy-state\.mjs write "\$DEPLOY_STATE_FILE" "\$TARGET_COMMIT" "\$NEW_BUILD_ID"/);

  assert.ok(headLine >= 0 && stateFileLine > headLine && beforeLine > stateFileLine && fetchLine > beforeLine,
    "the diff base is resolved from .deploy-state (HEAD only as the documented fallback) BEFORE the fetch/fast-forward (D191)");
  assert.equal(sh.filter((l) => /^BEFORE_COMMIT=/.test(l)).length, 1, "BEFORE_COMMIT is assigned exactly once");
  assert.ok(!sh.some((l) => /^BEFORE_COMMIT="\$\(git rev-parse HEAD\)"/.test(l)),
    "BEFORE_COMMIT is never `git rev-parse HEAD` — a manual pull before the deploy collapses that range to nothing (D191)");
  assert.match(sh[beforeLine] ?? "", /\|\| fail /, "an unreadable record aborts (fail-closed), never a guessed base");
  assert.ok(writeLine >= 0 && writeLine > restartLine && writeLine > routeLoopLine && writeLine > successLine,
    "the record is written ONLY after the restart, the route checks and the success line — a failed deploy keeps the previous record");
  assert.equal(sh.filter((l) => /deploy-state\.mjs write/.test(l) && !/^\s*#/.test(l)).length, 1, "exactly one write of the record");
  assert.ok(readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").includes(".deploy-state"),
    ".deploy-state is gitignored — runtime state of the marked checkout, never source");
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
  ok("deploy script: base from .deploy-state → fetch/ff → trigger → conditional install (|| fail) → build → verify (|| fail) → migrations → restart → checks → record written last");
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

  // ---- D191: the diff base comes from the record, not from HEAD ----
  const stateFile = join(repo, ".deploy-state");
  const missing = st.resolveBase({ stateFile, headCommit: D, cwd: repo });
  assert.deepEqual([missing.base, missing.source, missing.log], [D, "head", [st.NO_STATE_LINE]],
    "no record → HEAD is the base, and the fallback is said out loud");
  st.writeState(stateFile, { commit: A, build: "build-A" });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(stateFile, "utf8"))).sort(), ["at", "build", "commit"], "the record is {commit, build, at}");
  const same = st.resolveBase({ stateFile, headCommit: A, cwd: repo });
  assert.deepEqual([same.base, same.source, same.log], [A, "state", []], "record == HEAD → the record is the base, no warning");
  const pulled = st.resolveBase({ stateFile, headCommit: D, cwd: repo });
  assert.equal(pulled.base, A, "THE INCIDENT: HEAD moved by a manual pull → the base is still the recorded deployed commit");
  assert.match(pulled.log.join("\n"), /^WARNING: HEAD .* != \.deploy-state commit .*manual pull/, "… and it is logged as a WARNING");
  assert.deepEqual(deps.changedDependencyFiles(pulled.base, D, repo).sort(), ["package.json", "pnpm-lock.yaml"],
    "so the manifest change between the deployed commit and the pulled HEAD is detected (HEAD..HEAD found nothing)");
  writeFileSync(stateFile, "{not json");
  assert.throws(() => st.resolveBase({ stateFile, headCommit: D, cwd: repo }), /not JSON/, "a corrupt record throws — the deploy aborts instead of guessing");
  writeFileSync(stateFile, JSON.stringify({ commit: "0".repeat(40), build: "x" }));
  assert.throws(() => st.resolveBase({ stateFile, headCommit: D, cwd: repo }), /not in this repository/, "a record naming a commit this repository lacks throws");
  rmSync(stateFile);
  const bin = join(ROOT, "scripts/deploy-state.mjs");
  const r1 = spawnSync(process.execPath, [bin, "read", stateFile, D], { cwd: repo, encoding: "utf8" });
  assert.deepEqual([r1.status, r1.stdout], [0, D], "CLI read, no record → prints HEAD");
  assert.match(r1.stderr, /no \.deploy-state — base derived from HEAD/, "… and the fallback line goes to stderr");
  const w = spawnSync(process.execPath, [bin, "write", stateFile, A, "build-1"], { cwd: repo, encoding: "utf8" });
  assert.equal(w.status, 0, "CLI write exits 0");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).commit, A, "… and the record carries the commit");
  const r2 = spawnSync(process.execPath, [bin, "read", stateFile, D], { cwd: repo, encoding: "utf8" });
  assert.deepEqual([r2.status, r2.stdout], [0, A], "CLI read with a record and a moved HEAD → prints the record");
  assert.match(r2.stderr, /WARNING/, "… with the WARNING on stderr");
  const corrupt = spawnSync(process.execPath, [bin, "read", stateFile.replace(/\.deploy-state$/, "pnpm-lock.yaml"), D], { cwd: repo, encoding: "utf8" });
  assert.equal(corrupt.status, 1, "CLI read on an unreadable record exits 1 (the deploy aborts)");
  ok("deploy-state: missing → HEAD (loud); present → the record; HEAD moved → WARNING + the record, manifest change detected; corrupt/unknown → abort; CLI read/write");
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
