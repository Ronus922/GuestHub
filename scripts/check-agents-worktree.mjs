#!/usr/bin/env node
// check:agents-worktree — AGENTS.md and CLAUDE.md must keep the D147 rule: work
// happens on a dedicated branch INSIDE the production tree, and a worktree is an
// exception Ronen asks for explicitly.
//
// Why this guard exists: AGENTS.md is a GENERATED artifact — `gen-catalog.sh` on
// the `ai2u-vs1` hub rebuilds it from this project's CLAUDE.md body plus the kit's
// skills/agents catalog. CLAUDE.md itself is hand-maintained and is never written
// by the generator (DECISIONS D193). So a regen drops anything that lives ONLY in
// AGENTS.md — exactly how the Concurrency section was lost (DECISIONS D90 →
// check:agents-concurrency), and the same exposure D147 carries.
//
// Both files are checked, and that is deliberate: AGENTS.md because it is loaded
// into every session and an agent reads it as a live order, and CLAUDE.md because
// it is the INPUT the next regen rebuilds AGENTS.md from — pre-D147 wording
// surviving there would be copied straight back out.
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
