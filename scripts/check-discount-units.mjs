#!/usr/bin/env node
// ============================================================
// check:discount-units (D155) — the reservation discount offers FOUR units, in
// one frozen order.
//
// THE RULE. SPEC.md ס-2 decided four discount units, not the mock's three:
// ‏₪ ללילה · ₪ להזמנה · % להזמנה · % ללילה. `amount_total` ("₪ להזמנה") is a
// first-class member — it is the unit the system has always stored (the column
// DEFAULT), it is fully implemented in the type, the engine and migration 058's
// CHECK, and it was dropped from the offered tabs in #180 with no guard to
// notice. This guard is that notice.
//
// ORDER IS PRODUCT. `Segmented` renders `options` in array order and the RTL
// direction turns DOM order into right-to-left order — so the array IS the
// visible order of the tabs. There is no sort and no order config: change the
// array, change the screen. Hence both membership and sequence are frozen.
//
// NO RENDER-TIME INJECTION. #180 kept `amount_total` alive as a conditional
// `[...DISCOUNT_UNITS, LEGACY_AMOUNT_TOTAL]` spread — a unit that exists only
// while a stored reservation happens to carry it. Restoring the unit while
// leaving that spread produces a DUPLICATE tab on exactly those reservations,
// so the pattern itself is banned from the file, not merely the old constant.
//
// FAIL-CLOSED: if DISCOUNT_UNITS cannot be located or parsed, the guard fails —
// a guard that cannot see its subject proves nothing.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN: the validator re-runs against
// mutants of the REAL file (order swapped, member deleted, label altered,
// injection reintroduced). A validator that accepts any mutant is not a guard,
// and this run exits 1 saying so.
//
// Static only: no DB, no network, no build.
// Usage: node scripts/check-discount-units.mjs
// ============================================================
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

const FILE = "src/components/reservations/PricingControls.tsx";
const src = readFileSync(join(ROOT, FILE), "utf8");

// ---- the frozen four (order = DOM order = RTL right-to-left order) ----------
const CANONICAL = [
  { value: "amount_per_night",  label: "₪ ללילה",  fieldLabel: "הנחה ללילה (₪)" },
  { value: "amount_total",      label: "₪ להזמנה", fieldLabel: "הנחה להזמנה (₪)" },
  { value: "percent_total",     label: "% להזמנה", fieldLabel: "אחוז הנחה להזמנה (%)" },
  { value: "percent_per_night", label: "% ללילה",  fieldLabel: "אחוז הנחה ללילה (%)" },
];

// ---- locate + parse DISCOUNT_UNITS (fail-closed) ---------------------------
// Returns { units } or { error }. Parsing is literal-only on purpose: anything
// the regex cannot read (a spread, a computed label, a variable) is a failure,
// not a silent skip.
const parseUnits = (source) => {
  const m = source.match(/export const DISCOUNT_UNITS\s*:[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!m) return { error: "cannot locate `export const DISCOUNT_UNITS: … = [ … ];` — the array must be a literal declared in one place" };
  const body = m[1];
  const entryRe = /\{\s*value:\s*"([a-z_]+)"\s*,\s*label:\s*"([^"]*)"\s*,\s*fieldLabel:\s*"([^"]*)"\s*\}\s*,?/g;
  const units = [...body.matchAll(entryRe)].map((e) => ({ value: e[1], label: e[2], fieldLabel: e[3] }));
  // every non-trivial token of the body must belong to a parsed entry: a
  // leftover `...X` or a computed member would otherwise pass unseen.
  const consumed = body.replace(entryRe, "").replace(/\s|,/g, "");
  if (consumed !== "")
    return { error: `DISCOUNT_UNITS holds something that is not a literal { value, label, fieldLabel } entry: "${consumed.slice(0, 80)}"` };
  return { units };
};

// ---- the validator ---------------------------------------------------------
// Whole FILE → list of violations. Ran on the real file, then per mutant
// (where a clean result is itself the failure).
const validateFile = (source) => {
  const errs = [];

  // ד. no render-time injection of a unit into the list, anywhere in the file.
  if (source.includes("[...DISCOUNT_UNITS,"))
    errs.push("a unit is spread into the offered list at render time (`[...DISCOUNT_UNITS,`) — the four units are the list; an injected fifth (or a re-injected amount_total) duplicates a tab (D155)");

  const { units, error } = parseUnits(source);
  if (error) { errs.push(error); return errs; }

  // א. exactly four.
  if (units.length !== CANONICAL.length)
    errs.push(`DISCOUNT_UNITS must hold exactly ${CANONICAL.length} units, found ${units.length}: [${units.map((u) => u.value).join(", ")}]`);

  // ב. the exact value sequence.
  const gotSeq = units.map((u) => u.value).join(" → ");
  const wantSeq = CANONICAL.map((u) => u.value).join(" → ");
  if (gotSeq !== wantSeq)
    errs.push(`unit order is the RTL tab order and is frozen (D155).\n      expected: ${wantSeq}\n      found:    ${gotSeq}`);

  // ג. the exact labels + field labels, per position.
  for (let i = 0; i < Math.min(units.length, CANONICAL.length); i++) {
    const got = units[i], want = CANONICAL[i];
    if (got.value !== want.value) continue; // order already reported above
    if (got.label !== want.label)
      errs.push(`unit ${want.value}: label must be "${want.label}", found "${got.label}"`);
    if (got.fieldLabel !== want.fieldLabel)
      errs.push(`unit ${want.value}: fieldLabel must be "${want.fieldLabel}", found "${got.fieldLabel}"`);
  }
  // labels must also be present for units the sequence check flagged, so a
  // reordering never hides a simultaneous label edit.
  for (const want of CANONICAL) {
    const got = units.find((u) => u.value === want.value);
    if (!got) { errs.push(`unit "${want.value}" ("${want.label}") is missing from DISCOUNT_UNITS`); continue; }
    if (got.label !== want.label || got.fieldLabel !== want.fieldLabel)
      errs.push(`unit ${want.value}: expected label "${want.label}" / fieldLabel "${want.fieldLabel}", found "${got.label}" / "${got.fieldLabel}"`);
  }
  return errs;
};

// ---- 1. the live file honours the shape ------------------------------------
const liveErrs = validateFile(src);
assert.equal(liveErrs.length, 0,
  `${FILE} violates D155:\n    - ${[...new Set(liveErrs)].join("\n    - ")}`);
ok(`DISCOUNT_UNITS holds exactly ${CANONICAL.length} units in the frozen RTL order: ${CANONICAL.map((u) => u.label).join(" · ")}`);
ok("every unit carries its exact label and fieldLabel; no unit is injected into the list at render time");

// ---- 2. B2 — the guard falls when the shape is neutralized ------------------
// [label, old, new] over the FILE text. Every `old` must exist exactly once
// (a stale battery proves nothing), and every mutant must be REJECTED.
const AMOUNT_TOTAL_LINE = `  { value: "amount_total", label: "₪ להזמנה", fieldLabel: "הנחה להזמנה (₪)" },\n`;
const PER_NIGHT_LINE = `  { value: "amount_per_night", label: "₪ ללילה", fieldLabel: "הנחה ללילה (₪)" },\n`;
const PCT_TOTAL_LINE = `  { value: "percent_total", label: "% להזמנה", fieldLabel: "אחוז הנחה להזמנה (%)" },\n`;
const PCT_NIGHT_LINE = `  { value: "percent_per_night", label: "% ללילה", fieldLabel: "אחוז הנחה ללילה (%)" },\n`;
const FIND_LINE = "  const field = DISCOUNT_UNITS.find((u) => u.value === unit)!;";

const MUTANTS = [
  ["order swap: [1] ⇄ [3] — the tabs render in a different RTL order",
    AMOUNT_TOTAL_LINE + PCT_TOTAL_LINE + PCT_NIGHT_LINE,
    PCT_NIGHT_LINE + PCT_TOTAL_LINE + AMOUNT_TOTAL_LINE],
  ["member deleted: ₪ להזמנה removed from the offered units (the #180 regression)",
    AMOUNT_TOTAL_LINE, ""],
  ["member deleted: ₪ ללילה removed",
    PER_NIGHT_LINE, ""],
  ["fifth unit appended",
    PCT_NIGHT_LINE, PCT_NIGHT_LINE + `  { value: "amount_total", label: "₪ לאורח", fieldLabel: "הנחה לאורח (₪)" },\n`],
  ["label altered: ₪ להזמנה → הנחה כוללת",
    AMOUNT_TOTAL_LINE, `  { value: "amount_total", label: "הנחה כוללת", fieldLabel: "הנחה להזמנה (₪)" },\n`],
  ["fieldLabel altered on % להזמנה",
    PCT_TOTAL_LINE, `  { value: "percent_total", label: "% להזמנה", fieldLabel: "הנחה באחוזים (%)" },\n`],
  ["render-time injection reintroduced (the #180 legacy passthrough)",
    FIND_LINE,
    `  const units = unit === "amount_total" ? [...DISCOUNT_UNITS, LEGACY] : DISCOUNT_UNITS;\n  const field = units.find((u) => u.value === unit)!;`],
  ["array turned into a spread of a hidden base list — unparseable, must fail closed",
    PER_NIGHT_LINE, `  ...BASE_UNITS,\n`],
];

const occurrences = (hay, needle) => hay.split(needle).length - 1;
for (const [label, oldText, newText] of MUTANTS) {
  assert.equal(occurrences(src, oldText), 1,
    `B2 battery is stale: anchor for mutant "${label}" is not unique in ${FILE} — rewrite it`);
  const mutant = src.replace(oldText, newText);
  assert.notEqual(mutant, src,
    `B2 battery is stale: mutant "${label}" no longer changes the file — rewrite it`);
  assert.ok(validateFile(mutant).length > 0,
    `B2: mutant "${label}" PASSED the validator — the guard is not a guard`);
}
ok(`B2: all ${MUTANTS.length} mutants rejected — reorder, deletion, addition, label edit and render-time injection all fall`);

console.log(`\nall ${n} discount-unit checks passed — four units, frozen order, no injection (D155)`);
