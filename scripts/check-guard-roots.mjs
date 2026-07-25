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
// THE RULE. No guard may name an absolute filesystem path. Resolve from
// import.meta.url (preferred) or from cwd. A guard that genuinely must read a
// deployed tree opts out in the open, on one line, and says so in its output:
//
//   // guard-roots: allow-absolute — <why>
//
// Static only: no DB, no network, no build. Usage: node scripts/check-guard-roots.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

const ALLOW = /^\s*\/\/\s*guard-roots:\s*allow-absolute\b/;
// An absolute path that points at a CHECKOUT. /opt/google/chrome/chrome and
// /usr/bin/... are installed binaries, /tmp is scratch — those are runtime
// locations, not source trees, and are not the defect.
const ABSOLUTE = /["'`](\/(?:var\/www|home)\/[^"'`\s]*)["'`]/g;

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

// ---- 1. no guard names an absolute checkout path in executable code ----
const offenders = [];
const optedOut = [];
for (const f of scripts) {
  const raw = readFileSync(join(ROOT, "scripts", f), "utf8");
  if (raw.split("\n").some((l) => ALLOW.test(l))) { optedOut.push(f); continue; }
  const body = stripComments(raw);
  for (const m of body.matchAll(ABSOLUTE)) {
    const line = body.slice(0, m.index).split("\n").length;
    offenders.push(`${f}:${line} → ${m[1]}`);
  }
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
const test = (s) => { ABSOLUTE.lastIndex = 0; return ABSOLUTE.test(stripComments(s)); };
assert.ok(test(`const ROOT = "${PROD}";\nreadFileSync(join(ROOT, "src/x.ts"));\n`),
  "the rule must reject the original defect");
assert.ok(!test(`// we used to write const ROOT = "${PROD}" here\nconst ROOT = cwd();\n`),
  "a comment recording the history must not trip the rule");
assert.ok(!test(`const CHROME = "/opt/google/chrome/chrome";\n`),
  "an installed binary is not a checkout and must not trip the rule");
assert.ok(test(`const ROOT = "${["", "home", "ubuntu", "worktrees", "x"].join("/")}";\n`),
  "a worktree path pinned by absolute is the same defect and must trip the rule");
ok("canary: rejects a hardcoded checkout root (both /var/www and /home), ignores it in a comment, allows an installed binary");

console.log(`\ncheck:guard-roots PASSED (${n} checks)`);
