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
//   · the cell's hover card is GONE and stays gone — component, state, timers,
//     hover listeners and CSS. The ladder is now the calendar's whole answer;
//     the full per-night state is read on the rates board.
//   · the MOBILE cell's TAP agrees with the sign the ladder made it draw: a
//     stop-sold night does not open a clean booking form (§17)
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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    include: [
      join(ROOT, "src/lib/rates/cell-mark.ts"),
      // section 16 asserts on the REAL restriction wording, not on a copy of it
      join(ROOT, "src/lib/rates/rules.ts"),
      join(ROOT, "src/lib/pricing/messages.ts"),
    ],
  }),
);
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const req = createRequire(join(ROOT, "package.json"));
// messages.ts reaches rules.ts through the "@/" alias — map it onto the emitted tree,
// the same hook check:restriction-override uses.
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const { cellMark, cellMinNights, cellMaxNights, stayRangeLabel, CELL_MARK_LADDER } =
  req(join(out, "lib/rates/cell-mark.js"));
const { stayViolationMessage } = req(join(out, "lib/rates/rules.js"));
const { PRICING_ERROR_MESSAGES } = req(join(out, "lib/pricing/messages.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
// Every static assertion below reads CODE, never prose: an identifier or an
// abbreviation named in a comment is documentation, and documenting the defect
// that was removed is exactly what a comment is for.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
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
  // minimum-only form. It says so as the full range 1–7 rather than a ≤: the
  // font the build serves has no U+2264 and rendered it as tofu.
  assert.equal(stayRangeLabel(3, null), "3", "a minimum alone reads as the bare number");
  assert.equal(stayRangeLabel(null, 7), "1–7", "a maximum alone reads as the full range from 1");
  assert.equal(stayRangeLabel(3, 7), "3–7", "both ends read as a range, with an en dash");
  assert.notEqual(stayRangeLabel(null, 7), stayRangeLabel(7, null),
    "a ceiling of 7 never renders the same as a floor of 7");
  assert.equal(stayRangeLabel(null, null), null, "no ends at all has no label — the rung does not hold");
  // U+2264 is not in the served font. No input may bring it back, whichever
  // ends are present — the en dash (U+2013) is the only separator, measured
  // present. Checked over every shape the rung can take, not just the one form
  // that used to carry it.
  for (const [min, max] of [[3, null], [null, 7], [3, 7], [1, 1], [null, 1], [1, null], [2, 99]]) {
    const label = stayRangeLabel(min, max);
    assert.ok(label == null || !label.includes("\u2264"),
      `stayRangeLabel(${min}, ${max}) = ${JSON.stringify(label)} must not contain U+2264`);
  }
  assert.ok(!readFileSync(join(ROOT, "src/lib/rates/cell-mark.ts"), "utf8").includes("\u2264"),
    "the cell-mark module carries no U+2264 at all — not in code, not in its comments");
  ok("the stay-range rung reads as 3 / 1–7 / 3–7, never returns U+2264, and a ceiling never looks like a floor");
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
  // …inside .ltr-num (§11), or the range is reordered around its en dash
  assert.ok(/<span className="ltr-num">\{stayRangeLabel/.test(cellBody),
    "the stay-range numbers sit in .ltr-num so the range is not reordered by the RTL direction");
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
// 15. the cell's hover card is DELETED — and no stump of it survives
// ============================================================
{
  // This section used to assert the opposite: that a hover card spelled out
  // every restriction the ladder folds away. The owner deleted that card — it
  // repeated the price and the minimum already printed on the cell, and covered
  // the rows underneath to say it. So the assertion is inverted, not dropped:
  // a deletion that leaves dead state, a dead timer or an orphan CSS rule is
  // not a deletion, and a quiet re-add must fail here rather than in review.
  //
  // The RESERVATION tooltip is a different component and stays — asserted below
  // so that "delete the tooltip" can never be read as "delete both".
  const CAL = "src/app/(dashboard)/calendar";
  assert.ok(!existsSync(join(ROOT, `${CAL}/RateCellTooltip.tsx`)),
    "the cell hover card's component file is gone, not merely unmounted");
  assert.ok(existsSync(join(ROOT, `${CAL}/ReservationTooltip.tsx`)),
    "the RESERVATION tooltip is untouched — only the cell's card was deleted");
  const grid = stripComments(readFileSync(join(ROOT, `${CAL}/CalendarGrid.tsx`), "utf8"));
  for (const stump of [
    "RateCellTooltip", "CellTipTarget", "cellTip", "setCellTip",
    "onCellHoverStart", "onCellHoverEnd", "scheduleCellTipClose",
  ]) {
    assert.ok(!grid.includes(stump),
      `CalendarGrid carries no \`${stump}\` left over from the deleted hover card`);
  }
  // the cell keeps its own pointer wiring; what it must NOT keep is a hover
  // pair that existed only to feed the card
  for (const listener of ["onPointerEnter={sellable", "onPointerLeave={sellable"]) {
    assert.ok(!grid.includes(listener),
      `the day cell no longer listens for ${listener.slice(0, 14)} — that listener fed the card and nothing else`);
  }
  assert.ok(!readFileSync(join(ROOT, "src/app/styles/calendar.css"), "utf8").includes("cb-cellpop"),
    "the card's dedicated CSS went with it — no orphan rule left behind");
  ok("the cell hover card is deleted whole: no component, no state, no timers, no listeners, no CSS");
}

// ============================================================
// 16. NO user-facing text spells a restriction as an English abbreviation
// ============================================================
{
  // THE DEFECT CLASS. "CTA" / "CTD" / "OOO" / "OOS" are trade shorthand. A
  // receptionist reading "התאריך סגור לצ׳ק-אין (CTA)" learns nothing from the
  // parenthesis, and a manager deciding whether to override a block should not
  // have to know that OOO means the room left the inventory. The abbreviations
  // are legitimate in CODES, in identifiers, in comments and in logs — this
  // assertion is about the SCREEN only.
  const ABBREV = /\b(CTA|CTD|OOO|OOS)\b/;

  // The same argument, made about DATES. "2026-08-25" is the wire format: it is
  // how a rate row stores a day, and it is unreadable as Hebrew prose — a staff
  // member reading "התאריך 2026-08-25 סגור למכירה" is being shown the database.
  // Every screen that can raise one of these messages is a calendar view whose
  // header already names the month and the year, so the sentence needs the day
  // and the month and nothing else. rules.ts formats it at the single source
  // (dayMonth), so no surface has to, and none may.
  const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

  // --- the messages themselves, run for real (not read from the file) ---
  const MESSAGE_CASES = [
    { code: "CLOSED_ON_ARRIVAL", date: "2026-07-10" },
    { code: "CLOSED_ON_DEPARTURE", date: "2026-07-12" },
    { code: "STOP_SELL", date: "2026-07-11" },
    { code: "MIN_STAY_NOT_MET", date: "2026-07-10", required: 3, scope: "arrival" },
    { code: "MIN_STAY_NOT_MET", date: "2026-07-10", required: 3, scope: "through" },
    { code: "MAX_STAY_EXCEEDED", date: "2026-07-10", limit: 7 },
  ];
  for (const v of MESSAGE_CASES) {
    const msg = stayViolationMessage(v);
    assert.ok(!ABBREV.test(msg), `stayViolationMessage(${v.code}/${v.scope ?? "-"}) is free of English abbreviations (got "${msg}")`);
    assert.ok(!ISO_DATE.test(msg), `stayViolationMessage(${v.code}/${v.scope ?? "-"}) shows no ISO date — a date it names is Hebrew D.M (got "${msg}")`);
  }
  for (const [code, msg] of Object.entries(PRICING_ERROR_MESSAGES)) {
    assert.ok(!ABBREV.test(msg), `PRICING_ERROR_MESSAGES.${code} is free of English abbreviations (got "${msg}")`);
    assert.ok(!ISO_DATE.test(msg), `PRICING_ERROR_MESSAGES.${code} shows no ISO date (got "${msg}")`);
  }
  // …and the two surfaces really do agree, because they read ONE declaration
  assert.equal(PRICING_ERROR_MESSAGES.CLOSED_ON_ARRIVAL, stayViolationMessage({ code: "CLOSED_ON_ARRIVAL", date: "2026-07-10" }),
    "client grid and server pricing say the SAME sentence for a closed arrival");
  assert.equal(PRICING_ERROR_MESSAGES.CLOSED_ON_DEPARTURE, stayViolationMessage({ code: "CLOSED_ON_DEPARTURE", date: "2026-07-12" }),
    "client grid and server pricing say the SAME sentence for a closed departure");

  // --- and no restriction SURFACE types one either, comments excluded ---
  const SURFACES = [
    "src/lib/rates/rules.ts",
    "src/lib/pricing/messages.ts",
    "src/app/(dashboard)/calendar/CalendarGrid.tsx",
    "src/app/(dashboard)/rates/RateGrid.tsx",
    "src/app/(dashboard)/rates/CellDetailPanel.tsx",
    "src/app/(dashboard)/rates/GroupUpdatePanel.tsx",
    "src/app/(dashboard)/rate-plans/OverridesPanel.tsx",
    "src/app/(dashboard)/rate-plans/RatePlanWizard.tsx",
  ];
  for (const rel of SURFACES) {
    const code = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    const hit = code.match(ABBREV);
    assert.ok(!hit, `${rel} carries no English restriction abbreviation outside its comments (found "${hit?.[0]}")`);
  }
  ok("no user-facing restriction text spells CTA / CTD / OOO / OOS — the messages agree across client and server");
}

// ============================================================
// 17. the MOBILE cell's tap agrees with the sign it just drew
// ============================================================
{
  // THE DEFECT. The mobile board learned to DRAW the two axes (physical hatch,
  // commercial "סגור" tag) but only the physical one disarmed the tap. A cell
  // wearing "סגור" opened a clean booking form — room 1006 in production is
  // closed on every date and every one of them was tappable — so the board
  // showed a sign and then contradicted it one tap later.
  //
  // Still VISUAL, not enforcement: this asserts nothing about what the server
  // may accept (rules.ts + the 084 override own that, and a manager may still
  // sell a stop-sold night from the desktop gate). It asserts only that the
  // tap on a cell answers the SAME axis the cell drew:
  //
  //   physical   → no handler at all. Silence. The row is hatched and dead.
  //   commercial → a toast, and only a toast. Deliberately NOT silence: the
  //                cell looks like a plain tappable cell wearing a tag, so a
  //                dead tap reads as a broken board.
  //   open       → the booking form, untouched.
  //
  // The two "no"s differing is the point; collapsing them in either direction
  // (silence the toast, or hatch the closed cell) must fail here.
  const CAL = "src/app/(dashboard)/calendar";
  const mobile = stripComments(readFileSync(join(ROOT, `${CAL}/MobileCalendar.tsx`), "utf8"));

  // the empty-cell body: from the AXIS-B predicate to the end of that cell
  const cellAt = mobile.indexOf("const closed =");
  assert.ok(cellAt > -1, "the mobile empty-cell body was located");
  const cell = cellAt > -1 ? mobile.slice(cellAt, mobile.indexOf("</div>", cellAt)) : "";

  // --- the commercial mark the tap reacts to is the LADDER's, not a raw field ---
  assert.match(cell, /cellMark\(cellRate\(room, d\)\)\?\.mark === "stop_sell"/,
    "the mobile cell asks cellMark() whether the night is stop-sold — not rate.closed directly");
  assert.match(cell, /roomSellable &&\s*cellMark\(/,
    "the commercial question is asked only where the physical axis already allows selling");

  // --- physical: NO handler. Not a no-op, not a toast. ---
  assert.match(cell, /!roomSellable\s*\n?\s*\?\s*undefined/,
    "a physically unsellable cell gets onClick={undefined} — silence, no handler; the state is a fact about the ROOM, not about this date");
  // …and a user who cannot BOOK gets no booking handler either. The two used to
  // be one test (`!roomSellable || !canCreate`), which quietly swallowed a third
  // thing: a dated CLOSURE is opened from this cell now, and reservations.create
  // is not the permission for that. So the closure branch is asked first and the
  // create permission gates only what it is actually about.
  assert.match(cell, /:\s*!canCreate\s*\n?\s*\?\s*undefined/,
    "…and the create permission gates the BOOKING branches alone, below the closure branch");

  // --- commercial: a toast, and the booking form is NOT opened ---
  assert.match(cell, /closed\s*\n?\s*\?\s*\(\)\s*=>\s*toast\.\w+\(/,
    "a commercially closed cell taps into a toast");
  assert.equal((cell.match(/onEmptyTap\(/g) ?? []).length, 1,
    "onEmptyTap is reachable from exactly ONE branch — the closed branch must not also open the booking form");
  assert.match(cell, /:\s*\(\)\s*=>\s*onEmptyTap\(room\.id, d\)/,
    "the remaining branch — an open, sellable cell — still opens the booking form");

  // --- the toast says the ONE canonical sentence, and does not re-type it ---
  assert.match(cell, /toast\.\w+\(\s*stayViolationMessage\(\{\s*code:\s*"STOP_SELL",\s*date:\s*d\s*\}\)\s*\)/,
    "the toast's Hebrew comes from stayViolationMessage(STOP_SELL) — the one place restriction wording lives");
  assert.doesNotMatch(cell, /"[^"]*סגור למכירה[^"]*"/,
    "the mobile cell does not re-type the stop-sell sentence as a literal — that is how two spellings start");
  // …and that one sentence really is the stop-sell sentence, run for real —
  // whole, so the DATE inside it is pinned too: the toast a guest-facing clerk
  // reads names the day in Hebrew, not in the storage format.
  assert.equal(stayViolationMessage({ code: "STOP_SELL", date: "2026-08-25" }), "התאריך 25.8 סגור למכירה",
    "stayViolationMessage(STOP_SELL) is the exact sentence the mobile toast shows, date included, in Hebrew D.M");

  // --- mobile gets feedback, never a window (the owner's ruling) ---
  for (const stump of ["isOverridableStayCode", "setBlockedCreate", "המשך בכל זאת", "<Dialog", "cb-gate"]) {
    assert.ok(!mobile.includes(stump),
      `MobileCalendar carries no \`${stump}\` — a closed night on mobile is a toast, not an override dialog`);
  }
  ok("the mobile cell's tap answers the axis it drew: physical is silent, commercial toasts the canonical sentence, open still books");
}

console.log(`\ncheck-cell-mark-ladder: all ${n} checks passed`);
