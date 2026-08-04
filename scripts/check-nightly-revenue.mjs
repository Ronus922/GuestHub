// check:nightly-revenue — the STEP 1 unit tests for the canonical per-night
// revenue expansion (src/lib/reports/nightly-revenue-rules.ts).
//
// Compiles the pure module with tsc and asserts it directly — no database, no
// network, no fixtures on disk. The two tests that are the whole point:
//
//   · a stay crossing a month boundary contributes ONLY its own nights to each
//     month (the defect revenueReport has: it adds the entire price_total to
//     every window the stay touches);
//   · the twelve months of a year SUM to the year.
//
// Usage: node scripts/check-nightly-revenue.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const out = mkdtempSync(join(tmpdir(), "nightly-revenue-"));
const SRC = join(process.cwd(), "src/lib/reports/nightly-revenue-rules.ts");
const cfg = join(out, "tsconfig.json");
// `files` resolves relative to the tsconfig, which lives in /tmp — so the entry
// is absolute, and rootDir pins the output layout to the repo root.
writeFileSync(
  cfg,
  JSON.stringify({
    compilerOptions: {
      outDir: out,
      module: "commonjs",
      target: "es2022",
      moduleResolution: "node10",
      skipLibCheck: true,
      strict: true,
      rootDir: process.cwd(),
    },
    files: [SRC],
  }),
);
execSync(`pnpm exec tsc -p ${cfg}`, { stdio: "inherit" });
const require = createRequire(import.meta.url);
const R = require(join(out, "src/lib/reports/nightly-revenue-rules.js"));

const ok = (m) => console.log(`  ✓ ${m}`);
const nightly = (from, nights, per) =>
  Array.from({ length: nights }, (_, i) => ({ date: R.addDaysUtc(from, i), nightTotal: per }));

// ---- helpers behave ---------------------------------------------------------
assert.equal(R.nightsBetweenUtc("2026-07-04", "2026-07-05"), 1, "one night");
assert.equal(R.addDaysUtc("2026-07-31", 1), "2026-08-01", "month rollover");
assert.equal(R.addDaysUtc("2026-12-31", 1), "2027-01-01", "year rollover");
ok("date helpers: hotel-night semantics, month and year rollover");

// ---- the even split is EXACT ------------------------------------------------
// 1000.00 over 3 nights: naive rounding gives 333.33×3 = 999.99 and the year
// stops summing to the year. Cumulative rounding must be exact.
{
  const parts = R.evenSplitAgorot(100000, 3);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100000, "split sums to the total exactly");
  // cumulative rounding: round(33333.3)=33333, round(66666.7)=66667 → 33334,
  // round(100000)=100000 → 33333. The extra agora lands on the middle night.
  assert.deepEqual(parts, [33333, 33334, 33333], "the remainder lands on exactly one night");
  const odd = R.evenSplitAgorot(10, 7);
  assert.equal(odd.reduce((a, b) => a + b, 0), 10, "a total smaller than the night count still sums");
  ok("even split: cumulative rounding, sum is exact to the agora");
}

// ---- a snapshot is only usable when it covers the stay ----------------------
{
  const base = { rrId: "x", checkIn: "2026-07-01", checkOut: "2026-07-04", priceTotal: 300 };
  assert.equal(
    R.snapshotCoversStay({ ...base, nightly: nightly("2026-07-01", 3, 100) }),
    true,
    "exact cover is usable",
  );
  assert.equal(
    R.snapshotCoversStay({ ...base, nightly: nightly("2026-07-01", 2, 100) }),
    false,
    "too few nights is not",
  );
  assert.equal(
    R.snapshotCoversStay({ ...base, nightly: nightly("2026-06-28", 3, 100) }),
    false,
    "right count, wrong dates — a stay re-dated after pricing — is not",
  );
  assert.equal(R.snapshotCoversStay({ ...base, nightly: null }), false, "absent is not");
  assert.equal(
    R.snapshotCoversStay({
      ...base,
      nightly: [
        { date: "2026-07-01", nightTotal: 100 },
        { date: "2026-07-01", nightTotal: 100 },
        { date: "2026-07-02", nightTotal: 100 },
      ],
    }),
    false,
    "a duplicated date is not",
  );
  ok("snapshot usability: exact cover only — stale dates fall back");
}

// ---- THE POINT #1: a month-crossing stay splits across the boundary ---------
{
  // 4 nights: 30, 31 July and 1, 2 August. ₪400 total, ₪100 a night.
  const row = {
    rrId: "cross",
    checkIn: "2026-07-30",
    checkOut: "2026-08-03",
    priceTotal: 400,
    nightly: nightly("2026-07-30", 4, 100),
  };
  const july = R.expandNightlyRevenue([row], "2026-07-01", "2026-08-01");
  const august = R.expandNightlyRevenue([row], "2026-08-01", "2026-09-01");
  assert.equal(july.total, 200, "July gets its two nights only, NOT the whole stay");
  assert.equal(august.total, 200, "August gets its two nights only");
  assert.equal(july.total + august.total, 400, "and together they are the stay, counted once");

  // the same stay with NO snapshot must split identically
  const noSnap = { ...row, nightly: null };
  const julyF = R.expandNightlyRevenue([noSnap], "2026-07-01", "2026-08-01");
  const augustF = R.expandNightlyRevenue([noSnap], "2026-08-01", "2026-09-01");
  assert.equal(julyF.total, 200, "fallback splits the boundary the same way");
  assert.equal(augustF.total, 200);
  assert.equal(julyF.fallbackTotal, 200, "and reports that all of it was fallback");
  assert.equal(julyF.rows.evenSplit, 1);
  ok("month boundary: each month gets ONLY its own nights, snapshot or fallback");
}

// ---- THE POINT #2: twelve months sum to the year ---------------------------
{
  // a spread of stays, several crossing month ends, one crossing the year end,
  // a mix of snapshot and snapshot-less rows
  const rows = [
    { rrId: "a", checkIn: "2026-01-28", checkOut: "2026-02-04", priceTotal: 700, nightly: nightly("2026-01-28", 7, 100) },
    { rrId: "b", checkIn: "2026-03-15", checkOut: "2026-03-18", priceTotal: 999, nightly: null },
    { rrId: "c", checkIn: "2026-06-29", checkOut: "2026-07-06", priceTotal: 1400, nightly: nightly("2026-06-29", 7, 200) },
    // stale snapshot: right count, wrong dates → must fall back, still prorate
    { rrId: "d", checkIn: "2026-09-30", checkOut: "2026-10-05", priceTotal: 1234.57, nightly: nightly("2026-08-01", 5, 246.914) },
    { rrId: "e", checkIn: "2026-11-20", checkOut: "2026-11-23", priceTotal: 555.55, nightly: null },
  ];
  const YEAR_FROM = "2026-01-01";
  const YEAR_TO = "2027-01-01";
  const year = R.expandNightlyRevenue(rows, YEAR_FROM, YEAR_TO);

  let monthsSum = 0;
  let monthsFallback = 0;
  for (let m = 0; m < 12; m++) {
    const from = `2026-${String(m + 1).padStart(2, "0")}-01`;
    const to = m === 11 ? "2027-01-01" : `2026-${String(m + 2).padStart(2, "0")}-01`;
    const month = R.expandNightlyRevenue(rows, from, to);
    monthsSum += Math.round(month.total * 100);
    monthsFallback += Math.round(month.fallbackTotal * 100);
  }
  assert.equal(
    monthsSum,
    Math.round(year.total * 100),
    "the twelve months sum to the year, to the agora",
  );
  assert.equal(monthsFallback, Math.round(year.fallbackTotal * 100), "and so does the fallback share");
  assert.equal(year.rows.total, 5);
  assert.equal(year.rows.snapshot, 2, "a and c use their snapshots");
  assert.equal(year.rows.evenSplit, 3, "b and e have none; d's is stale");
  assert.deepEqual(
    year.provenance.find((p) => p.rrId === "d"),
    { rrId: "d", path: "even_split", reason: "stale_snapshot" },
    "a stale snapshot is reported as such, not silently blended",
  );
  assert.deepEqual(
    year.provenance.find((p) => p.rrId === "b"),
    { rrId: "b", path: "even_split", reason: "no_snapshot" },
  );
  ok("twelve months sum to the year, to the agora — including the fallback share");
}

// ---- the window clips, it never redistributes ------------------------------
{
  const row = { rrId: "clip", checkIn: "2026-05-01", checkOut: "2026-05-11", priceTotal: 1000, nightly: null };
  const inside = R.expandNightlyRevenue([row], "2026-05-05", "2026-05-08");
  assert.equal(inside.total, 300, "three nights of a ten-night stay, not the whole total");
  assert.equal(inside.days.length, 3, "one entry per date in the window");
  const before = R.expandNightlyRevenue([row], "2026-04-01", "2026-05-01");
  assert.equal(before.total, 0, "a window the stay does not touch gets nothing");
  assert.equal(before.days.length, 30, "and is still zero-filled, not empty");
  ok("window clips to its own nights; nothing is redistributed");
}

// ---- degenerate rows own no night ------------------------------------------
{
  const zero = R.expandNightlyRevenue(
    [{ rrId: "z", checkIn: "2026-05-01", checkOut: "2026-05-01", priceTotal: 500, nightly: null }],
    "2026-05-01",
    "2026-06-01",
  );
  assert.equal(zero.total, 0, "a zero-night stay contributes nothing");
  assert.equal(zero.rows.snapshot + zero.rows.evenSplit, 0, "and takes neither path");
  ok("a zero-length stay owns no night and no path");
}

console.log("\ncheck-nightly-revenue: all assertions passed");
