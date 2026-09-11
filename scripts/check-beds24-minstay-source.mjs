#!/usr/bin/env node
// check:beds24-minstay-source — the Beds24 `minStay` carries min_stay_THROUGH,
// and the read-back COMPARES it.
//
// WHY (D183). Beds24's calendar has exactly ONE daily minimum-stay field, and
// every mapped room is configured restrictionStrategy "stayThrough" — so that
// field binds every night of the stay. The payload builder fed it the ARRIVAL
// variant instead (`minStayArrival`), while `minStayThrough` — the column the
// Rate Grid's "מינימום לילות" writes — was computed, carried on the interchange
// row, and read by nobody. Because min_stay_arrival is NULL tenant-wide the
// plan default (1) won, so the field was not merely missing: every drain
// published `minStay: 1`, and the calendar POST being a partial update with no
// clear, each drain RE-ASSERTED that 1 upstream.
//
// It stayed invisible for six weeks because the read-back deliberately skipped
// restrictions: 344 consecutive cycles reported driftCells=0 over 210 cells
// while Beds24 held minStay 1 on dates GuestHub held 2. Booking.com then sold a
// 1-night stay (reservation 1164, 2026-09-11) on one of them.
//
// So a grep-shaped guard is worthless here: the OLD code also contained the
// string "minStay", also compiled, also passed every existing check. What has
// to be asserted is the CAUSAL chain, by running it:
//   (a) the real builder, on a row whose through and arrival DISAGREE, emits
//       the through value — and emits nothing when only arrival is set;
//   (b) the real read-back parses the field off the wire, carries it onto both
//       sides of the comparison, and raises drift when they differ — while
//       staying silent on cells we never stated (the room-level fallback the
//       old skip was written around).
//
// Usage: node scripts/check-beds24-minstay-source.mjs
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import Module from "node:module";
import { join } from "node:path";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const ROOT = process.cwd();

// Compile the worker graph to a THROWAWAY dir. Never dist/worker: in the
// production tree that directory is the artifact PM2 is running, and a guard
// must not be able to overwrite the live worker with uncommitted code.
const OUT = mkdtempSync(join(tmpdir(), "d183-"));
try {
  execSync(`pnpm exec tsc -p tsconfig.worker.json --outDir ${OUT}`, { stdio: "pipe" });
} catch (e) {
  console.error("REFUSED: the worker graph does not compile\n" + (e.stdout?.toString() ?? e.message));
  rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
}

const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  // the scratch build sits outside the repo, so bare specifiers resolve against
  // the project's own node_modules
  if (!request.startsWith(".") && !request.startsWith("/")) {
    try { return origResolve.call(this, join(ROOT, "node_modules", request), ...rest); } catch { /* builtin */ }
  }
  return origResolve.call(this, request, ...rest);
};
const require_ = createRequire(import.meta.url);
const payloads = require_(join(OUT, "lib/channel/beds24-ari-payloads.js"));
const readback = require_(join(OUT, "lib/channel/beds24-ari-readback.js"));

const ROOM = "room-uuid-1";
const PLAN = "plan-uuid-1";
const MAPPING = {
  roomId: ROOM, beds24PropertyId: "342449", beds24RoomId: "707494",
  localRatePlanId: PLAN, maxStayCeiling: 365,
};
/** one projected day; `through` and `arrival` are set INDEPENDENTLY on purpose */
const day = (date, through, arrival) => ({
  roomId: ROOM, planId: PLAN, date,
  rates: [{ occupancy: 2, rate: 799 }],
  minStayThrough: through,
  // present on the fixture but ABSENT from CommercialRow since D183 — if the
  // builder ever reads it again, these assertions are what notices.
  minStayArrival: arrival,
  maxStay: null, stopSell: false,
  closedToArrival: false, closedToDeparture: false, blockedReason: null,
});
const projectionOf = (days) => ({
  availability: days.map((d) => ({ roomId: ROOM, date: d.date, availability: 1 })),
  commercial: days, blocked: [],
});
const rangesOf = (days) =>
  payloads.buildBeds24CalendarRequests(projectionOf(days), [MAPPING]).requests[0][0].calendar;

// ============================================================
// A. the payload builder sources minStay from min_stay_THROUGH
// ============================================================
{
  // THE assertion. through and arrival disagree, so exactly one of them can be
  // on the wire — and only one of them is the stay-through restriction Beds24
  // is configured to enforce.
  const [r] = rangesOf([day("2026-09-11", 3, 5)]);
  assert.equal(r.minStay, 3,
    "minStay is the THROUGH minimum (3), not the arrival minimum (5)");
  assert.notEqual(r.minStay, 5,
    "min_stay_arrival never reaches the Beds24 wire — it is internal to the site and manual bookings");
  ok("through=3 arrival=5 → minStay 3 (the pre-D183 builder emitted 5)");

  // the discriminating case: with NO through value, the field must be ABSENT.
  // The old builder emitted the arrival value here, which is exactly how
  // `minStay: 1` got published over dates that carried a real restriction.
  const [only] = rangesOf([day("2026-09-11", null, 5)]);
  assert.equal("minStay" in only, false,
    "a day with no through-minimum publishes NO minStay — an omitted field leaves Beds24's own value standing");
  ok("through=null arrival=5 → minStay omitted, not 5");

  // minStay must be a COMPRESSION KEY, or two dates with different minimums
  // collapse into one range and the stricter date silently loses its value.
  const ranges = rangesOf([day("2026-09-10", 1, null), day("2026-09-11", 2, null), day("2026-09-12", 2, null)]);
  assert.equal(ranges.length, 2, "a change in minStay splits the range (it is a compression key)");
  assert.deepEqual(ranges.map((x) => [x.from, x.to, x.minStay]),
    [["2026-09-10", "2026-09-10", 1], ["2026-09-11", "2026-09-12", 2]],
    "each range carries its own through-minimum");
  ok("differing minimums do not collapse into one range");
}

// ============================================================
// B. the read-back requests, parses, carries and COMPARES minStay
// ============================================================
{
  // B1 — off the wire. A parser that drops the field makes every later
  // assertion vacuous, so this is asserted before the comparison.
  const parsed = readback.parseBeds24CalendarBody({
    data: [{ roomId: 707494, calendar: [{ from: "2026-09-11", to: "2026-09-12", numAvail: 1, price1: 799, minStay: 1, maxStay: 365 }] }],
  });
  assert.equal(parsed.entries[0].calendar[0].minStay, 1,
    "minStay is parsed off the Beds24 response, not discarded");
  assert.equal(parsed.entries[0].calendar[0].maxStay, 365, "maxStay is parsed too");
  ok("the read-back parser keeps minStay/maxStay");

  // B2 — onto OUR side of the comparison, from the very payload the push builds
  const expected = readback.expandBeds24Calendar(
    readback.expectedEntriesOf(
      payloads.buildBeds24CalendarRequests(projectionOf([day("2026-09-11", 2, null)]), [MAPPING]).requests,
    ),
    { from: "2026-09-11", toInclusive: "2026-09-11" },
  );
  assert.equal([...expected.values()][0].minStay, 2,
    "the expected side carries the minStay the push would send");
  ok("expectedEntriesOf → expandBeds24Calendar carries minStay");

  // B3 — the comparison itself. This is the assertion the six-week blind spot
  // would have failed every cycle since 2026-09-06.
  const cell = (minStay) => new Map([["707494|2026-09-11",
    { beds24RoomId: 707494, date: "2026-09-11", numAvail: 1, price1: 799, minStay, maxStay: 365 }]]);
  const drift = readback.diffBeds24Calendar(cell(2), cell(1));
  assert.equal(drift.length, 1, "we hold 2 and Beds24 holds 1 → exactly one drift row");
  assert.equal(drift[0].kind, "minStay", "…reported as minStay drift, with its own kind");
  assert.deepEqual([drift[0].expected, drift[0].remote], [2, 1], "…carrying both sides of the divergence");
  assert.equal(drift[0].oversell, false, "a wrong minimum sells nights we withheld — it is not a double-booked bed");
  ok("minStay divergence is drift (0 drift cells was the bug, not the baseline)");

  assert.equal(readback.diffBeds24Calendar(cell(2), cell(2)).length, 0, "agreement is not drift");
  // the control the old skip was written around: apiV2.yaml documents that a
  // calendar with no minStay answers with the ROOM's value. A cell we never
  // stated is therefore unattributable — and must never be a false positive.
  assert.equal(readback.diffBeds24Calendar(cell(null), cell(1)).length, 0,
    "a cell we did not state is not compared — the room-level fallback cannot cry wolf");
  ok("agreement is silent, and so is a cell we never stated");

  // B4 — maxStay rides the same path (it never had the through/arrival split,
  // and the live dry-run showed 0 maxStay drift; this keeps it that way).
  const mx = (maxStay) => new Map([["707494|2026-09-11",
    { beds24RoomId: 707494, date: "2026-09-11", numAvail: 1, price1: 799, minStay: 1, maxStay }]]);
  const mxDrift = readback.diffBeds24Calendar(mx(365), mx(30));
  assert.equal(mxDrift.length, 1, "a maxStay divergence is drift too");
  assert.equal(mxDrift[0].kind, "maxStay", "…under its own kind");
  ok("maxStay is compared on the same terms");

  // B5 — the one claim no pure call can reach: the GET must ASK for the
  // fields, or the remote side is null everywhere and B3 fires on every cell.
  const src = readFileSync(join(ROOT, "src/lib/channel/beds24-ari-readback.ts"), "utf8");
  assert.match(src, /"includeMinStay=true"/,
    "the read-back GET requests minStay (apiV2.yaml: without an includeX the field is not returned)");
  assert.match(src, /"includeMaxStay=true"/, "…and maxStay");
  ok("the read-back GET asks Beds24 for the restriction fields");
}

// ============================================================
// C. no reader of the arrival column survives in the channel layer
// ============================================================
{
  const files = ["beds24-ari-payloads.ts", "beds24-ari-projection.ts", "beds24-ari-readback.ts",
    "beds24-ari-sync.ts", "beds24-ari.ts", "ari-projection.ts"];
  for (const f of files) {
    const body = readFileSync(join(ROOT, "src/lib/channel", f), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(body, /minStayArrival/,
      `${f} does not reference minStayArrival outside comments — the arrival minimum is internal (D183)`);
  }
  ok("the channel layer holds no arrival-minimum code path at all");
}

Module._resolveFilename = origResolve;
rmSync(OUT, { recursive: true, force: true });
console.log(`\ncheck-beds24-minstay-source: all ${n} assertions passed`);
