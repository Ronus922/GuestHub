#!/usr/bin/env node
// ============================================================
// check:guard-roots — a guard MUST test the tree it lives in.
//
// THE DEFECT. `const ROOT = "/var/www/guesthub"` — the production checkout.
// Run from any worktree, such a guard reads and compiles PRODUCTION's src/ and
// reports on code its author never wrote. It cannot fail on a local change,
// because it never sees one. Three guards carried this:
//
//   check-pricing-engine.mjs        reported "ALL 35 PASSED" on a change it had
//                                   never compiled (fixed in D100)
//   check-messaging.mjs             stayed green after aes-256-gcm was gutted
//                                   out of a worktree's secrets.ts
//   check-channels-fullsync-ui.mjs  stayed green after the exact `bg-brand`
//                                   defect it exists to catch was injected into
//                                   a worktree component — and it WROTE its
//                                   Tailwind scratch dir into production's
//                                   node_modules/.cache while doing so
//
// All three were caught only because a number failed to add up, never because a
// guard went red. Nothing else would have caught them. This does.
//
// THE RULE. No guard may pin an absolute path to a SOURCE TREE. Resolve from
// import.meta.url (preferred) or from cwd. A guard that genuinely must read a
// deployed tree opts out in the open, on one line, and says so in its output:
//
//   // guard-roots: allow-absolute — <why>
//
// Static only: no DB, no network, no build. Usage: node scripts/check-guard-roots.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

const ALLOW = /^\s*\/\/\s*guard-roots:\s*allow-absolute\b/;
// CANDIDATES — an absolute path under a location that hosts checkouts.
// /opt/google/chrome/chrome and /usr/bin/... are installed binaries, /tmp is
// scratch — those are runtime locations, not source trees, and are not the defect.
const ABSOLUTE = /["'`](\/(?:var\/www|home)\/[^"'`\s]*)["'`]/g;

// CLASSIFIER — the location alone does not make a path the defect. /var/www and
// /home also hold ARTIFACT directories that nobody compiles: a backup target
// ("/home/ubuntu/guesthub-backups") or an upload store ("/var/www/guesthub-uploads")
// is a destination for bytes, and pinning one cannot make a guard read source it
// never wrote — the harm this rule exists to prevent is structurally impossible
// there. The defect is a path used as a PROJECT ROOT. Three independent signals,
// any one of which convicts, so that renaming the binding cannot launder a
// source read:
//
//   SHAPE  the literal itself descends into a tree ("…/guesthub/src/x.ts")
//   ROLE   the binding it is assigned to declares a root (ROOT, REPO, CHECKOUT…)
//   USE    the binding is joined with a source path, or handed out as a cwd
//
// Every defect this guard was written for still convicts on ROLE alone; a
// candidate with none of the three is a data directory and not this rule's
// business. Narrowing the classification is NOT a licence to widen it back by
// renaming: SHAPE and USE hold when ROLE is dodged (canary, check 4).
const SOURCE_PATH =
  /\/(?:src|app|scripts|components|lib|db|public|node_modules)(?:\/|$)|\/(?:package|tsconfig)[^/]*\.json$|\.(?:tsx?|mjs|cjs|jsx?|css)$/;
const ROOT_ROLE = new Set(["ROOT", "REPO", "CHECKOUT", "PROJECT", "WORKTREE", "TREE", "CWD"]);
const esc = (s) => s.replace(/[$]/g, "\\$&");
const bindingOf = (line) =>
  (line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/) ??
    line.match(/^\s*([A-Za-z_$][\w$]*)\s*=[^=]/))?.[1] ?? null;
const usedAsRoot = (name, body) => {
  const n = esc(name);
  for (const m of body.matchAll(new RegExp(String.raw`(?:join|resolve)\s*\(\s*${n}\s*,\s*['"\x60]([^'"\x60]+)`, "g")))
    if (SOURCE_PATH.test(`/${m[1]}`)) return true;
  for (const m of body.matchAll(new RegExp(String.raw`\$\{\s*${n}\s*\}(/[^'"\x60\s)]*)`, "g")))
    if (SOURCE_PATH.test(m[1])) return true;
  return new RegExp(String.raw`cwd:\s*${n}\b`).test(body);
};
const isSourceRoot = (path, line, body) => {
  if (SOURCE_PATH.test(path)) return true; // SHAPE
  const name = bindingOf(line);
  if (!name) return false;
  return name.split(/[_$]/).some((t) => ROOT_ROLE.has(t.toUpperCase())) // ROLE
    || usedAsRoot(name, body); // USE
};

// Blank out comments while PRESERVING line structure, so a reported line number
// is the real one. (Stripping them outright made every hit report line 5.)
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([ \t]*)\/\/.*$/gm, "$1");

const scripts = readdirSync(join(ROOT, "scripts"))
  .filter((f) => f.endsWith(".mjs"))
  .sort();
assert.ok(scripts.length > 50, `expected the full guard set, found ${scripts.length}`);

// The scan is ONE function, used for the real guard set and for the canary
// alike. That is deliberate: neutralize it and check 4 fails too, so check 1
// can never pass vacuously while looking structurally intact.
const scanForAbsolute = (name, raw) => {
  const found = [];
  const body = stripComments(raw);
  const lines = body.split("\n");
  for (const m of body.matchAll(ABSOLUTE)) {
    const line = body.slice(0, m.index).split("\n").length;
    if (!isSourceRoot(m[1], lines[line - 1] ?? "", body)) continue;
    found.push(`${name}:${line} → ${m[1]}`);
  }
  return found;
};

// ---- 1. no guard names an absolute checkout path in executable code ----
const offenders = [];
const optedOut = [];
for (const f of scripts) {
  const raw = readFileSync(join(ROOT, "scripts", f), "utf8");
  if (raw.split("\n").some((l) => ALLOW.test(l))) { optedOut.push(f); continue; }
  offenders.push(...scanForAbsolute(f, raw));
}
assert.deepEqual(
  offenders, [],
  `guards naming an absolute checkout path (they test that tree, not this one):\n  ${offenders.join("\n  ")}`,
);
ok(`${scripts.length} guard scripts scanned — none names an absolute checkout path`
   + (optedOut.length ? ` (${optedOut.length} declared opt-out: ${optedOut.join(", ")})` : ""));

// ---- 2. an opt-out must SAY SO at run time, not just in a comment ----
for (const f of optedOut) {
  const raw = readFileSync(join(ROOT, "scripts", f), "utf8");
  assert.ok(
    /console\.(log|warn|error)\(/.test(raw) && /tree under test|reads a deployed tree/i.test(raw),
    `${f} opts out of guard-roots but never announces the tree it reads in its output`,
  );
}
ok(optedOut.length
  ? "every opt-out announces the tree it reads in its own output"
  : "no opt-outs to verify");

// ---- 3. the three guards burned by this must resolve from their own location ----
for (const f of ["check-pricing-engine.mjs", "check-messaging.mjs", "check-channels-fullsync-ui.mjs"]) {
  const raw = readFileSync(join(ROOT, "scripts", f), "utf8");
  assert.match(
    stripComments(raw),
    /fileURLToPath\(\s*import\.meta\.url\s*\)/,
    `${f} must resolve its root from import.meta.url — it was hardcoded to production before`,
  );
  assert.match(raw, /tree under test/, `${f} must print the root it resolved at run time`);
}
ok("the three guards that were hardcoded to production now resolve from import.meta.url and print it");

// ---- 4. CANARY: the rule actually rejects the original defect ----
// Assembled at run time so this file does not itself contain the literal it
// bans — the guard is subject to its own rule, not exempted from it.
const PROD = ["", "var", "www", "guesthub"].join("/");
const HOME_WT = ["", "home", "ubuntu", "worktrees", "x"].join("/");
const HOME_CO = ["", "home", "ubuntu", "guesthub"].join("/");
const BACKUPS = ["", "home", "ubuntu", "guesthub-backups"].join("/");
const UPLOADS = ["", "var", "www", "guesthub-uploads"].join("/");
const scan = (s) => scanForAbsolute("canary", s);

// positive control — the scan path itself must produce a hit, with the right line
const hit = scan(`const A = 1;\nconst ROOT = "${PROD}";\nreadFileSync(join(ROOT, "src/x.ts"));\n`);
assert.deepEqual(hit, [`canary:2 → ${PROD}`], "the scan must flag a hardcoded production root, on its real line");
assert.deepEqual(scan(`const ROOT = "${HOME_WT}";\n`), [`canary:1 → ${HOME_WT}`],
  "a worktree path pinned by absolute is the same defect and must be flagged");
// negative controls — the rule must not fire on things that are not the defect
assert.deepEqual(scan(`// we used to write const ROOT = "${PROD}" here\nconst ROOT = cwd();\n`), [],
  "a comment recording the history must not trip the rule");
assert.deepEqual(scan(`/* ${PROD} */\nconst ROOT = cwd();\n`), [],
  "a block comment recording the history must not trip the rule");
assert.deepEqual(scan(`const CHROME = "/opt/google/chrome/chrome";\n`), [],
  "an installed binary is not a checkout and must not trip the rule");

// ---- the SOURCE-ROOT vs DATA-DIRECTORY classification, both directions ----
// positive: a checkout under /home is the same defect as one under /var/www
assert.deepEqual(scan(`const ROOT = "${HOME_CO}";\n`), [`canary:1 → ${HOME_CO}`],
  "a pinned checkout under /home is the defect exactly as under /var/www");
// positive: ROLE dodged — a source read may not be laundered by renaming
assert.deepEqual(scan(`const DIR = "${PROD}";\nreadFileSync(join(DIR, "src/x.ts"));\n`), [`canary:1 → ${PROD}`],
  "renaming the binding must not launder a pinned root that is read as source (USE)");
assert.deepEqual(scan(`const DIR = "${HOME_CO}";\nspawnSync("pnpm", ["build"], { cwd: DIR });\n`), [`canary:1 → ${HOME_CO}`],
  "a pinned tree handed out as a cwd is a root whatever its binding is called (USE)");
// positive: no binding at all — the literal descends into a tree by itself
assert.deepEqual(scan(`readFileSync("${PROD}/src/x.ts");\n`), [`canary:1 → ${PROD}/src/x.ts`],
  "a bare literal that descends into a tree needs no binding to be the defect (SHAPE)");
// negative: an artifact directory is a destination for bytes, not a tree
assert.deepEqual(
  scan(`const BACKUPS_DIR = process.env.BACKUPS_DIR || "${BACKUPS}";\nif (existsSync(BACKUPS_DIR)) scanBackupsDir(BACKUPS_DIR);\n`),
  [], "a backup directory default is a data destination, not a source root");
assert.deepEqual(scan(`const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "${UPLOADS}";\njoin(UPLOADS_DIR, "rooms", id);\n`),
  [], "an upload store joined with data segments is not a source root");
// the negatives must not be passing merely because nothing under them is scanned
assert.deepEqual(scan(`const ROOT = "${BACKUPS}";\n`), [`canary:1 → ${BACKUPS}`],
  "the data-directory path is still flagged the moment it is pinned AS a root — the classifier reads the role, not an allowlist of paths");
ok("canary: the same scan used above flags a hardcoded checkout root (/var/www and /home) on its real line by shape, role or use — and stays quiet on comments, installed binaries and artifact directories");

console.log(`\ncheck:guard-roots PASSED (${n} checks)`);
