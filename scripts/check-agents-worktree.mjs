#!/usr/bin/env node
// check:agents-worktree — AGENTS.md and CLAUDE.md must keep the D147 rule: work
// happens on a dedicated branch INSIDE the production tree, and a worktree is an
// exception Ronen asks for explicitly.
//
// Why this guard exists: both files are regenerated from the DevOPS kit template
// on the `ai2u-vs1` hub, and that template still carries the pre-D147 wording
// ("אסור לפתח בו — כל עבודה נעשית ב-git worktree נפרד"). A regen therefore
// silently restores an instruction the owner revoked — and AGENTS.md is loaded
// into every session, so an agent reads it as a live order. This already
// happened once to the Concurrency section (DECISIONS D90 → check:agents-
// concurrency); D147 is the same exposure.
//
// The word "worktree" alone cannot be the signal: the corrected AGENTS.md still
// says `git worktree add` legitimately (Concurrency — verifying a build in an
// isolated tree) and names the worktree exception itself. So the guard keys on
// the DIRECTIVE, from both sides — the branch-is-the-path wording must be
// PRESENT, and the worktree-is-the-path wording must be ABSENT.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["AGENTS.md", "CLAUDE.md"];

// D147 wording, verbatim from CLAUDE.md.
const REQUIRED = [
  "branch ייעודי ישירות בעץ הזה",
  "worktree — רק בבקשה מפורשת של רונן",
];
// pre-D147 template wording — what a regen brings back.
const FORBIDDEN = [
  "נעשית ב-git worktree נפרד",
  "אסור לפתח בו",
];

let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

for (const file of FILES) {
  const text = readFileSync(join(root, file), "utf8");
  for (const phrase of REQUIRED) {
    if (text.includes(phrase)) pass(`${file}: D147 wording present — "${phrase}"`);
    else flag(`${file}: D147 wording MISSING — "${phrase}". A gen-catalog regen wiped it; restore it from the other file and add it to the DevOPS kit template on ai2u-vs1 (DECISIONS D90, D147)`);
  }
  for (const phrase of FORBIDDEN) {
    if (text.includes(phrase)) flag(`${file}: pre-D147 worktree mandate is BACK — "${phrase}". D147 revoked it: work on a dedicated branch in the tree; a worktree only when Ronen asks for one (DECISIONS D147)`);
    else pass(`${file}: pre-D147 worktree mandate absent — "${phrase}"`);
  }
}

if (fail) { console.log(`\ncheck:agents-worktree — FAIL (${fail})`); process.exit(1); }
console.log("check:agents-worktree — PASS");
