// check:timezone-and-money-invariants (Stage 3, V2 §8 time+money discipline).
// Compiles the pure shared modules and asserts:
//   MONEY  — balanceOf rounds to agorot and is UNFLOORED (credit is negative);
//            paymentState transitions; round2 edge cases; and (if CHECK_DB_URL
//            given) NO money column is stored as float/double in the schema.
//   TIME   — hotel-night math is DATE-ONLY and DST-INDEPENDENT across BOTH
//            Israeli DST transitions (spring-forward and fall-back), so night
//            counts never drift by an hour.
// Usage: [CHECK_DB_URL=...] node scripts/check-timezone-and-money-invariants.mjs
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "tzmoney-"));
execSync(
  `pnpm exec tsc src/lib/dates.ts src/lib/inventory-rules.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const dates = require(join(out, "dates.js"));
const rules = require(join(out, "inventory-rules.js"));

let n = 0; const ok = (m) => { console.log(`  ✓ ${m}`); n++; };

// ---- MONEY discipline ----
assert.equal(rules.balanceOf(300, 100), 200, "balance = total - paid");
assert.equal(rules.balanceOf(100, 150), -50, "overpayment is a NEGATIVE balance (credit), not floored to 0");
assert.equal(rules.balanceOf(0.1 + 0.2, 0), 0.3, "round2 tames float noise (0.1+0.2)");
assert.equal(rules.balanceOf(99.999, 0), 100, "agorot rounding");
ok("balanceOf: total-paid, unfloored credit, agorot-rounded");

assert.equal(rules.paymentState(300, 0), "unpaid");
assert.equal(rules.paymentState(300, 100), "partial");
assert.equal(rules.paymentState(300, 300), "paid");
assert.equal(rules.paymentState(300, 400), "overpaid");
ok("paymentState: unpaid/partial/paid/overpaid transitions");

assert.equal(rules.formatBalance(100, 150).kind, "credit");
assert.equal(rules.formatBalance(300, 100).kind, "due");
assert.equal(rules.formatBalance(300, 300).kind, "settled");
ok("formatBalance: sign-classified due/credit/settled");

// ---- TIME discipline: DST-independent hotel nights (Israel) ----
// Israel springs forward (~last Fri of March) and falls back (~last Sun of Oct).
assert.equal(dates.nightsBetween("2026-03-27", "2026-03-28"), 1, "spring-forward night still counts as 1");
assert.equal(dates.nightsBetween("2026-10-24", "2026-10-25"), 1, "fall-back night still counts as 1");
assert.equal(dates.nightsBetween("2026-03-01", "2026-04-01"), 31, "March span unaffected by DST start");
assert.equal(dates.addDays("2026-03-27", 1), "2026-03-28", "addDays across DST start does not drift");
assert.equal(dates.addDays("2026-10-24", 1), "2026-10-25", "addDays across DST end does not drift");
assert.equal(dates.eachDay("2026-03-27", "2026-03-30").length, 3, "eachDay across DST = 3 nights");
ok("hotel nights are date-only and DST-independent across both IL transitions");

// half-open overlap (same-day checkout+checkin coexist)
assert.equal(dates.rangesOverlap("2026-03-27","2026-03-29","2026-03-29","2026-03-31"), false, "adjacent stays don't overlap");
assert.equal(dates.rangesOverlap("2026-03-27","2026-03-30","2026-03-29","2026-03-31"), true, "true overlap detected");
ok("half-open overlap rule holds across a DST boundary");

// ---- MONEY discipline at the schema level (optional, needs a DB) ----
const dbUrl = process.env.CHECK_DB_URL || process.env.STAGING_DATABASE_URL;
if (dbUrl) {
  const floats = execFileSync("psql", [dbUrl, "-tAc",
    `select count(*) from information_schema.columns where table_schema='guesthub'
       and column_name ~ 'amount|price|balance|total|rate|discount|charge|paid'
       and data_type in ('double precision','real')`, "-X"], { encoding:"utf8" }).trim();
  assert.equal(floats, "0", "no money column is stored as float/double");
  ok("schema: 0 money columns stored as float/double (exact numeric only)");
} else {
  console.log("  · schema float-money scan skipped (no CHECK_DB_URL)");
}

console.log(`\ncheck:timezone-and-money-invariants PASSED (${n} groups)`);
