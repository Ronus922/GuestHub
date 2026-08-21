#!/usr/bin/env node
// ============================================================
// check:room-label-axes — the calendar's ROOM ROW LABEL tells the truth about
// BOTH axes, and the two boards get that truth from ONE function.
//
// THE DEFECT THIS EXISTS FOR. Room 1006 in production is a year-let: every one
// of the 21 visible nights carries stop_sell, every cell drew the "סגור" tag —
// and the label in the sticky room column, computed from `status` and
// `is_active` alone, read a green "פנוי" right beside them. The board
// contradicted itself in two adjacent columns. A label that knows only the
// PHYSICAL axis cannot help doing that; nothing about a rate row can reach it.
//
// So the decision moved into ONE pure function, cell-state.roomLabel(), and
// this guard runs THAT function — not a description of it — over the three
// states of the owner's ruling, in their precedence order:
//
//   1. physically disabled (out_of_order / inactive / a dated closure in the
//      window) — unchanged, and it WINS over the commercial reading
//   2. physically fine and every visible date stop-sold — "סגור למכירה",
//      never green
//   3. anything else, a PARTIAL closure included — "פנוי", exactly as before
//
// …over the ROOM'S window: the whole set of dates the loader fetched, not the
// 3/5/7-day slice the mobile board happens to draw. A label describes a room,
// and a room does not change state when someone changes the zoom.
//
// …plus the static facts that make the runtime result reach the screen: both
// boards call roomLabel(), both feed it that same window, and neither re-types
// its Hebrew as a literal.
//
// The label is VISUAL ONLY. It never decides what may be sold — rules.ts does
// (check:restriction-override) — so nothing here asserts about enforcement.
//
// D127 collect-all: every failure is reported, then the guard fails once.
// Static + pure. No DB, no network, no build.
// Usage: node scripts/check-room-label-axes.mjs
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

// ---- compile the real module (tsc → CommonJS), same harness as check:cell-mark-ladder ----
const tmp = mkdtempSync(join(tmpdir(), "gh-roomlabel-"));
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
    // cell-state pulls in ./types, cell-mark and rules on its own
    include: [join(ROOT, "src/app/(dashboard)/calendar/cell-state.ts")],
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
const { STOP_SELL_TEXT } = req(join(out, "lib/rates/rules.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// A room that is physically fine — the only axis the fixtures below vary is
// the commercial one, so nothing can pass by accident on `status`.
const HEALTHY = { status: "available", is_active: true };
const open = { rate: { closed: false }, closure: false };
const shut = { rate: { closed: true }, closure: false };
const blank = { rate: undefined, closure: false }; // no rate row at all
const win = (cell, days = 21) => Array.from({ length: days }, () => ({ ...cell }));

// ============================================================
// 1. STATE 1 — the physical axis wins, and it is unchanged
// ============================================================
{
  // …even when the commercial axis would otherwise shout: every night below is
  // stop-sold, and the label still reports the room, not the rate.
  assert.deepEqual(
    roomLabel({ ...HEALTHY, status: "out_of_order" }, win(shut)),
    { label: "מושבת", tone: "off" },
    "an out-of-order room reads 'מושבת' even with the whole window stop-sold",
  );
  assert.deepEqual(
    roomLabel({ status: "available", is_active: false }, win(shut)),
    { label: "לא פעיל", tone: "off" },
    "an inactive room reads 'לא פעיל' even with the whole window stop-sold",
  );
  // a DATED closure is the physical axis too: it already draws its own bar
  // across the cells, so it keeps the label it has always had
  assert.deepEqual(
    roomLabel(HEALTHY, win({ rate: { closed: true }, closure: true })),
    { label: "פנוי", tone: "free" },
    "a room closure covering the window keeps the label it always had — the closure bar speaks for itself",
  );
  assert.deepEqual(
    roomLabel(HEALTHY, win({ rate: { closed: true }, closure: true }), true),
    { label: "תפוס", tone: "busy" },
    "…and an occupied one still reads 'תפוס' — state 1 is untouched, not rewritten",
  );
  ok("state 1 (physically disabled) wins outright over the commercial reading, and its wording is unchanged");
}

// ============================================================
// 2. STATE 2 — every visible date stop-sold, and it is not green
// ============================================================
{
  const v = roomLabel(HEALTHY, win(shut));
  assert.equal(v.label, STOP_SELL_TEXT,
    "a healthy room whose every visible night is stop-sold reads the canonical 'סגור למכירה'");
  assert.equal(v.label, "סגור למכירה",
    "…and that canonical string really is 'סגור למכירה'");
  assert.notEqual(v.tone, "free",
    "state 2 is NOT the free tone — a green 'available' beside 21 'סגור' cells is the bug this guard exists for");
  assert.equal(v.tone, "nosale",
    "state 2 wears its own tone, so the stylesheet can colour it without touching the other three");
  // the function judges whatever array it is handed, at any length; WHICH array
  // that is — the room's window, never the visible slice — is the caller's job,
  // and it is asserted twice below (runtime in §4, statically in §5)
  assert.equal(roomLabel(HEALTHY, win(shut, 3)).label, STOP_SELL_TEXT,
    "a fully stop-sold window reads the same label at any length — the function judges the cells it is given");
  ok("state 2: a fully stop-sold window reads 'סגור למכירה' in a non-green tone");
}

// ============================================================
// 3. STATE 3 — one sellable night is enough, and UNKNOWN is not CLOSED
// ============================================================
{
  // ONE open night among twenty stop-sold ones: the room IS on the market
  const nearlyShut = win(shut);
  nearlyShut[7] = { ...open };
  assert.deepEqual(roomLabel(HEALTHY, nearlyShut), { label: "פנוי", tone: "free" },
    "one sellable night in the window is enough — the room stays 'פנוי'");
  assert.deepEqual(roomLabel(HEALTHY, nearlyShut, true), { label: "תפוס", tone: "busy" },
    "…and an occupied room with one sellable night still reads 'תפוס'");

  // A date with no rate row was never spoken about commercially. Reading that
  // silence as "closed" would paint every unpriced room shut.
  assert.deepEqual(roomLabel(HEALTHY, win(blank)), { label: "פנוי", tone: "free" },
    "a window with no rate rows at all is UNKNOWN, not closed — it stays 'פנוי'");
  const mostlyShut = win(shut);
  mostlyShut[3] = { ...blank };
  assert.deepEqual(roomLabel(HEALTHY, mostlyShut), { label: "פנוי", tone: "free" },
    "one date without a rate row breaks 'the whole window is closed' — silence is not a closure");

  // a PARTIAL room closure does not downgrade the room either
  const partlyClosed = win(open);
  partlyClosed[2] = { rate: { closed: false }, closure: true };
  assert.deepEqual(roomLabel(HEALTHY, partlyClosed), { label: "פנוי", tone: "free" },
    "a partial closure keeps 'פנוי' — those nights already carry their own mark");
  ok("state 3: one sellable night keeps 'פנוי', and a date with no rate row is unknown rather than closed");
}

// ============================================================
// 4. THE WINDOW IS THE ROOM'S, NOT THE VIEW'S (the owner's ruling)
// ============================================================
{
  // The mobile board DRAWS 3/5/7 days out of the 21 the loader fetched, and it
  // used to hand roomLabel that slice. The consequence was a label whose meaning
  // changed with a view toggle: the same room, at the same moment, read
  // "סגור למכירה" on mobile and "פנוי" on desktop whenever the closed nights
  // happened to be the ones on screen. A label describes a ROOM; a room does not
  // become unsellable because someone tapped "3 ימים".
  const slice = win(shut, 3);
  const window21 = [...win(shut, 20), { ...open }]; // the sellable night sits OUTSIDE the slice
  assert.deepEqual(roomLabel(HEALTHY, window21), { label: "פנוי", tone: "free" },
    "a sellable night anywhere in the fetched window keeps the room on the market");
  assert.deepEqual(roomLabel(HEALTHY, slice), { label: STOP_SELL_TEXT, tone: "nosale" },
    "…while judging that same room's first three days ALONE says the opposite — which is why the caller must pass the window, not the slice");
  ok("a closed slice inside a window with a sellable night reads 'פנוי' — the slice would have said the reverse");
}

// ============================================================
// 5. BOTH boards read that one function, and neither re-types its Hebrew
// ============================================================
{
  const CAL = "src/app/(dashboard)/calendar";
  for (const [file, sel] of [
    ["CalendarGrid.tsx", /roomLabel\(/],
    ["MobileCalendar.tsx", /roomLabel\(/],
  ]) {
    const src = stripComments(readFileSync(join(ROOT, `${CAL}/${file}`), "utf8"));
    assert.match(src, sel,
      `${file} takes its room label from roomLabel() — not from a second copy of the ladder`);
    // The three labels the function owns must not be typed at the board. The
    // match is the WHOLE literal (or a bare JSX text node), not the word inside
    // a sentence: the override dialog's prose legitimately names a disabled
    // room while explaining what cannot be overridden, and that is not a label.
    for (const word of ["סגור למכירה", "מושבת", "לא פעיל"]) {
      assert.doesNotMatch(src, new RegExp(`"${word}"|>\\s*${word}\\s*<`),
        `${file} does not re-type the label "${word}" — that is how two spellings start`);
    }
  }
  // …and mobile hands it the FETCHED WINDOW, which is the static half of §4:
  // roomLabel is pure, so nothing it does can stop a caller passing the slice.
  const mobileSrc = stripComments(readFileSync(join(ROOT, `${CAL}/MobileCalendar.tsx`), "utf8"));
  assert.match(mobileSrc, /windowDates\s*=\s*useMemo\(\s*\(\)\s*=>\s*Array\.from\(\{\s*length:\s*data\.days\s*\}/,
    "MobileCalendar builds the label's window from data.days — the whole window the loader fetched");
  assert.match(mobileSrc, /roomLabel\(\s*room,\s*windowDates\.map\(/,
    "…and that is what reaches roomLabel, not the 3/5/7-day slice the board draws");
  assert.match(mobileSrc, /\bdates\.map\(/,
    "…while the strip itself still renders from the slice — only the label's input widened");
  assert.equal((mobileSrc.match(/windowDates/g) ?? []).length, 2,
    "windowDates is declared once and read once, by the label — it is not a second rendering window");

  // the label's Hebrew comes from the SAME place the restriction messages do
  const cellState = stripComments(readFileSync(join(ROOT, `${CAL}/cell-state.ts`), "utf8"));
  assert.match(cellState, /STOP_SELL_TEXT.*from "@\/lib\/rates\/rules"/,
    "cell-state imports the stop-sell wording from rules.ts — the one place restriction wording lives");
  assert.doesNotMatch(cellState, /"סגור למכירה"/,
    "…and does not re-type it locally");
  ok("both boards call roomLabel() and neither re-types the wording it owns");
}

// ============================================================
// 6. The tone the function returns is a tone the stylesheet can actually draw
// ============================================================
{
  const tones = new Set([
    roomLabel({ ...HEALTHY, status: "out_of_order" }, win(open)).tone,
    roomLabel(HEALTHY, win(shut)).tone,
    roomLabel(HEALTHY, win(open)).tone,
    roomLabel(HEALTHY, win(open), true).tone,
  ]);
  const desktop = readFileSync(join(ROOT, "src/app/styles/calendar.css"), "utf8");
  const mobile = readFileSync(join(ROOT, "src/app/styles/calendar-mobile.css"), "utf8");
  for (const tone of tones)
    assert.ok(desktop.includes(`.cb-rst.${tone}`),
      `.cb-rst.${tone} exists in calendar.css — a tone with no rule renders as unstyled ink`);
  assert.ok(mobile.includes(".cb-m-rlabel.nosale"),
    ".cb-m-rlabel.nosale exists in calendar-mobile.css — mobile carries the state as tone, so the rule IS the signal");
  ok("every tone roomLabel() can return has a stylesheet rule on the board that renders it");
}

console.log(`\ncheck-room-label-axes: all ${n} checks passed`);
