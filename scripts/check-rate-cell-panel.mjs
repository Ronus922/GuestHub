#!/usr/bin/env node
// ============================================================
// check:rate-cell-panel — the /rates cell drawer ("מצב מכירה ליום", D177)
// edits a DRAFT and saves it in ONE call; the final sale state it shows is
// LIVE; "no limit" is NULL, never 0.
//
// Runtime where it can be: src/lib/rates/cell-draft.ts is compiled ALONE with
// tsc and CALLED, so the stepper floor/ceiling, the changed-fields-only patch,
// the footer categories, the prune rule and the live sellable verdict are
// proven by running them. Static where it cannot (a React drawer needs a
// browser): the drawer wires that module, reports through the system toast,
// has one write helper, and the partial / icons / weekday names / import order
// it depends on exist.
//
// No DB, no network, no build. D127 collect-all: every failure is reported,
// then the guard fails once. Usage: node scripts/check-rate-cell-panel.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

// ---- compile the real pure module (no imports, so one file is the whole program) ----
const out = mkdtempSync(join(tmpdir(), "gh-ratecell-"));
execSync(
  `pnpm exec tsc src/lib/rates/cell-draft.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck --strict`,
  { cwd: ROOT, stdio: "inherit" },
);
const req = createRequire(join(ROOT, "package.json"));
const m = req(join(out, "cell-draft.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const SAVED = {
  stopSell: false, minStayArrival: null, minStayThrough: 1, maxStay: null,
  closedToArrival: false, closedToDeparture: false,
};

// ============================================================
// 1. the stepper: null ("—") ⇄ 1 at the floor, the schema ceiling, 0 unreachable
// ============================================================
{
  assert.equal(m.stepStay(null, 1), 1, "[+] from no limit lands on 1");
  assert.equal(m.stepStay(1, -1), null, "[−] at 1 clears the limit (NULL) — never 0");
  assert.equal(m.stepStay(null, -1), null, "[−] at no limit stays no limit");
  assert.equal(m.stepStay(2, -1), 1, "[−] above the floor steps down by one");
  assert.equal(m.stepStay(2, 1), 3, "[+] above the floor steps up by one");
  assert.equal(m.STAY_MAX, 3650, "the ceiling is the schema's 3650 (lib/validation/rates.ts)");
  assert.equal(m.stepStay(m.STAY_MAX, 1), m.STAY_MAX, "[+] stops at the schema ceiling");
  for (const v of [null, 1, 2, 3, 3650]) {
    for (const d of [-1, 1]) {
      assert.notEqual(m.stepStay(v, d), 0, `stepStay never yields 0 (from ${v}, ${d}) — 0 is a stricter restriction and a Beds24 payload killer`);
    }
  }
  ok("stepper: null ⇄ 1 at the floor, 3650 ceiling, 0 unreachable");
}

// ============================================================
// 2. the patch: only what changed, all of it at once, never the price
// ============================================================
{
  const server = m.draftFromCell(SAVED);
  assert.deepEqual(m.draftPatch(server, { ...server }), {}, "a clean draft is an empty patch");
  assert.deepEqual(m.draftPatch(server, { ...server, stopSell: true }), { stopSell: true }, "one changed field ⇒ exactly that field");
  assert.deepEqual(m.draftPatch(server, { ...server, maxStay: null }), {}, "a toggle-and-back is not a change");
  const multi = m.draftPatch(server, { ...server, stopSell: true, minStayThrough: 3, closedToArrival: true });
  assert.deepEqual(Object.keys(multi).sort(), ["closedToArrival", "minStayThrough", "stopSell"],
    "every changed field rides in the ONE patch — the footer's single write");
  assert.ok(!("price" in m.draftPatch(server, { ...server, stopSell: true, price: 900 })),
    "the patch never carries price — the price field has its own button and its own call");
  assert.deepEqual(m.draftFromCell({ ...SAVED, price: 900, sellable: true }), SAVED,
    "the baseline is the six commercial fields and nothing else");
  ok("patch: only what changed, all of it at once, never the price");
}

// ============================================================
// 3. the footer categories: named, ordered, deduplicated
// ============================================================
{
  assert.deepEqual(m.dirtyCategories({}), [], "nothing changed ⇒ no category");
  assert.deepEqual(m.dirtyCategories({ stopSell: true }), ["sale"], "the switch alone is 'מכירה'");
  assert.deepEqual(m.dirtyCategories({ closedToArrival: true, minStayThrough: 2 }), ["stay", "arrival_departure"],
    "fixed order sale → stay → arrival_departure, whatever order the patch holds");
  assert.deepEqual(m.dirtyCategories({ minStayArrival: 2, maxStay: 5 }), ["stay"], "two stay fields ⇒ one category");
  assert.equal(m.DRAFT_CATEGORY_TEXT.sale, "מכירה");
  assert.equal(m.DRAFT_CATEGORY_TEXT.stay, "מגבלות שהייה");
  assert.equal(m.DRAFT_CATEGORY_TEXT.arrival_departure, "כניסה ועזיבה");
  ok("footer categories: named in Hebrew, ordered, deduplicated");
}

// ============================================================
// 4. the final sale state is LIVE — the requirement the redesign was made for
// ============================================================
{
  assert.equal(m.liveSellable(["SELLABLE"], false), true, "saved sellable + switch open ⇒ sellable");
  assert.equal(m.liveSellable(["SELLABLE"], true), false, "closing the switch flips the chip BEFORE saving");
  assert.equal(m.liveSellable(["COMMERCIAL_STOP_SELL"], false), true,
    "opening a saved stop-sell flips the chip BEFORE saving — the live requirement");
  assert.equal(m.liveSellable(["RESERVED", "COMMERCIAL_STOP_SELL"], false), false,
    "a physically consumed day stays unsellable however the switch is set (spec edge case)");
  assert.equal(m.liveSellable(["RESERVED"], true), false, "…and closing it changes nothing there either");
  assert.equal(m.liveSellable(["MISSING_EFFECTIVE_PRICE"], false), false, "a missing price is not the switch's to fix");
  assert.deepEqual(m.blockingReasons(["RESERVED", "COMMERCIAL_STOP_SELL", "MISSING_EFFECTIVE_PRICE"]), ["RESERVED", "MISSING_EFFECTIVE_PRICE"],
    "the explanation names the first NON-commercial reason; the commercial one is the draft's");
  assert.deepEqual(m.blockingReasons(["SELLABLE"]), [], "'SELLABLE' is a marker, not a reason");
  ok("final sale state is live: the draft replaces the commercial verdict, every other axis stays as saved");
}

// ============================================================
// 5. the prune: edits that landed disappear, edits that did not survive a refresh
// ============================================================
{
  const server = m.draftFromCell(SAVED);
  const edits = { stopSell: true, maxStay: 4 };
  assert.equal(m.pruneEdits(edits, server), edits, "nothing to drop ⇒ the SAME object (a no-op setState, no render loop)");
  assert.deepEqual(m.pruneEdits(edits, { ...server, stopSell: true }), { maxStay: 4 },
    "an edit the server now equals is dropped, the rest survive — an unrelated refresh never wipes a draft");
  assert.deepEqual(m.pruneEdits({ stopSell: true }, { ...server, stopSell: true }), {},
    "…down to empty once everything landed, which is how 'dirty' resets after the user's own save");
  ok("prune: what landed is gone, what did not is kept");
}

// ============================================================
// 6. the channel summary: from the draft, Hebrew words, null as —
// ============================================================
{
  const open = m.outboundSummary({ ...SAVED }, 990);
  const closed = m.outboundSummary({ ...SAVED, stopSell: true, closedToArrival: true, maxStay: 7 }, 990.4);
  assert.doesNotMatch(open + closed, /\b(CTA|CTD|OOO|OOS)\b/,
    "the live summary spells no English abbreviation (check:cell-mark-ladder's rule, same screen)");
  assert.match(open, /פתוח למכירה/); assert.match(closed, /סגור למכירה/);
  assert.match(open, /כניסה פתוחה/); assert.match(closed, /כניסה סגורה/);
  assert.match(open, /מקס —/); assert.match(closed, /מקס 7/);
  assert.match(open, /מ׳ טווח 1/);
  assert.match(open, /₪990/); assert.match(closed, /₪990/);
  ok("channel summary: built from the draft, in Hebrew words, null as —, rate rounded");
}

// ============================================================
// 7. the drawer wires all of it
// ============================================================
{
  const panel = stripComments(read("src/app/(dashboard)/rates/CellDetailPanel.tsx"));
  assert.doesNotMatch(panel, /window\.alert/, "no window.alert — failures go through the system toast");
  assert.match(panel, /from "sonner"/, "the drawer reports through the ONE toast system (§9)");
  assert.match(panel, /from "@\/lib\/rates\/cell-draft"/, "the drawer runs the pure module this guard just ran");
  for (const fn of ["draftFromCell", "draftPatch", "dirtyCategories", "liveSellable", "blockingReasons", "stepStay", "pruneEdits", "outboundSummary"]) {
    assert.match(panel, new RegExp(`\\b${fn}\\(`), `${fn} is called, not just imported`);
  }
  const calls = panel.match(/upsertRateCellAction\(/g) ?? [];
  assert.equal(calls.length, 1, "ONE write helper — the fields save and the price save both go through it");
  assert.match(panel, /useTransition/, "router.refresh() runs inside a transition so 'busy' lasts until the fresh cell lands");
  assert.match(panel, /startTransition\(\(\) => router\.refresh\(\)\)/, "…and that is the refresh it wraps");
  assert.doesNotMatch(panel, /\b(CTA|CTD)\b/, "no English restriction abbreviation on screen (owner ruling 2026-09-06)");
  // ---- owner rulings 2026-09-07 (D177 §§2, 4, 10, 12, 14) ----
  assert.match(panel, /SELL_REASON_SENTENCE\[primary\]/,
    "a blocked day is explained by the drawer's own sentence — SELL_REASON_TEXT repeats the chip's verdict (§2)");
  assert.doesNotMatch(panel, /SELL_REASON_TEXT/, "…and that grid vocabulary is not used here at all");
  assert.match(panel, /price: null/, "the price can be cleared back to the plan's base price (§4)");
  assert.match(panel, /cell\.priceSource === "explicit" &&[\s\S]{0,200}rc-price-reset/,
    "…and that control appears ONLY where a price is actually set on the day");
  assert.match(panel, /priceValid = priceInput !== "" &&/, "…while an empty FIELD stays invalid (§4)");
  assert.match(panel, /confirmDiscard && dirty \?/, "a dirty draft is confirmed before it is discarded (§10)");
  assert.match(panel, /יש שינויים שלא נשמרו — לסגור בכל זאת\?/, "…in the EditReservationPanel wording");
  assert.match(panel, /onClose=\{requestClose\}/, "…on EVERY close route (Esc / X / overlay), not just the button");
  assert.match(panel, /const requestClose = \(\) => \{[\s\S]{0,200}dirty && !confirmDiscard/,
    "…and that is what requestClose decides");
  assert.match(panel, /visualVariant="booking"/, "the drawer uses the fast booking motion, not the 1.2s default (§12)");
  const ladder = /w-full md:w-\[85%\] lg:w-\[60%\]/;
  assert.match(panel, ladder, "the width is the CANONICAL §7 ladder (§14)");
  assert.match(read("src/components/ui/SidePanel.tsx"), ladder,
    "…byte-identical to SidePanel's own default, so the two can never drift apart");
  assert.doesNotMatch(read("src/app/styles/rate-cell-panel.css"), /\.rc-panel\s*\{/,
    "…and .rc-panel declares no width of its own any more (iron rule 9: no orphan CSS)");
  assert.match(panel, /widthClassName="rc-panel /, "the rc- scope hook rides along with the canonical ladder");
  assert.match(panel, /bodyClassName="rc-body"/, "the reference body padding is the rc-body rule");
  assert.match(panel, /icon="event-available"/, "the header glyph is event_available");
  assert.match(panel, /HEBREW_DAY_NAMES\[dayOfWeek\(/, "the subtitle names the weekday");
  assert.match(panel, /footer=\{/, "the drawer has the §7 footer");
  assert.match(panel, /key=\{`\$\{unit\.sellableUnitId\}\|\$\{cell\.date\}`\}/,
    "the drawer remounts — and resets its draft — per (unit, date), never per refresh");
  ok("the drawer wires the draft module, the toast, one write helper, the transition and the footer");
}

// ============================================================
// 8. the partial, the icons, the weekday names, the import order
// ============================================================
{
  const css = read("src/app/styles/rate-cell-panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /@layer/, "the partial is UNLAYERED on purpose — it must beat SidePanel's p-0 utility");
  const heads = [...css.matchAll(/^[ \t]*([^{}\n@][^{}\n]*)\{/gm)].map((x) => x[1].trim());
  assert.ok(heads.length > 20, `the partial declares its rules (${heads.length})`);
  for (const h of heads) assert.match(h, /^\.rc-/, `every selector is rc-scoped: "${h}"`);
  // ---- owner ruling 2026-09-07: never ONE tile alone on a line (320…1440) ----
  assert.doesNotMatch(css, /\.rc-tiles[^{]*\{[^}]*auto-fit/,
    "the tile rows do not use auto-fit — it picks any count that fits, which is how six tiles wrapped 5+1");
  const counts = [...css.matchAll(/\.rc-tiles\.is-(\d)[^{]*\{[^}]*repeat\((\d+),/g)]
    .map(([, tiles, cols]) => [Number(tiles), Number(cols)]);
  assert.ok(counts.length >= 4, `both tile rows declare explicit column counts (${counts.length})`);
  for (const [tiles, cols] of counts) {
    assert.equal(tiles % cols, 0,
      `${tiles} tiles in ${cols} columns leaves ${tiles % cols} alone on the last line — only a DIVISOR of the tile count may be used`);
  }
  assert.match(css, /\.rc-sec \.card-bd\s*\{[^}]*container-type:\s*inline-size/,
    "…and the count is chosen by the CARD's width (a container query) — the drawer is a fraction of the viewport");
  for (const [cls, n] of [["is-6", 6], ["is-3", 3]]) {
    const grid = read("src/app/(dashboard)/rates/CellDetailPanel.tsx")
      .match(new RegExp(`rc-tiles ${cls}"[^]*?</div>`))?.[0] ?? "";
    assert.equal((grid.match(/<Tile /g) ?? []).length, n, `the .${cls} row really holds ${n} tiles`);
  }
  assert.match(css, /\.rc-sec\s*\{[^}]*flex:\s*none/,
    "the section cards are flex:none — .rc-body is a flex column inside the scrolling .dw-bd, and an overflow:hidden card would otherwise SHRINK (min-height:auto → 0) instead of scrolling; measured clipped in production 2026-09-06 (D177 hotfix)");
  const globals = read("src/app/globals.css");
  const at = globals.indexOf('@import "./styles/rate-cell-panel.css";');
  assert.ok(at > 0, "globals.css imports the partial");
  assert.ok(at < globals.indexOf('@import "./styles/responsive.css";'), "…before responsive.css, which must stay last");
  const icon = read("src/components/shared/Icon.tsx");
  for (const [name, lig] of [["event-available", "event_available"], ["flag", "flag"], ["radio-unchecked", "radio_button_unchecked"]]) {
    assert.match(icon, new RegExp(`"?${name}"?:\\s*"${lig}"`), `Icon maps ${name} → ${lig}`);
  }
  assert.match(read("src/lib/dates.ts"), /export const HEBREW_DAY_NAMES = \[/, "the full weekday names exist next to the letters");
  ok("the partial is rc-scoped and unlayered, imported before responsive.css; the ligatures and the weekday names exist");
}

// ============================================================
// 9. the drawer's sentence vocabulary: one per blocking reason, and it never
//    repeats the verdict the chip beside it already carries (§2)
// ============================================================
{
  const types = read("src/app/(dashboard)/rates/types.ts");
  const union = [...read("src/lib/rates/rules.ts")
    .match(/export type SellReason =[\s\S]*?;/)[0]
    .matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
  const blocking = union.filter((c) => c !== "SELLABLE" && c !== "COMMERCIAL_STOP_SELL");
  assert.ok(blocking.length >= 9, `the blocking reasons are enumerated (${blocking.length})`);
  const body = types.match(/export const SELL_REASON_SENTENCE[\s\S]*?\{([\s\S]*?)\n\};/)[1];
  const sentences = new Map([...body.matchAll(/([A-Z_]+):\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]));
  for (const code of blocking) {
    const t = sentences.get(code);
    assert.ok(t, `${code} has a drawer sentence`);
    if (!t) continue;
    assert.doesNotMatch(t, /לא ניתן למכירה|לא זמין למכירה/,
      `${code}'s sentence says WHY, not the verdict — the chip already reads "לא זמין למכירה" ("${t}")`);
  }
  assert.equal(sentences.size, blocking.length,
    "…and the map holds exactly those codes — the two the draft owns never reach it");
  assert.match(types, /SELL_REASON_TEXT: Record<SellReason, string>/,
    "the grid's own tooltip vocabulary is untouched (it stands alone, with no chip beside it)");
  ok("every blocking reason has a drawer sentence that explains instead of repeating the chip");
}

console.log(`\nAll ${n} cell-drawer claim groups hold.`);
