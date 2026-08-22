#!/usr/bin/env node
// ============================================================
// check:closure-redesign — the closure panel's calendar, as an operator meets
// it after the owner's "סגירת חדר זמנית" reference landed.
//
// THE DEFECTS THIS EXISTS FOR:
//
//   1. The form showed NOTHING about the room. A range straight through a
//      booked week looked exactly like a free one; the operator learned about
//      the collision from a red toast after the save. Now the room's owed
//      nights are painted and are not click targets.
//   2. Even with the nights painted, a range can be DRAWN over one — click
//      before it, click after it. That has to be caught in the panel, not only
//      by the server's overlap check.
//   3. An existing closure being re-dated must not read its OWN nights as
//      taken, or it could never be shortened.
//   4. The reason stayed the CLOSED 084 taxonomy. The reference draws six
//      chips of its own invention; free text as a category is how a taxonomy
//      forks into five spellings of "תחזוקה".
//   5. In edit mode the footer carries three actions. `.dw-ft` wraps at phone
//      widths — right for every other drawer, and exactly wrong here: the
//      owner's requirement is ONE row at 360px, nothing stacked and nothing
//      hidden behind a menu.
//
// Runtime where it can be (the occupancy model is compiled and CALLED over the
// boundaries it actually breaks on), static where it cannot (a React
// component's state machine needs a browser to run).
// No DB, no network, no build.
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-closure-redesign.mjs
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

// ---- compile the real pure module, same harness as check:closure-panel-ux ----
const tmp = mkdtempSync(join(tmpdir(), "gh-closureredesign-"));
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
      join(ROOT, "src/lib/closures/occupancy.ts"),
      join(ROOT, "src/lib/closures/categories.ts"),
    ],
  }),
);
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const {
  blocksInventory, nightState, occupiedNights, rangeBlocks, rangeUnknownNights,
} = req(join(out, "lib/closures/occupancy.js"));
const { CLOSURE_CATEGORY_VALUES } = req(join(out, "lib/closures/categories.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CAL = "src/app/(dashboard)/calendar";
const panel = stripComments(read(`${CAL}/ClosurePanel.tsx`));
const cal = stripComments(read(`${CAL}/ClosureCalendar.tsx`));
const screen = stripComments(read(`${CAL}/CalendarScreen.tsx`));
const css = read("src/app/styles/closure-panel.css");
const responsive = read("src/app/styles/responsive.css");

/** the body of the first CSS rule whose selector line starts with `sel` */
const rule = (src, sel) => {
  const at = src.indexOf(sel);
  return at < 0 ? "" : src.slice(at, src.indexOf("}", at));
};

const WINDOW = { from: "2026-08-20", to: "2026-09-10" };
const STAY = {
  room_id: "r1", check_in: "2026-08-27", check_out: "2026-08-29",
  status: "confirmed", guest_name: "שרה לוי",
};

// ============================================================
// 1. A night a blocking reservation holds is painted and is NOT a target
// ============================================================
{
  const occ = occupiedNights({ roomId: "r1", stays: [STAY], closures: [] });

  assert.equal(nightState("2026-08-27", occ, WINDOW), "blocked",
    "the arrival night of a confirmed stay is blocked");
  assert.equal(nightState("2026-08-28", occ, WINDOW), "blocked",
    "…and so is the night after it");
  assert.equal(nightState("2026-08-29", occ, WINDOW), "free",
    "…but the DEPARTURE day is free: check_out is exclusive, and a room emptied in the morning can be closed that night");
  assert.equal(nightState("2026-08-26", occ, WINDOW), "free",
    "…and the night before the arrival is free");

  // the room matters — a stay in another room paints nothing here
  const other = occupiedNights({ roomId: "r2", stays: [STAY], closures: [] });
  assert.equal(nightState("2026-08-27", other, WINDOW), "free",
    "another room's booking never blocks this one");

  // D126 — every status but 'cancelled' consumes inventory, and the panel
  // reads it from the ONE declaration rather than a list of its own
  for (const s of CLOSURE_STATUSES()) {
    assert.equal(blocksInventory(s), true,
      `'${s}' holds its nights — a draft nobody paid for is still a booking (D126)`);
  }
  assert.equal(blocksInventory("cancelled"), false,
    "…and only 'cancelled' releases them");
  const drafted = occupiedNights({
    roomId: "r1", closures: [],
    stays: [{ ...STAY, status: "draft" }],
  });
  assert.equal(nightState("2026-08-27", drafted, WINDOW), "blocked",
    "…so a DRAFT blocks the closure calendar exactly like a confirmed stay");
  const cancelled = occupiedNights({
    roomId: "r1", closures: [],
    stays: [{ ...STAY, status: "cancelled" }],
  });
  assert.equal(nightState("2026-08-27", cancelled, WINDOW), "free",
    "…and a cancelled one blocks nothing");

  // another CLOSURE is occupancy too — the reference paints both red
  const closed = occupiedNights({
    roomId: "r1", stays: [],
    closures: [{ id: "c9", room_id: "r1", start_date: "2026-09-01", end_date: "2026-09-03" }],
  });
  assert.equal(nightState("2026-09-01", closed, WINDOW), "blocked",
    "an existing closure's nights are blocked as well");
  assert.equal(nightState("2026-09-03", closed, WINDOW), "free",
    "…up to its exclusive end, which is a night the room is free");

  // ---- and the CELL is what refuses the click ----
  assert.match(cal, /const state = nightState\(d, occupied, occWindow\)/,
    "the cell asks the model what it is");
  assert.match(cal, /const disabled = state === "blocked" \|\| d < today/,
    "…and a blocked night — or a past one — is not a target");
  assert.match(cal, /disabled=\{disabled\}/,
    "…which the button actually carries, so the click cannot land at all");
  assert.match(cal, /state === "blocked" \? "busy" : ""/,
    "…and it is painted, not silently inert");
  assert.match(rule(css, "  .cp-day.busy,"), /color-mix\(in srgb, var\(--danger\)/,
    "…in a tint DERIVED from --danger, because the system has no soft-danger token to invent one against");

  ok("a night held by a blocking reservation or another closure is painted and refuses the click — departure days, other rooms and cancelled bookings excluded, proven by running the model");
}

function CLOSURE_STATUSES() {
  return ["draft", "confirmed", "checked_in", "checked_out", "no_show", "blocked"];
}

// ============================================================
// 2. A range DRAWN OVER a taken night is stopped in the panel
// ============================================================
{
  const occ = occupiedNights({ roomId: "r1", stays: [STAY], closures: [] });

  const crossing = rangeBlocks("2026-08-25", "2026-08-30", occ);
  assert.equal(crossing.length, 2,
    "a range drawn from before the stay to after it reports BOTH of its nights — the cells were never clicked, the span went over them");
  assert.deepEqual(crossing.map((c) => c.date), ["2026-08-27", "2026-08-28"],
    "…naming exactly which nights");
  assert.equal(crossing[0].label, "שרה לוי",
    "…and who holds them, so the message can say it");
  assert.equal(rangeBlocks("2026-08-21", "2026-08-26", occ).length, 0,
    "a range that stops before the stay reports nothing");
  assert.equal(rangeBlocks("2026-08-29", "2026-08-31", occ).length, 0,
    "…and one that starts on the departure day reports nothing either");

  // the honest third state: outside the board's loaded window nothing is known
  assert.equal(rangeUnknownNights("2026-09-08", "2026-09-12", WINDOW), 3,
    "nights past the loaded window count as UNKNOWN — the panel has no data there and does not pretend the range is free");
  assert.equal(rangeUnknownNights("2026-08-21", "2026-08-23", WINDOW), 0,
    "…while a range fully inside it has none");

  // ---- and the panel is the caller, and it BLOCKS ----
  assert.match(panel, /const conflicts = lastNight \? rangeBlocks\(startDate, lastNight, occupied\) : \[\]/,
    "the panel computes the crossing from the selection it holds");
  assert.match(panel, /const blocked = conflicts\.length > 0/,
    "…and a crossing is a blocked state, not a warning");
  assert.match(panel, /disabled=\{saving \|\| !roomId \|\| !startDate \|\| !endDate \|\| nights < 1 \|\| blocked\}/,
    "…which disables the primary action — the collision stops here, not at the toast");
  assert.match(panel, /התנגשות עם \$\{conflicts\.length\} לילות תפוסים/,
    "…and it is SAID, with the count");
  assert.match(panel, /role=\{blocked \? "alert" : undefined\}/,
    "…announced to a screen reader too");
  // the server rule is untouched: the panel is the courtesy, not the gate
  const actions = read(`${CAL}/actions.js`.replace(".js", ".ts"));
  assert.match(actions, /createClosureAction|updateClosureAction/,
    "the closure actions still exist and still own the write");
  assert.ok(!panel.includes("המשך בכל זאת") && !panel.includes("סגור בכל זאת"),
    "…and nothing in the panel offers to close over a booking anyway — the reference's override does not exist here (a physical closure is not negotiable)");

  ok("a range drawn across a taken night is named, counted and refused in the panel, with the server's overlap check untouched behind it");
}

// ============================================================
// 3. A closure being edited is not occupancy against itself
// ============================================================
{
  const own = { id: "c1", room_id: "r1", start_date: "2026-08-24", end_date: "2026-08-27" };
  const withSelf = occupiedNights({ roomId: "r1", stays: [], closures: [own] });
  assert.equal(nightState("2026-08-24", withSelf, WINDOW), "blocked",
    "seen from ANOTHER closure, c1's nights are taken");

  const editing = occupiedNights({
    roomId: "r1", stays: [], closures: [own], ignoreClosureId: "c1",
  });
  assert.equal(nightState("2026-08-24", editing, WINDOW), "free",
    "…but the panel editing c1 sees them free, or c1 could never be shortened");
  assert.equal(rangeBlocks("2026-08-24", "2026-08-25", editing).length, 0,
    "…so shrinking c1 to two nights is not a collision with c1");

  // a DIFFERENT closure in the same room still blocks while c1 is edited
  const neighbour = occupiedNights({
    roomId: "r1", stays: [],
    closures: [own, { id: "c2", room_id: "r1", start_date: "2026-08-30", end_date: "2026-09-01" }],
    ignoreClosureId: "c1",
  });
  assert.equal(nightState("2026-08-30", neighbour, WINDOW), "blocked",
    "…while the room's OTHER closure still blocks — the exemption is for one id, not for closures as a class");

  assert.match(panel, /ignoreClosureId: edit\?\.id/,
    "the panel passes the closure under edit as the exemption — and only in edit mode, where `edit` is what exists");

  ok("the closure under edit is exempt from its own occupancy, and nothing else in the room is");
}

// ============================================================
// 4. The reason is still the CLOSED taxonomy
// ============================================================
{
  assert.match(panel, /CLOSURE_CATEGORIES\.map\(/,
    "the chips are BUILT from the taxonomy — a seventh value appears without touching the panel");
  assert.match(panel, /useState<ClosureCategory \| "">\(""\)/,
    "…and the field's type is the closed union, so free text can never be assigned to it");
  assert.match(panel, /category: category \|\| undefined/,
    "…and what is sent is that value or nothing — never a typed sentence");
  assert.match(panel, /maxLength=\{200\}/,
    "the free text stays the COMPLEMENT, capped where the Zod schema caps it");
  const validation = read("src/lib/validation/reservation.ts");
  assert.match(validation, /reason: z\.string\(\)\.trim\(\)\.max\(200\)\.optional\(\)/,
    "…which is 200 server-side — the reference's 240 would be a cap the server rejects");
  assert.match(validation, /category: z\.enum\(CLOSURE_CATEGORY_VALUES\)\.optional\(\)/,
    "…and the category the server accepts is still exactly the closed set");
  assert.equal(CLOSURE_CATEGORY_VALUES.length, 6,
    "the taxonomy is six values — the chip row renders the list, it does not choose from it");
  for (const label of ["תחזוקה", "ניקיון", "שיפוץ", "שימוש פרטי", "שכירות ארוכה", "אחר"]) {
    assert.ok(!panel.includes(`"${label}"`),
      `the panel does not retype '${label}' — the label comes from lib/closures/categories`);
  }
  ok("the reason is the closed 084 list rendered as chips, with the free text still a capped complement");
}

// ============================================================
// 5. Three actions, ONE row, at 360px
// ============================================================
{
  // the footer is a SINGLE child of .dw-ft, which is what takes it out of the
  // phone-width wrap rule without touching that rule for any other drawer
  assert.match(panel, /footer=\{\s*<div className="cp-ft">/,
    "everything the footer holds is one child — `.dw-ft` has nothing to wrap here");
  assert.equal((panel.match(/className="cp-ft"/g) ?? []).length, 1,
    "…exactly one such child");
  assert.match(rule(css, "  .cp-ft-acts {"), /flex-wrap:\s*nowrap/,
    "the action row is nowrap by its own declaration — the three buttons cannot fall to a second line");

  // …and the general rule it is exempt FROM is still there for everyone else
  const dwAt = responsive.indexOf(".dw-ft,");
  assert.ok(dwAt > -1, "the shared drawer-footer wrap rule was located");
  assert.match(responsive.slice(dwAt, responsive.indexOf("}", dwAt)), /flex-wrap:\s*wrap/,
    "…and every OTHER drawer still wraps at phone widths, exactly as check:responsive requires");

  // what makes the row fit rather than merely refuse to wrap
  const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
  assert.match(phone, /\.cp-ft-acts \.cp-lbl-full \{\s*display: none;/,
    "the long labels give way on a phone");
  assert.match(phone, /\.cp-ft-acts \.cp-lbl-short \{\s*display: inline;/,
    "…to short ones — 'שמור' and 'מחק', not a hidden button");
  assert.match(phone, /\.cp-ft-acts \.btn \{\s*padding: 0 14px;/,
    "…and the padding narrows, in the existing token vocabulary");
  assert.match(phone, /flex-direction: column-reverse/,
    "the SUMMARY moves above the row instead of competing with it for the same line");
  assert.ok(!/\.cp-ft-acts .*\.btn[^{]*\{[^}]*display:\s*none/.test(phone),
    "…and no action is hidden: every button of the row is on screen at 360px");
  assert.ok(!panel.includes("overflow-menu") && !panel.includes("more_horiz"),
    "…nor tucked behind a kebab menu");

  // all three buttons are still in the DOM in edit mode, primary first (§7)
  const acts = panel.slice(panel.indexOf('className="cp-ft-acts"'), panel.indexOf("{summary}"));
  assert.ok(acts.indexOf("btn-primary") < acts.indexOf("btn-secondary"),
    "the primary is FIRST in the DOM — the row is row-reverse, so it hugs the left edge (§7)");
  assert.ok(acts.indexOf("btn-secondary") < acts.indexOf("btn-danger"),
    "…and the destructive action is furthest from it");
  assert.match(acts, /\{edit && \(/, "…and it exists only when there IS a closure to lift");

  ok("the edit footer keeps its three actions on one row at 360px — shortened labels and narrower padding, nothing stacked, nothing hidden");
}

// ============================================================
// 6. The calendar is fed from the board's props — no new endpoint
// ============================================================
{
  assert.match(screen, /occupancy=\{occupancy\}/,
    "the board hands the panel its occupancy");
  const memo = screen.slice(screen.indexOf("const occupancy = useMemo("));
  assert.match(memo.slice(0, 400), /stays: data\.stays/,
    "…out of the rows it ALREADY fetched for the grid");
  assert.match(memo.slice(0, 400), /closures: data\.closures/, "…both kinds of them");
  assert.match(memo.slice(0, 400), /to: addDays\(data\.from, data\.days\)/,
    "…with the exclusive end of that window, so the panel knows where its knowledge stops");
  assert.doesNotMatch(panel, /fetch\(|useEffect\([^)]*\)\s*=>\s*\{[^}]*Occupancy/,
    "the panel adds no fetch of its own");
  assert.equal((panel.match(/Action\(/g) ?? []).length,
    (panel.match(/(listClosableRooms|createClosure|updateClosure|deleteClosure)Action\(/g) ?? []).length,
    "…and calls no server action beyond the four it always called");
  // and it SAYS so when a picked night is outside that window
  assert.match(panel, /מחוץ לחלון היומן הטעון/,
    "…and when the selection runs past the loaded window the panel says so rather than painting it green");
  ok("the calendar's occupancy is the board's own data — no endpoint, no second query, and an honest third state where the data ends");
}

// ============================================================
// 7. RTL, Hebrew, week starts Sunday — read from the one date module
// ============================================================
{
  assert.match(cal, /HEBREW_DAY_LETTERS\.map\(/,
    "the weekday heads come from lib/dates, not from seven typed letters");
  assert.match(cal, /hebrewMonthYear\(firstOfMonth\(view\)\)/,
    "…and the month title from the same module");
  assert.match(cal, /monthCells\(view\.year, view\.month\)/,
    "…and the grid from the shared cell builder the stay picker uses");
  const dr = read("src/lib/date-range.ts");
  assert.match(dr, /Array\.from\(\{ length: dayOfWeek\(first\) \}/,
    "…which pads with the weekday index — 0=Sunday, so the week starts on ראשון");
  assert.match(cal, /name="chevron-right"[\s\S]{0,120}?חודש קודם|aria-label="חודש קודם"[\s\S]{0,160}?chevron-right/,
    "…and in RTL the RIGHT chevron goes BACK a month");
  ok("the calendar is Hebrew and RTL through the one date module — week from ראשון, months named once");
}

console.log(`\ncheck-closure-redesign: all ${n} claim groups hold.`);
