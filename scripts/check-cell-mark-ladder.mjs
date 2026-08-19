#!/usr/bin/env node
// ============================================================
// check:cell-mark-ladder — a calendar day cell shows exactly ONE restriction
// mark, and it is always the STRONGEST one that holds.
//
// THE DEFECT CLASS THIS EXISTS FOR. The cell used to draw its marks as
// independent booleans: a stop-sold date that also had a minimum-nights rule
// and a CTA drew the "סגור" flag, the moon AND the corner lock — three glyphs
// in a narrow day column, reading as three separate severities. The fix is an
// ORDER, and an order is exactly the kind of thing a later edit erodes one
// harmless-looking `&&` at a time: add a mark "just for CTA", and the cell is
// back to two signs with nobody noticing, because nothing else in the tree has
// an opinion about which sign won.
//
// THE SECOND DEFECT, and why min/max are ONE rung. The first ladder gave the
// minimum and the maximum a rung each. A cell carrying "at least 3, at most 7"
// therefore drew the MAXIMUM only, and the minimum — the end that actually
// turns bookings away — disappeared from the board. They are two ends of one
// rule, so they share one rung and the mark carries whichever ends exist.
// Splitting them back into two competing rungs must fail this guard.
//
// So this guard runs the REAL selection function, not a description of it:
//   · cellMark()          — the one place "which sign" is decided
//   · CELL_MARK_LADDER    — the one statement of priority
//   · stayRangeLabel()    — the three readings of the stay-range rung
// plus static assertions on the renderer, because a correct ladder that the JSX
// ignores is the same defect with better paperwork:
//   · CalendarGrid draws from `mark`, never from the raw restriction booleans
//   · the corner lock belongs to the two closed-to-* rungs ONLY — a maximum
//     draws its number, not a lock
//   · RateCellTooltip still lists ALL restrictions, CTA and CTD apart and the
//     minimum and maximum on their own lines — the ladder hides marks on the
//     CELL only; the hover card is where the full state is read.
//
// The ladder is VISUAL ONLY. It never decides what may be sold — that is
// rules.ts + the 084 override (check:restriction-override) — so this guard
// asserts nothing about enforcement, on purpose.
//
// D127 collect-all: every failure is reported, then the guard fails once.
// Static + pure. No DB, no network, no build.
// Usage: node scripts/check-cell-mark-ladder.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

// ---- compile the real module (tsc → CommonJS), same harness as check:restriction-override ----
const tmp = mkdtempSync(join(tmpdir(), "gh-cellmark-"));
const out = join(tmp, "out");
writeFileSync(
  join(tmp, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "commonjs", moduleResolution: "node10", target: "es2022",
      esModuleInterop: true, skipLibCheck: true, strict: true,
      baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
      rootDir: join(ROOT, "src"), outDir: out,
      typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
    },
    include: [join(ROOT, "src/lib/rates/cell-mark.ts")],
  }),
);
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const req = createRequire(join(ROOT, "package.json"));
const { cellMark, cellMinNights, cellMaxNights, stayRangeLabel, CELL_MARK_LADDER } =
  req(join(out, "lib/rates/cell-mark.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
// cellMark returns an OBJECT now (the stay-range rung has to carry its numbers),
// so every ordering assertion compares the rung NAME through this reader.
const nameOf = (result) => (result == null ? null : result.mark);

// A row with NO restriction at all. Every case below starts from this and turns
// on exactly the rungs it means to test — so a mark can never leak in from a
// field the case did not set.
const CLEAN = {
  closed: false,
  closed_to_arrival: false,
  closed_to_departure: false,
  max_nights: null,
  min_nights: null,
  min_stay_through: null,
};
// Turn a rung ON, at its weakest still-valid value.
const ON = {
  stop_sell: { closed: true },
  closed_to_arrival: { closed_to_arrival: true },
  closed_to_departure: { closed_to_departure: true },
  stay_range: { min_nights: 2 },
};

// The approved order, WRITTEN OUT HERE and never read from the module under
// test. Deriving it from CELL_MARK_LADDER would make every ordering assertion
// below self-referential — reversing the ladder would reverse the expectation
// with it and the guard would pass a fully inverted cell.
const EXPECTED = ["stop_sell", "closed_to_arrival", "closed_to_departure", "stay_range"];

// ============================================================
// 0. the ladder is the four approved rungs, in the approved order
// ============================================================
{
  assert.deepEqual([...CELL_MARK_LADDER], EXPECTED,
    "CELL_MARK_LADDER is the four approved rungs, strongest first");
  ok("the ladder is exactly the four approved rungs, in the approved order");
}

// ============================================================
// 1-4. each rung beats EVERY rung below it — all of them at once
// ============================================================
// This is the assertion the whole guard exists for. For rung i, a row that
// carries rung i AND every weaker rung simultaneously must still show rung i.
// Testing against "all the weaker ones together" (not one at a time) is what
// makes a re-ordering impossible to sneak past: any swap of two rungs breaks
// at least one of these four.
for (let i = 0; i < EXPECTED.length; i++) {
  const rung = EXPECTED[i];
  const weaker = EXPECTED.slice(i + 1);
  const row = { ...CLEAN, ...ON[rung] };
  for (const w of weaker) Object.assign(row, ON[w]);
  assert.equal(
    nameOf(cellMark(row)), rung,
    `${rung} wins over everything below it (${weaker.join(", ") || "nothing — it is the last rung"})`,
  );
  ok(`${rung} beats all ${weaker.length} weaker rung(s) at once`);
}

// ============================================================
// 5. a minimum AND a maximum are ONE rung carrying BOTH numbers
// ============================================================
{
  // THE regression this revision exists to prevent: as two rungs, this cell
  // showed only "7" and the guest who books 2 nights was turned away by a rule
  // the board never drew.
  const both = cellMark({ ...CLEAN, min_nights: 3, max_nights: 7 });
  assert.equal(nameOf(both), "stay_range", "a minimum and a maximum together are the stay-range rung");
  assert.equal(both.min, 3, "the stay-range mark carries the minimum");
  assert.equal(both.max, 7, "the stay-range mark carries the maximum — it does not replace the minimum");
  ok("minimum 3 + maximum 7 is ONE rung carrying BOTH numbers");
}

// ============================================================
// 6. a minimum on its own — one end, and only one
// ============================================================
{
  const only = cellMark({ ...CLEAN, min_nights: 3 });
  assert.equal(nameOf(only), "stay_range", "a minimum alone still reaches the stay-range rung");
  assert.equal(only.min, 3, "…carrying the minimum");
  assert.equal(only.max, null, "…and no maximum, because the row has none");
  ok("a minimum on its own carries one end and leaves the other null");
}

// ============================================================
// 7. a maximum on its own — one end, and only one
// ============================================================
{
  const only = cellMark({ ...CLEAN, max_nights: 7 });
  assert.equal(nameOf(only), "stay_range", "a maximum alone still reaches the stay-range rung");
  assert.equal(only.max, 7, "…carrying the maximum");
  assert.equal(only.min, null, "…and no minimum, because the row has none");
  // any positive maximum binds — unlike the minimum there is no free value
  assert.equal(cellMaxNights({ ...CLEAN, max_nights: 1 }), 1, "a maximum of 1 night is a real limit");
  ok("a maximum on its own carries one end and leaves the other null");
}

// ============================================================
// 8. a minimum of ONE night is not a restriction — the rung does not hold
// ============================================================
{
  // Every stay is at least one night, so min=1 forbids nothing. It must not put
  // a moon on the cell — otherwise the whole grid wears a mark.
  assert.equal(cellMark({ ...CLEAN, min_nights: 1 }), null, "min_nights = 1 alone draws no mark");
  assert.equal(cellMark({ ...CLEAN, min_stay_through: 1 }), null, "min_stay_through = 1 alone draws no mark");
  assert.equal(cellMark({ ...CLEAN, min_nights: 1, min_stay_through: 1 }), null,
    "both minimums = 1 still draws no mark");
  assert.equal(cellMinNights({ ...CLEAN, min_nights: 1 }), null, "cellMinNights agrees: 1 is not a minimum");
  // …and 2 IS
  assert.equal(nameOf(cellMark({ ...CLEAN, min_stay_through: 2 })), "stay_range",
    "a minimum of 2 DOES mark the cell");
  ok("a minimum of one night is not a restriction; two is");
}

// ============================================================
// 9. a stop-sell silences the numbers entirely
// ============================================================
{
  const row = cellMark({ ...CLEAN, closed: true, min_nights: 3 });
  assert.equal(nameOf(row), "stop_sell", "stop_sell together with a minimum shows ONLY stop_sell");
  assert.equal(row.min, undefined, "the stop-sell mark carries no numbers — it is not the stay-range rung");
  ok("stop_sell together with a minimum of 3 draws stop_sell and nothing else");
}

// ============================================================
// 10. no restriction at all → no mark
// ============================================================
{
  assert.equal(cellMark(CLEAN), null, "a row with no restriction draws no mark");
  assert.equal(cellMark(undefined), null, "a cell with no rate row at all draws no mark");
  assert.equal(cellMark(null), null, "a null rate row draws no mark");
  // a stored 0 is "unlimited" on the wire (D104), never a limit of zero
  assert.equal(cellMark({ ...CLEAN, max_nights: 0 }), null, "max_nights = 0 means unlimited, not a mark");
  assert.equal(cellMark({ ...CLEAN, min_nights: 0, min_stay_through: 0 }), null,
    "min nights = 0 means no minimum, not a mark");
  ok("a cell with no binding restriction is clean");
}

// ============================================================
// 11. the displayed minimum is the STRICTER of the two minimums
// ============================================================
{
  assert.equal(cellMinNights({ ...CLEAN, min_nights: 2, min_stay_through: 5 }), 5,
    "the through-min wins when it is stricter");
  assert.equal(cellMinNights({ ...CLEAN, min_nights: 4, min_stay_through: 2 }), 4,
    "the arrival-min wins when it is stricter");
  assert.equal(cellMinNights({ ...CLEAN, min_nights: 1, min_stay_through: 3 }), 3,
    "a non-binding 1 does not drag the displayed minimum down");
  ok("the minimum shown is the stricter of the arrival-min and the through-min");
}

// ============================================================
// 12. the three readings of the stay-range rung
// ============================================================
{
  // A bare "7" for a ceiling would read as a FLOOR of seven — the opposite
  // rule — so the maximum-only form must stay distinguishable from the
  // minimum-only form.
  assert.equal(stayRangeLabel(3, null), "3", "a minimum alone reads as the bare number");
  assert.equal(stayRangeLabel(null, 7), "≤7", "a maximum alone wears its ≤");
  assert.equal(stayRangeLabel(3, 7), "3–7", "both ends read as a range, with an en dash");
  assert.notEqual(stayRangeLabel(null, 7), stayRangeLabel(7, null),
    "a ceiling of 7 never renders the same as a floor of 7");
  assert.equal(stayRangeLabel(null, null), null, "no ends at all has no label — the rung does not hold");
  ok("the stay-range rung reads as 3 / ≤7 / 3–7, and a ceiling never looks like a floor");
}

// ============================================================
// 13. exactly one mark reaches the cell — the renderer draws from the ladder
// ============================================================
{
  const grid = readFileSync(join(ROOT, "src/app/(dashboard)/calendar/CalendarGrid.tsx"), "utf8");
  assert.ok(/const mark = cellMark\(rate\)/.test(grid),
    "the cell renderer asks cellMark() which sign to draw");
  // the cell body: from the price marker to the end of the sellable fragment
  const cellStart = grid.indexOf('className={`cb-pr ltr-num');
  const cellBody = grid.slice(cellStart, grid.indexOf("</div>", cellStart));
  assert.ok(cellStart > -1, "the day-cell body was located");
  // every mark is conditioned on `mark` / `lockMark` — never on a raw boolean
  for (const [cls, cond] of [
    ["cb-cx", /mark\.mark === "stop_sell" && <span className="cb-cx">/],
    ["cb-mn", /mark\.mark === "stay_range" && \(/],
    ["cb-rx", /\{lockMark && \(\s*<span className="cb-rx"/],
  ]) {
    assert.ok(cond.test(cellBody), `.${cls} is drawn from the ladder's choice, not from a raw restriction field`);
  }
  assert.ok(/mark\?\.mark === "stop_sell" \? "cx" : ""/.test(cellBody),
    "the struck-through price is driven by the ladder's choice too");
  // the numbers are rendered through the ladder's own formatter, so the three
  // readings cannot drift between the pure module and the JSX
  assert.ok(/stayRangeLabel\(mark\.min, mark\.max\)/.test(cellBody),
    "the stay-range numbers come from stayRangeLabel(), not from a second formatting rule");
  // …inside .ltr-num (§11), or the ≤ is flipped to the far side of its number
  assert.ok(/<span className="ltr-num">\{stayRangeLabel/.test(cellBody),
    "the stay-range numbers sit in .ltr-num so the ≤ is not reordered by the RTL direction");
  // the raw fields must not be re-read in the cell body — that is how a second
  // mark creeps back in
  for (const field of ["rate?.closed", "rate?.closed_to_arrival", "rate?.closed_to_departure", "rate?.max_nights"]) {
    assert.ok(!cellBody.includes(field),
      `the cell body does not re-read ${field} — the ladder already decided`);
  }
  ok("the renderer draws exactly the ladder's choice, never a raw restriction boolean");
}

// ============================================================
// 14. the corner lock belongs to the two closed-to-* rungs, and to them only
// ============================================================
{
  // A maximum draws its NUMBER. If it ever goes back to sharing the lock, the
  // cell stops saying how long a stay may be and says only "there is a rule".
  const grid = readFileSync(join(ROOT, "src/app/(dashboard)/calendar/CalendarGrid.tsx"), "utf8");
  const m = grid.match(/const lockMark =([\s\S]*?);/);
  assert.ok(m, "the lock's condition was located");
  const lock = m ? m[1] : "";
  assert.ok(/closed_to_arrival/.test(lock) && /closed_to_departure/.test(lock),
    "the lock is drawn for the closed-to-arrival and closed-to-departure rungs");
  assert.ok(!/stay_range|max_stay|min_nights/.test(lock),
    "the lock is NOT drawn for the stay-range rung — that rung draws its numbers");
  ok("the corner lock is the two closed-to-* rungs only; the stay-range rung draws numbers");
}

// ============================================================
// 15. the hover card still shows EVERY restriction, separately
// ============================================================
{
  // The ladder hides marks on the CELL. It must not hide FACTS: the detail card
  // is the only place the operator can read the full commercial state. The cell
  // deliberately cannot tell CTA from CTD and folds the two stay ends into one
  // mark — the hover card must still do both jobs in full.
  const tip = readFileSync(join(ROOT, "src/app/(dashboard)/calendar/RateCellTooltip.tsx"), "utf8");
  for (const [what, re] of [
    ["stop-sell", /stopSell && \(/],
    ["CTA", /\{cta && \(/],
    ["CTD", /\{ctd && \(/],
    ["max nights", /maxNights != null && \(/],
    ["min nights", /minNights != null && \(/],
  ]) {
    assert.ok(re.test(tip), `the hover card still lists ${what} on its own line`);
  }
  assert.ok(/\(CTA\)/.test(tip) && /\(CTD\)/.test(tip),
    "the hover card names CTA and CTD apart — the cell's single lock does not");
  assert.ok(/מינימום/.test(tip) && /מקסימום/.test(tip),
    "the hover card keeps the minimum and the maximum as two labelled lines — the cell merges them");
  assert.ok(!/cellMark|CELL_MARK_LADDER|stayRangeLabel/.test(tip),
    "the hover card does NOT go through the ladder — it is the full list, not the winner");
  ok("the hover card still lists every restriction, including the ones the cell merges or hides");
}

console.log(`\ncheck-cell-mark-ladder: all ${n} checks passed`);
