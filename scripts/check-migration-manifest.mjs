#!/usr/bin/env node
// ============================================================
// check:migration-manifest — db/migrations/manifest.txt is the apply order of
// record, and it must describe the directory exactly.
//
// THE DEFECT (D136). The manifest is hand-maintained: a new migration needs its
// filename added, by a human, in the same commit. That convention failed three
// times — 041 and 061 (both caught the same day by a separate catch-up commit)
// and 075, which shipped to production unlisted and stayed that way.
//
// Nothing caught it. There is no CI. `deploy:prod` never opens the manifest —
// apply-pending-migrations.mjs enumerates the directory — so an unlisted
// migration applies, records, and deploys perfectly. The only code that reads
// the whole file is scripts/db/migrate.mjs, the replay runner, which ABORTS
// (exit 2) before it connects. So the cost of a missing line is not a broken
// deploy: it is a replay-from-zero that cannot run at all, and therefore a
// guard suite that silently stops being verified against a rebuilt schema.
//
// Four sibling guards (055/056/058/068) each assert their OWN migration is
// listed. None of them can see anyone else's. This one reconciles the set.
//
// D127 — this guard COLLECTS every violation and fails ONCE at the end. A guard
// that halts on the first finding can say "something is wrong" but never
// "nothing else is", and the second question is the one a reconciliation exists
// to answer.
//
// Static only: no DB, no network, no build. Usage: node scripts/check-migration-manifest.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(ROOT, "db", "migrations");
const MANIFEST = join(MIG_DIR, "manifest.txt");
console.log(`# tree under test: ${ROOT}`);

// Parsed exactly as scripts/db/migrate.mjs parses it — same trim, same blank
// and #-comment handling. A guard that read the file differently from the
// runner would be checking a manifest nobody applies.
const entries = readFileSync(MANIFEST, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const onDisk = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"));

const violations = [];

// --- direction 1: every .sql on disk is listed ---
// An unlisted file is invisible to the replay runner's ordering AND aborts it
// outright, which is how 075 killed replay-from-zero for a day.
const listed = new Set(entries);
for (const f of [...onDisk].sort()) {
  if (!listed.has(f)) violations.push(`${f} is on disk but missing from manifest.txt — the replay runner ABORTS (exit 2) on an unlisted migration`);
}

// --- direction 2: every listed entry exists on disk ---
// A stale entry is the rollback signature: a bad merge or revert drops the .sql
// and leaves the line behind.
const diskSet = new Set(onDisk);
for (const e of entries) {
  if (!diskSet.has(e)) violations.push(`manifest.txt lists ${e} which is not on disk — a dropped or renamed migration file`);
}

// --- direction 3: no duplicates ---
// A duplicate line applies a migration twice on replay. Individually-idempotent
// files survive it; not every file is.
const seen = new Set();
for (const e of entries) {
  if (seen.has(e)) violations.push(`manifest.txt lists ${e} more than once — a replay would apply it twice`);
  seen.add(e);
}

// every offending file in every direction is reported, not just the first
assert.equal(
  violations.length,
  0,
  `manifest.txt does not describe db/migrations/ — ${violations.length} violation(s):\n` +
    violations.map((v) => `  - ${v}`).join("\n"),
);

console.log(`✓ manifest.txt reconciles with db/migrations/ — ${entries.length} entries, ${onDisk.length} files on disk, no duplicates`);
