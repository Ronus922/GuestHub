// ============================================================
// check:rates-ui — the /rates board's architecture gate.
//
// It protects the approved Synchronization-table rebuild from regressing back
// into the shapes it was rebuilt OUT of. The assertions are on STRUCTURE, not
// on cosmetic class names: renaming a class does not get you past it, and a
// test that merely name-matched would not have caught the drift this replaces.
//
// Deliberately NOT asserted: `.rg-dcell, .rg-cell { flex: 1 1 0 }`. That was the
// superseded flex architecture (parked on wip/rates-superseded-flex-attempt) —
// header and body columns were two independent flex rows that agreed only by
// sharing a basis. The board is now ONE CSS grid, so header and body are the
// same tracks by construction and cannot drift. Re-adding that assertion would
// re-mandate the bug.
//
//   node scripts/check-rates-ui.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");
const RATES = "src/app/(dashboard)/rates";
const grid = read(`${RATES}/RateGrid.tsx`);
const cells = read(`${RATES}/RateCells.tsx`);
const screen = read(`${RATES}/RateGridScreen.tsx`);
const toolbar = read(`${RATES}/RateToolbar.tsx`);
const css = read("src/app/styles/rate-grid.css");

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// ---- 1. the canonical route is the ONLY board ----
ok(existsSync(`${RATES}/page.tsx`), "the canonical /rates route exists");
const routes = readdirSync("src/app/(dashboard)", { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase());
ok(!routes.some((r) => /^(synchron|rates-v2|rates2|ratesv2)/.test(r)),
  "no duplicate/parallel Rates or Synchronization route exists");

// ---- 2. ONE grid — header and body share the same tracks ----
ok(/\.rg-grid\s*\{[^}]*display:\s*grid/s.test(css),
  "the board is a CSS grid (.rg-grid { display: grid })");
// the track list is declared exactly once, on the grid itself
const tracks = grid.match(/gridTemplateColumns:\s*`([^`]+)`/);
ok(tracks, "the grid declares its track list (gridTemplateColumns) in RateGrid");
ok(/var\(--rg-label\)\s*repeat\(/.test(tracks[1]),
  "tracks are: the label column + one repeat() per day — one declaration for header AND body");
ok((grid.match(/gridTemplateColumns/g) || []).length === 1,
  "the track list is declared ONCE — a second declaration is how header/body drift");
// the superseded flex architecture must not come back
ok(!/\.rg-cell\s*\{[^}]*flex:\s*1\s+1\s+0/s.test(css),
  "the old flex-basis column architecture is NOT restored on .rg-cell");
ok(!/\.rg-cells\s*\{/.test(css) && !/className="rg-cells"/.test(grid),
  "the old per-row `.rg-cells` flex strip is gone (rows are grid items, not nested flex rows)");

// ---- 3. canonical geometry (measured from the approved reference render) ----
ok(/--rg-label:\s*250px/.test(css), "label column is the reference's 250px");
ok(/--rg-col:\s*46px/.test(css), "day-column floor is the reference's 46px");
ok(/minmax\(var\(--rg-col\),\s*1fr\)/.test(tracks[1]),
  "day columns use minmax(floor, 1fr): they grow when there is room and clamp when there is not");
// A sticky item can only travel inside its containing block — the grid BOX. If the
// box is only `width:100%` while the tracks overflow it, the sticky label column
// runs out of box and slides away (then clips) once the board is scrolled past
// cardWidth − 250px. Sizing the box to the full track span is what pins it.
ok(/minWidth:\s*`calc\(var\(--rg-label\)\s*\+\s*\$\{dates\.length\}\s*\*\s*var\(--rg-col\)\)`/.test(grid),
  "the grid box spans the FULL track width (minWidth), so the sticky label column stays pinned at every scroll offset");
// the reference's responsive rule is CSS — no resize listener may creep back in
ok(!/ResizeObserver|addEventListener\(\s*["']resize/.test(grid + screen),
  "no resize JavaScript — CSS reproduces the reference's column rule");
for (const [v, px] of [["--rg-price-h", "46px"], ["--rg-metric-h", "34px"], ["--rg-day-h", "52px"], ["--rg-band-h", "40px"], ["--rg-month-h", "30px"]]) {
  ok(new RegExp(`${v}:\\s*${px}`).test(css), `row geometry ${v} is the reference's ${px}`);
}

// ---- 4. the room row is the disclosure control for EXACTLY six rows ----
const metrics = grid.match(/const METRICS:\s*MetricDef\[\]\s*=\s*\[([\s\S]*?)\n\];/);
ok(metrics, "the restriction rows are declared as one METRICS list");
const metricCount = (metrics[1].match(/\{\s*field:/g) || []).length;
ok(metricCount === 6, `the room discloses exactly six restriction rows (found ${metricCount})`);
ok(/<button[^>]*className="rg-rlabel"[\s\S]*?aria-expanded=\{open\}/.test(grid),
  "the room label is a real <button> carrying aria-expanded (keyboard + screen-reader reachable)");
ok(/\{open\s*&&\s*METRICS\.map/.test(grid),
  "collapsing a room hides exactly its METRICS rows — nothing else");

// ---- 5. Group Update keeps a usable UI path (never URL-only) ----
ok(/onGroupUpdate\b/.test(toolbar) && /btn-primary|btn-secondary/.test(toolbar),
  "the toolbar keeps a Group Update button");
ok(/rg-tlink[\s\S]*?onGroupUpdateForType/.test(grid) || /onGroupUpdateForType/.test(grid),
  "the per-room-type Group Update entry point survives in the band strip");
ok(/can\.bulk/.test(grid) && /can\.bulk/.test(toolbar),
  "both Group Update entry points stay permission-gated on rates.bulk_update");

// ---- 6. every real sale state stays documented in the footer legend ----
const legendItems = (screen.match(/className="rg-leg"/g) || []).length;
ok(legendItems === 7, `all seven legend states are documented (found ${legendItems})`);
for (const state of ["לא זמין פיזית", "חסר מחיר", "שגיאת מיפוי"]) {
  ok(screen.includes(state), `the legend documents the real state "${state}" (absent from the mock's sample data)`);
}
ok(/<div className="rg-legend">\{legend\}<\/div>/.test(grid),
  "the legend is rendered INSIDE the board card (the reference's footer bar)");
ok(/\.rg-legend\s*\{[^}]*border-top/s.test(css),
  "the legend is the card's footer (bordered bar), not a detached row under it");

// ---- 7. the tooltip cannot be clipped ----
ok(/\.rg-tip\s*\{[^}]*position:\s*fixed/s.test(css),
  "the cell tooltip is position:fixed — never clipped by grid/card/sticky overflow");
ok(/vw\s*-\s*264|Math\.max\(12,\s*Math\.min/.test(cells) && /bottom:\s*Math\.max/.test(cells),
  "the tooltip collides with BOTH viewport edges (clamped horizontally, flipped vertically)");

// ---- 8. no design-system escape hatches in the board ----
for (const [file, src] of [["RateGrid", grid], ["RateCells", cells], ["RateGridScreen", screen], ["RateToolbar", toolbar]]) {
  ok(!/from "lucide-react"/.test(src), `${file} uses Material Symbols, not lucide (§10)`);
  ok(!/#[0-9a-fA-F]{6}\b/.test(src), `${file} declares no raw colour — tokens only (§1)`);
}

// ---- 9. rooms keep their canonical numeric order (D74) ----
ok(existsSync("src/lib/rooms/sort.ts"), "the canonical numeric room sort still exists");

// ---- 10. the day header tells the truth ----
// dayOfWeek() is getUTCDay() (0=Sunday) and HEBREW_DAY_LETTERS is Sunday-first, so
// they already align. Any rotation prints the wrong weekday for every column AND
// contradicts the weekend tint beside it, which is keyed off the same dayOfWeek().
ok(/HEBREW_DAY_LETTERS\[dayOfWeek\(d\)\]/.test(grid),
  "the weekday label indexes HEBREW_DAY_LETTERS by dayOfWeek() directly");
ok(!/HEBREW_DAY_LETTERS\[\(\s*dayOfWeek\(d\)\s*\+/.test(grid),
  "no offset is applied to the weekday index — an off-by-one prints the wrong day on every column");
ok(/dow === 5 \|\| dow === 6/.test(grid),
  "the weekend tint is keyed off the same Sunday-first dayOfWeek(), so label and tint agree");

// ---- 11. the /rates date range keeps an RTL base ----
// /calendar's range is numeric-only ("13/07/2026 – …") and correctly forces LTR via
// the shared .cb-rl. The /rates range is Hebrew + numbers, which an LTR base
// paragraph reorders (the day number is torn off its month).
ok(/\.rg-wrap\s+\.cb-rangebox\s+\.cb-rl\s*\{[^}]*direction:\s*rtl/s.test(css),
  "the /rates date range keeps an RTL base direction (scoped, so /calendar keeps the LTR it needs)");

console.log(`check:rates-ui — the /rates board matches the approved architecture ✔ (${n} checks)`);
