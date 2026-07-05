// Runnable check for the PURE commercial-settings logic (no DB, no browser):
//   src/lib/commercial/{extra-guest,cancellation,payment}.ts
// Compiles the three files with tsc, imports them, and asserts the business
// rules the Server Actions and UI depend on. Usage: node scripts/check-commercial.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "commercial-"));
execSync(
  `pnpm exec tsc src/lib/commercial/extra-guest.ts src/lib/commercial/cancellation.ts src/lib/commercial/payment.ts ` +
    `--outDir ${out} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck`,
  { stdio: "inherit" },
);
const eg = await import(join(out, "extra-guest.js"));
const c = await import(join(out, "cancellation.js"));
const p = await import(join(out, "payment.js"));

let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };

// ============================================================
// §A extra-guest
// ============================================================
assert.equal(eg.roundMoney(123.456, "none", 1), 123.46);
assert.equal(eg.roundMoney(123.4, "unit", 1), 123);
assert.equal(eg.roundMoney(123, "increment", 5), 125);
assert.equal(eg.roundMoney(122, "increment", 5), 120);
assert.equal(eg.roundMoney(12.3, "increment", 0.5), 12.5);
ok("roundMoney: none / unit / increment (incl. 0.5 increment)");

assert.equal(eg.adultMinAge(12), 13);
assert.equal(eg.adultMinAge(11), 12);
ok("adultMinAge derived = child_max_age + 1");

const validEg = { ...eg.EXTRA_GUEST_DEFAULTS, extra_adult: 50, child_max_age: 12, infant_max_age: 2 };
assert.deepEqual(eg.validateExtraGuestDefaults(validEg), []);
assert.ok(eg.validateExtraGuestDefaults({ ...validEg, extra_adult: -1 }).length);
assert.ok(eg.validateExtraGuestDefaults({ ...validEg, extra_adult: 1.234 }).length, "more than 2 decimals rejected");
assert.ok(eg.validateExtraGuestDefaults({ ...validEg, child_max_age: 2, infant_max_age: 2 }).length, "child must exceed infant");
assert.ok(eg.validateExtraGuestDefaults({ ...validEg, rounding_mode: "increment", rounding_increment: 0 }).length);
ok("validateExtraGuestDefaults: age order, negatives, decimals, increment guard");

const norm = eg.normalizeExtraGuestDefaults({ extra_adult: 10, junk: 1, child_max_age: "x" });
assert.equal(norm.extra_adult, 10);
assert.equal(norm.child_max_age, 12, "invalid field falls back to default");
assert.equal(norm.charge_frequency, "per_night");
ok("normalizeExtraGuestDefaults fills defaults from partial/garbage input");

// ============================================================
// §B cancellation tiers
// ============================================================
// The §B worked example — contiguous, has no-show, open-ended earliest tier.
const goodPolicy = [
  { trigger_type: "before_checkin", time_unit: "days", time_from: 14, time_to: null, fee_type: "free", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "accommodation" },
  { trigger_type: "before_checkin", time_unit: "days", time_from: 7, time_to: 14, fee_type: "percentage", fee_amount: 0, fee_percent: 20, fee_nights: 0, calc_base: "accommodation" },
  { trigger_type: "before_checkin", time_unit: "days", time_from: 3, time_to: 7, fee_type: "percentage", fee_amount: 0, fee_percent: 50, fee_nights: 0, calc_base: "accommodation" },
  { trigger_type: "before_checkin", time_unit: "days", time_from: 1, time_to: 3, fee_type: "first_night", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "accommodation" },
  { trigger_type: "before_checkin", time_unit: "hours", time_from: 0, time_to: 24, fee_type: "full", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "total_incl_tax" },
  { trigger_type: "no_show", time_unit: null, time_from: null, time_to: null, fee_type: "full", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "total_incl_tax" },
];
{
  const r = c.validateCancellationTiers(goodPolicy);
  assert.deepEqual(r.errors, [], `worked example has no errors: ${r.errors}`);
  assert.ok(!r.warnings.some((w) => w.includes("no-show")), "no-show present → no warning");
}
ok("§B worked example (unlimited tiers, hours+days, first_night/full/free) validates clean");

// overlap is a HARD error (never silently guess a winner)
{
  const overlap = [
    { trigger_type: "before_checkin", time_unit: "days", time_from: 3, time_to: 10, fee_type: "percentage", fee_amount: 0, fee_percent: 20, fee_nights: 0, calc_base: "accommodation" },
    { trigger_type: "before_checkin", time_unit: "days", time_from: 7, time_to: 14, fee_type: "percentage", fee_amount: 0, fee_percent: 50, fee_nights: 0, calc_base: "accommodation" },
  ];
  const r = c.validateCancellationTiers(overlap);
  assert.ok(r.errors.some((e) => e.includes("חופפים")), "overlap → error");
}
ok("overlapping ranges → hard error");

// mixed-unit overlap: 14 days (336h) vs 400 hours overlap
{
  const mixed = [
    { trigger_type: "before_checkin", time_unit: "days", time_from: 0, time_to: 14, fee_type: "free", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "accommodation" },
    { trigger_type: "before_checkin", time_unit: "hours", time_from: 200, time_to: 400, fee_type: "percentage", fee_amount: 0, fee_percent: 50, fee_nights: 0, calc_base: "accommodation" },
  ];
  assert.ok(c.validateCancellationTiers(mixed).errors.some((e) => e.includes("חופפים")), "days vs hours overlap detected");
}
ok("mixed hours/days overlap detected on a single axis");

// inverted range, duplicate, negative, percent>100, nights=0
assert.ok(c.validateCancellationTiers([{ trigger_type: "before_checkin", time_unit: "days", time_from: 10, time_to: 5, fee_type: "free", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "accommodation" }]).errors.some((e) => e.includes("הפוך")));
ok("inverted range (from >= to) → error");
{
  const dup = [
    { trigger_type: "before_checkin", time_unit: "days", time_from: 0, time_to: 5, fee_type: "free", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "accommodation" },
    { trigger_type: "before_checkin", time_unit: "days", time_from: 0, time_to: 5, fee_type: "percentage", fee_amount: 0, fee_percent: 50, fee_nights: 0, calc_base: "accommodation" },
  ];
  assert.ok(c.validateCancellationTiers(dup).errors.some((e) => e.includes("כפול")));
}
ok("duplicate rule (same range) → error");
assert.ok(c.validateCancellationTiers([{ trigger_type: "after_checkin", time_unit: null, time_from: null, time_to: null, fee_type: "fixed", fee_amount: -5, fee_percent: 0, fee_nights: 0, calc_base: "accommodation" }]).errors.some((e) => e.includes("שלילי")));
ok("negative fee amount → error");
assert.ok(c.validateCancellationTiers([{ trigger_type: "after_checkin", time_unit: null, time_from: null, time_to: null, fee_type: "percentage", fee_amount: 0, fee_percent: 150, fee_nights: 0, calc_base: "accommodation" }]).errors.some((e) => e.includes("0 ל־100")));
ok("percent > 100 → error");
assert.ok(c.validateCancellationTiers([{ trigger_type: "after_checkin", time_unit: null, time_from: null, time_to: null, fee_type: "nights", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "accommodation" }]).errors.some((e) => e.includes("לילה אחד")));
ok('fee_type "nights" with 0 nights → error');

// gap + missing no-show are WARNINGS (savable per §B)
{
  const gappy = [
    { trigger_type: "before_checkin", time_unit: "days", time_from: 0, time_to: 2, fee_type: "free", fee_amount: 0, fee_percent: 0, fee_nights: 0, calc_base: "accommodation" },
    { trigger_type: "before_checkin", time_unit: "days", time_from: 5, time_to: 10, fee_type: "percentage", fee_amount: 0, fee_percent: 50, fee_nights: 0, calc_base: "accommodation" },
  ];
  const r = c.validateCancellationTiers(gappy);
  assert.deepEqual(r.errors, [], "gap alone is not an error");
  assert.ok(r.warnings.some((w) => w.includes("פער")), "gap → warning");
  assert.ok(r.warnings.some((w) => w.includes("no-show")), "no no-show → warning");
}
ok("uncovered gap + missing no-show → warnings (not errors)");
assert.ok(c.validateCancellationTiers([]).errors.length, "empty policy → error");
ok("empty tier list → error");

// ============================================================
// §C payment stages
// ============================================================
const METHODS = ["cash", "credit_card", "bank_transfer"];
{
  const good = [
    { trigger_type: "booking", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "percentage", amount_value: 0, amount_percent: 30, methods: ["credit_card"], require_card_guarantee: true, retry_behavior: "manual" },
    { trigger_type: "before_checkin", trigger_offset_unit: "days", trigger_offset_value: 7, amount_type: "remaining_balance", amount_value: 0, amount_percent: 0, methods: ["credit_card", "cash"], require_card_guarantee: false, retry_behavior: "retry_then_notify" },
  ];
  const r = p.validatePaymentStages(good, METHODS);
  assert.deepEqual(r.errors, [], `valid schedule: ${r.errors}`);
}
ok("§C deposit-then-balance schedule validates clean");

assert.ok(p.validatePaymentStages([
  { trigger_type: "booking", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "percentage", amount_value: 0, amount_percent: 60, methods: [], require_card_guarantee: false, retry_behavior: "manual" },
  { trigger_type: "checkin", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "percentage", amount_value: 0, amount_percent: 60, methods: [], require_card_guarantee: false, retry_behavior: "manual" },
], METHODS).errors.some((e) => e.includes("100%")), "percent sum > 100 → error");
ok("percentage stages summing > 100% → error");

assert.ok(p.validatePaymentStages([{ trigger_type: "booking", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "fixed", amount_value: 0, amount_percent: 0, methods: [], require_card_guarantee: false, retry_behavior: "manual" }], METHODS).errors.some((e) => e.includes("קבוע")));
ok("fixed amount of 0 → error");

assert.ok(p.validatePaymentStages([{ trigger_type: "before_checkin", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "full_balance", amount_value: 0, amount_percent: 0, methods: [], require_card_guarantee: false, retry_behavior: "manual" }], METHODS).errors.some((e) => e.includes("לפני הגעה")));
ok("before_checkin stage missing offset → error");

assert.ok(p.validatePaymentStages([{ trigger_type: "booking", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "full_balance", amount_value: 0, amount_percent: 0, methods: ["bitcoin"], require_card_guarantee: false, retry_behavior: "manual" }], METHODS).errors.some((e) => e.includes("לא מוכר")));
ok("unknown payment method (not in canonical set) → error");

{
  const closeThenMore = [
    { trigger_type: "booking", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "full_balance", amount_value: 0, amount_percent: 0, methods: [], require_card_guarantee: false, retry_behavior: "manual" },
    { trigger_type: "checkin", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "fixed", amount_value: 10, amount_percent: 0, methods: [], require_card_guarantee: false, retry_behavior: "manual" },
  ];
  const r = p.validatePaymentStages(closeThenMore, METHODS);
  assert.ok(r.warnings.some((w) => w.includes("לא יישאר")), "stage after full balance → warning");
}
ok("stage after a full-balance collection → warning");

{
  const outOfOrder = [
    { trigger_type: "checkout", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "percentage", amount_value: 0, amount_percent: 50, methods: [], require_card_guarantee: false, retry_behavior: "manual" },
    { trigger_type: "booking", trigger_offset_unit: null, trigger_offset_value: null, amount_type: "percentage", amount_value: 0, amount_percent: 50, methods: [], require_card_guarantee: false, retry_behavior: "manual" },
  ];
  assert.ok(p.validatePaymentStages(outOfOrder, METHODS).warnings.some((w) => w.includes("סדר הזמן")));
}
ok("stages out of chronological order → warning");
assert.ok(p.validatePaymentStages([], METHODS).errors.length, "empty schedule → error");
ok("empty stage list → error");

console.log(`\n✓ commercial pure-logic checks passed (${n} assertions groups)`);
