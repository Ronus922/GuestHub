#!/usr/bin/env node
// ============================================================
// check:long-term-closure — a ROOM CLOSURE is a physical fact, and every
// surface that meets one says so in the same words, with no way out.
//
// THE DEFECT THIS EXISTS FOR. Rooms 1006 and 1042 are rented on yearly leases:
// a person lives in each flat. They were held out of sale by 165 rows of
// pricing_plan_rates.stop_sell each — a COMMERCIAL rule, which 084 lists in
// OVERRIDABLE_STAY_RULE_CODES, so the desktop board offered a manager
// "המשך בכל זאת" and would have booked a guest into somebody's home. Meanwhile
// the row label read a green "פנוי" and the mobile cell opened a clean booking
// form. Three surfaces, three different wrong answers to one physical fact.
//
// The fix is an instrument change, not a message change: kind='ooo' +
// category='long_term' (migration 085). This guard pins the four claims that
// make that change real rather than decorative:
//
//   1. a window covered end to end by a closure is LABELLED by its category
//   2. the mobile closure cell answers a tap with a toast — never the form
//   3. every sentence comes from the ONE wording module, run for real here
//   4. no closure path anywhere reaches "המשך בכל זאת"
//
// Runtime + static. No DB, no network, no build.
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-long-term-closure.mjs
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

// ---- compile the real modules, same harness as check:room-label-axes ----
const tmp = mkdtempSync(join(tmpdir(), "gh-longterm-"));
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
      join(ROOT, "src/app/(dashboard)/calendar/cell-state.ts"),
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
const { roomLabel } = req(join(out, "app/(dashboard)/calendar/cell-state.js"));
const {
  closureBlockMessage, closureCategoryLabel, closureCategoryIcon,
  CLOSURE_CATEGORY_VALUES,
} = req(join(out, "lib/closures/categories.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CAL = "src/app/(dashboard)/calendar";
const HEALTHY = { status: "available", is_active: true };
const win = (cell, days = 21) => Array.from({ length: days }, () => ({ ...cell }));

// ============================================================
// 1. 'long_term' exists as a value, in BOTH halves of the one taxonomy
// ============================================================
{
  assert.ok(CLOSURE_CATEGORY_VALUES.includes("long_term"),
    "'long_term' is a closure category value");
  assert.equal(closureCategoryLabel("long_term"), "שכירות ארוכה",
    "…and its Hebrew is 'שכירות ארוכה', declared once");
  assert.ok(closureCategoryIcon("long_term"),
    "…and it has an icon, so the closure bar can draw it without falling back");

  // The CHECK constraint is the other half of this list. A value the app can
  // write and the database rejects is an INSERT that fails at 3am.
  const mig = read("db/migrations/085_closure_category_long_term.sql");
  for (const v of CLOSURE_CATEGORY_VALUES) {
    assert.ok(mig.includes(`'${v}'`),
      `migration 085's CHECK lists '${v}' — the constraint and CLOSURE_CATEGORY_VALUES are one list in two files`);
  }
  assert.ok(read("db/migrations/manifest.txt").includes("085_closure_category_long_term.sql"),
    "085 is in the manifest — the runner ABORTS on an unlisted migration, so an absent line means it never applies");

  // …and nothing re-types the Hebrew. The selector, the bar and the label all
  // read the module; a literal anywhere is how a taxonomy forks.
  for (const rel of [`${CAL}/ClosurePanel.tsx`, `${CAL}/CalendarGrid.tsx`, `${CAL}/MobileCalendar.tsx`]) {
    assert.doesNotMatch(stripComments(read(rel)), /"שכירות ארוכה"/,
      `${rel} does not type the category label — it comes from lib/closures/categories`);
  }
  // the panel's selector enumerates the list rather than hardcoding options,
  // which is WHY a new value needs no UI change
  assert.match(stripComments(read(`${CAL}/ClosurePanel.tsx`)), /CLOSURE_CATEGORIES\.map\(/,
    "the closure panel builds its selector from CLOSURE_CATEGORIES — a sixth value appears without touching the panel");
  ok("'long_term' is one value in one taxonomy: module, CHECK constraint, manifest, and no re-typed Hebrew");
}

// ============================================================
// 2. A window closed end to end is LABELLED by the closure
// ============================================================
{
  const closedWith = (category) => ({ rate: { closed: false }, closure: true, closureCategory: category });

  assert.deepEqual(roomLabel(HEALTHY, win(closedWith("long_term"))),
    { label: "שכירות ארוכה", tone: "off" },
    "a window covered end to end by a long-term closure reads 'שכירות ארוכה' in the disabled tone");
  assert.deepEqual(roomLabel(HEALTHY, win(closedWith("maintenance"))),
    { label: "תחזוקה", tone: "off" },
    "…and the label is the CATEGORY's, whichever category it is — not a sentence hardcoded for one of them");
  assert.deepEqual(roomLabel(HEALTHY, win(closedWith(null))),
    { label: "סגירת חדר", tone: "off" },
    "a closure filed before the taxonomy existed still reads the generic noun — never a blank or a raw value");
  assert.deepEqual(roomLabel(HEALTHY, win(closedWith("no_such_category"))),
    { label: "סגירת חדר", tone: "off" },
    "…and an unknown stored value falls back the same way, rather than leaking a machine string onto the board");

  // categories that DISAGREE across the window are not one state
  const mixed = [...win(closedWith("long_term"), 10), ...win(closedWith("maintenance"), 11)];
  assert.deepEqual(roomLabel(HEALTHY, mixed), { label: "סגירת חדר", tone: "off" },
    "two different closures butting together read the generic noun — picking the first would be a coin toss rendered as fact");

  // PRECEDENCE, both directions — this is the claim, not a detail:
  assert.deepEqual(
    roomLabel({ ...HEALTHY, status: "out_of_order" }, win(closedWith("long_term"))),
    { label: "מושבת", tone: "off" },
    "the room-level physical reading still outranks the closure — a broken room is broken whoever rents it");
  assert.deepEqual(
    roomLabel(HEALTHY, win({ rate: { closed: true }, closure: true, closureCategory: "long_term" })),
    { label: "שכירות ארוכה", tone: "off" },
    "…and the closure outranks stop_sell: the physical fact wins over the commercial one, never the reverse");

  // a PARTIAL closure is untouched — the old behaviour, still true
  const partly = win({ rate: { closed: false }, closure: false });
  partly[4] = closedWith("long_term");
  assert.deepEqual(roomLabel(HEALTHY, partly), { label: "פנוי", tone: "free" },
    "a PARTIAL closure keeps 'פנוי' — the bar it draws speaks for its own nights and the room is still on the market");
  ok("a fully-closed window is labelled by its category, outranks stop_sell, bows to the room-level physical axis, and a partial closure is unchanged");
}

// ============================================================
// 3. ONE wording module builds the sentence, and it names the LAST CLOSED NIGHT
// ============================================================
{
  // room_closures is half-open [start, end): the lease whose last night is
  // 31.12 stores end_date = 2027-01-01. "עד 1.1" would name a night the guest
  // could actually have.
  assert.equal(closureBlockMessage("long_term", "2027-01-01"), "שכירות ארוכה עד 31.12",
    "the message names the LAST CLOSED NIGHT, not the stored exclusive boundary");
  assert.equal(closureBlockMessage(null, "2027-01-01"), "סגירת חדר עד 31.12",
    "…and without a category it is the generic noun, same shape, same date");
  assert.equal(closureBlockMessage("maintenance", "2026-09-01"), "תחזוקה עד 31.8",
    "…and it crosses a month boundary correctly rather than slicing the string");

  // the date is Hebrew D.M — the SAME spelling the commercial messages use,
  // because it is literally the same function
  const { dayMonth } = req(join(out, "lib/rates/rules.js"));
  assert.ok(closureBlockMessage("long_term", "2026-09-01").endsWith(dayMonth("2026-08-31")),
    "the closure sentence spells its date with rules.dayMonth — one blocked date, one spelling, both axes");
  assert.doesNotMatch(closureBlockMessage("long_term", "2027-01-01"), /\d{4}-\d{2}-\d{2}/,
    "no ISO date reaches the operator");

  // and no surface re-types the sentence
  for (const rel of [`${CAL}/MobileCalendar.tsx`, `${CAL}/CalendarGrid.tsx`]) {
    const src = stripComments(read(rel));
    assert.match(src, /closureBlockMessage\(/,
      `${rel} builds the closure sentence with closureBlockMessage() — the one place closure wording lives`);
    // …and does not assemble one: a template literal that drops an
    // interpolation straight after "עד " IS the sentence, hand-built.
    assert.doesNotMatch(src, /`[^`]*עד \$\{/,
      `${rel} does not hand-assemble a "… עד <date>" sentence in a template literal`);
  }
  ok("the closure sentence is built once, names the last closed night, and is spelled in the same Hebrew D.M as the commercial messages");
}

// ============================================================
// 4. The mobile closure cell answers a tap about the CLOSURE — never with a
//    booking. It used to answer with the sentence alone; since the closure
//    became a thing an operator edits and lifts on a phone too, a tap OPENS it
//    for whoever may close a room, and still explains itself to whoever may not.
//    What has not moved an inch: a covered cell never opens the BOOKING form.
// ============================================================
{
  const mobile = stripComments(read(`${CAL}/MobileCalendar.tsx`));
  const at = mobile.indexOf("const closed =");
  assert.ok(at > -1, "the mobile empty-cell body was located");
  const cell = at > -1 ? mobile.slice(at, mobile.indexOf("</div>", at)) : "";

  assert.match(cell, /const cover = roomSellable \? coverOn\(room\.id, d\)/,
    "the cell asks ONE dated-closure question, the same coverOn() the row label uses — not a second overlap predicate");
  assert.match(cell, /:\s*cover\s*\?\s*\(\)\s*=>\s*tapClosure\(cover, room\)/,
    "a covered cell taps into the closure itself — through tapClosure, the SAME function the bar's own tap calls");
  // …and THAT function is where the permission and the sentence live, once
  const tap = mobile.slice(mobile.indexOf("const tapClosure = useCallback("));
  assert.match(tap, /if \(canClose\) onClosureTap\(c, room\);/,
    "tapClosure opens the panel for an actor who may close a room");
  assert.match(tap, /else toast\.\w+\(closureBlockMessage\(c\.category, c\.end_date\)\);/,
    "…and without rooms.edit it still carries the canonical closure sentence, rather than answering a deliberate tap with nothing");
  assert.ok(cover_precedes_closed(cell),
    "the closure branch is asked BEFORE the stop-sell branch — physical outranks commercial in the handler exactly as it does in the label");
  assert.equal((cell.match(/onEmptyTap\(/g) ?? []).length, 1,
    "onEmptyTap is reachable from exactly ONE branch — a closed cell must not also open the booking form");
  assert.match(cell, /:\s*\(\)\s*=>\s*onEmptyTap\(room\.id, d\)/,
    "…and that one branch is the open, sellable cell, unchanged");

  // it LOOKS blocked, in the physical language, and drops the commercial sign
  assert.match(cell, /roomSellable && !cover \? "" : "blocked"/,
    "a covered cell wears the physical hatch — the same .blocked class the row-level physical axis uses");
  assert.match(cell, /closed && !cover \? "cx" : ""/,
    "…and the commercial 'סגור' tag is suppressed under it: one cell never wears both axes");
  assert.match(cell, /\{closed && !cover && <span className="cb-m-cx">/,
    "…including the tag's text node, not only its class");

  // The bar OWNS the pixels it is drawn on — see check:closure-bar-hit for the
  // geometry that makes this necessary. It used to be pointer-events:none so the
  // cell beneath answered the whole row; that handed the bar's trailing half —
  // which overhangs the CHECKOUT date's cell, a date the room is free on — to
  // the empty-cell branch, and a finger there opened the booking wizard.
  const mobileCss = read("src/app/styles/calendar-mobile.css");
  assert.doesNotMatch(mobileCss, /\.cb-m-block \{[^}]*pointer-events: none/,
    ".cb-m-block is NOT pointer-events:none — a bar that does not catch its own pixels hands them to whatever is underneath");
  assert.match(mobileCss, /\.cb-m-block \{[^}]*top: 0;\s*\n\s*bottom: 0;/,
    "…and its hit area is the FULL row height, so nothing above or below the 34px visual can fall through either");
  ok("the mobile closure cell looks physically blocked, drops the commercial tag, and answers a tap about the closure — the panel for whoever may close a room, the sentence for whoever may not, never a booking");
}

function cover_precedes_closed(cell) {
  const c = cell.indexOf(": cover");
  const s = cell.indexOf('stayViolationMessage({ code: "STOP_SELL"');
  return c > -1 && s > -1 && c < s;
}

// ============================================================
// 5. NO closure path anywhere reaches "המשך בכל זאת"
// ============================================================
{
  // THE POINT OF THE WHOLE CHANGE. stop_sell is in OVERRIDABLE_STAY_RULE_CODES,
  // so a manager holding reservations.restriction_override is offered the
  // override dialog for it — correctly, it is a sales rule. A closure is not,
  // and nothing may quietly move it into that set.
  const rules = read("src/lib/rates/rules.ts");
  const list = rules.slice(rules.indexOf("export const OVERRIDABLE_STAY_RULE_CODES"));
  const codes = list.slice(0, list.indexOf("] as const"));
  for (const forbidden of ["CLOSURE", "ROOM_CLOSED", "LONG_TERM", "OOO"]) {
    assert.ok(!codes.includes(forbidden),
      `OVERRIDABLE_STAY_RULE_CODES does not contain ${forbidden} — a physical closure is not a sales rule a key can waive`);
  }

  // the desktop gate: the closure sentence is raised on the ABSOLUTE branch
  // (rangeInvalid), never handed to the override dialog
  const grid = stripComments(read(`${CAL}/CalendarGrid.tsx`));
  const gateAt = grid.indexOf("if (rangeInvalid(room, ci, co))");
  assert.ok(gateAt > -1, "the desktop create gate was located");
  const gate = gateAt > -1 ? grid.slice(gateAt, grid.indexOf("const violation = nightsViolation", gateAt)) : "";
  assert.match(gate, /closureBlockMessage\(/,
    "the desktop gate names the closure inside the ABSOLUTE branch — the one that returns after a toast");
  assert.match(gate, /toast\.error\(/,
    "…as a toast");
  assert.ok(!gate.includes("setBlockedCreate") && !gate.includes("isOverridableStayCode"),
    "…and that branch reaches neither the override dialog nor the overridable-code test");
  assert.match(gate, /"הטווח המסומן אינו זמין"/,
    "…while a non-closure physical blocker keeps the generic sentence it has always had");

  // …and blockingClosure refuses to name a closure when something else blocks too
  const bcAt = grid.indexOf("const blockingClosure = useCallback");
  assert.ok(bcAt > -1, "blockingClosure was located");
  const bc = bcAt > -1 ? grid.slice(bcAt, grid.indexOf("const previewInvalid", bcAt)) : "";
  assert.match(bc, /status !== "available" \|\| !targetRoom\.is_active\) return null/,
    "blockingClosure returns null for a physically unsellable room — 'שכירות ארוכה' must not describe a broken room");
  assert.match(bc, /isBlocking\(other\.status\)[\s\S]*return null/,
    "…and null when a blocking stay overlaps: a range that is also booked is TAKEN, not leased");

  // mobile has no override machinery at all, closure or otherwise. Comments are
  // stripped: the cell's own comment EXPLAINS that there is no "המשך בכל זאת"
  // here, and a guard that cannot tell prose from a button would forbid saying so.
  const mobileCode = stripComments(read(`${CAL}/MobileCalendar.tsx`));
  for (const stump of ["המשך בכל זאת", "isOverridableStayCode", "setBlockedCreate", "<Dialog"]) {
    assert.ok(!mobileCode.includes(stump),
      `MobileCalendar carries no \`${stump}\` — a closed night on a 390px screen is a toast, not a window to dismiss`);
  }
  // the closure panel offers no override either — it CREATES closures
  assert.ok(!read(`${CAL}/ClosurePanel.tsx`).includes("המשך בכל זאת"),
    "the closure panel offers no 'המשך בכל זאת' — nothing about filing a closure is negotiable");
  ok("no closure path reaches an override: not the code list, not the desktop gate, not mobile, not the panel");
}

console.log(`\ncheck-long-term-closure: all ${n} checks passed`);
