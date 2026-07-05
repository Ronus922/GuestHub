// Runnable check for the PURE room commercial domain (no DB):
//   src/lib/commercial/room-pricing.ts  (resolver, chargeable-guest calc, validation)
// Usage: node scripts/check-room-pricing.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "roompricing-"));
execSync(
  `pnpm exec tsc src/lib/commercial/room-pricing.ts --outDir ${out} ` +
    `--module esnext --target es2022 --moduleResolution bundler --skipLibCheck`,
  { stdio: "inherit" },
);
const rp = await import(join(out, "room-pricing.js"));

let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };

const propConfigured = {
  configured: true, extra_adult: 50, extra_child: 30, extra_infant: 0,
  charge_frequency: "per_night", infant_max_age: 2, child_max_age: 12,
  infants_count_occupancy: false, infants_use_included: false,
  tax_mode: "inclusive", rounding_mode: "none", rounding_increment: 1,
};
const propUnconfigured = { ...propConfigured, configured: false, extra_adult: null, extra_child: null, extra_infant: null };
const inherit = { mode: "inherit", extra_adult: null, extra_child: null, extra_infant: null, charge_frequency: null };

// ---- §5 resolver ----
{
  const e = rp.resolveEffectivePricing(inherit, propConfigured);
  assert.equal(e.extra_adult.value, 50);
  assert.equal(e.extra_adult.source, "property_default");
  assert.equal(e.extra_infant.value, 0, "explicit property 0 is a real value");
  assert.equal(e.complete, true);
  assert.deepEqual(e.errors, []);
}
ok("inherit + configured property → effective = property_default, complete");

{
  const e = rp.resolveEffectivePricing(inherit, propUnconfigured);
  assert.equal(e.extra_adult.value, null);
  assert.equal(e.extra_adult.source, "unconfigured");
  assert.equal(e.complete, false);
  assert.ok(e.warnings.some((w) => w.includes("הנכס")), "inherit from unconfigured property → warning");
}
ok("inherit + unconfigured property → unconfigured, warning (never fake zero)");

{
  // per-field precedence: adult overridden, child inherits property, infant overridden
  const e = rp.resolveEffectivePricing(
    { mode: "override", extra_adult: 80, extra_child: null, extra_infant: 10, charge_frequency: "per_stay" },
    propConfigured,
  );
  assert.equal(e.extra_adult.value, 80); assert.equal(e.extra_adult.source, "room_override");
  assert.equal(e.extra_child.value, 30); assert.equal(e.extra_child.source, "property_default");
  assert.equal(e.extra_infant.value, 10); assert.equal(e.extra_infant.source, "room_override");
  assert.equal(e.charge_frequency.value, "per_stay"); assert.equal(e.charge_frequency.source, "room_override");
  assert.equal(e.complete, true);
}
ok("override: per-field precedence (room ↓ property); property values NOT copied into room");

{
  // explicit zero override is preserved
  const e = rp.resolveEffectivePricing(
    { mode: "override", extra_adult: 0, extra_child: 0, extra_infant: 0, charge_frequency: null },
    propConfigured,
  );
  assert.equal(e.extra_adult.value, 0); assert.equal(e.extra_adult.source, "room_override");
  assert.equal(e.complete, true);
}
ok("override: explicit 0 preserved as a real room override");

// ---- §6 chargeable-guest calculation ----
const base = {
  maxAdults: 4, maxChildren: 4, maxInfants: 2, maxOccupancy: 6,
  infantsCountOccupancy: false, infantsUseIncluded: false,
  pricing: { adult: 50, child: 30, infant: 0, frequency: "per_night" },
};
const calc = (o) => rp.calculateChargeableGuests({ ...base, ...o });

{
  const r = calc({ adults: 2, children: 0, infants: 0, includedOccupancy: 2 });
  assert.equal(r.valid, true); assert.equal(r.extraAdults, 0); assert.equal(r.totalExtra, 0);
}
ok("included 2, 2 adults → 0 extra");

{
  const r = calc({ adults: 2, children: 1, infants: 0, includedOccupancy: 2 });
  assert.equal(r.includedAdults, 2); assert.equal(r.extraChildren, 1);
  assert.equal(r.chargeChildren, 30); assert.equal(r.totalExtra, 30);
}
ok("included 2, 2 adults + 1 child → 1 extra child = 30");

{
  const r = calc({ adults: 3, children: 1, infants: 0, includedOccupancy: 2 });
  assert.equal(r.includedAdults, 2); assert.equal(r.extraAdults, 1);
  assert.equal(r.includedChildren, 0); assert.equal(r.extraChildren, 1);
  assert.equal(r.totalExtra, 50 + 30);
}
ok("included 2, 3 adults + 1 child → 1 extra adult + 1 extra child = 80");

{
  const r = calc({ adults: 2, children: 3, infants: 0, includedOccupancy: 4 });
  assert.equal(r.includedAdults, 2); assert.equal(r.includedChildren, 2); assert.equal(r.extraChildren, 1);
  assert.equal(r.totalExtra, 30);
}
ok("included 4, 2 adults + 3 children → adults+2 children included, 1 extra child = 30");

{
  const r = calc({ adults: 1, children: 0, infants: 2, includedOccupancy: 2, infantsUseIncluded: true, pricing: { adult: 50, child: 30, infant: 20, frequency: "per_night" } });
  assert.equal(r.includedAdults, 1); assert.equal(r.includedInfants, 1); assert.equal(r.extraInfants, 1);
  assert.equal(r.chargeInfants, 20); assert.equal(r.totalExtra, 20);
}
ok("infants consume included places → 1 included, 1 extra infant");

{
  const r = calc({ adults: 2, children: 0, infants: 2, includedOccupancy: 2, infantsUseIncluded: false, pricing: { adult: 50, child: 30, infant: 20, frequency: "per_night" } });
  assert.equal(r.includedInfants, 0); assert.equal(r.extraInfants, 2); assert.equal(r.chargeInfants, 40);
}
ok("infants do NOT consume included places → all infants extra");

{
  const r = calc({ adults: 2, children: 0, infants: 2, includedOccupancy: 2, infantsUseIncluded: false, pricing: { adult: 50, child: 30, infant: 0, frequency: "per_night" } });
  assert.equal(r.extraInfants, 2); assert.equal(r.chargeInfants, 0, "explicit 0 infant fee → no charge");
}
ok("explicit infant 0 fee → extra infants but 0 charge");

{
  const perStay = calc({ adults: 3, children: 0, infants: 0, includedOccupancy: 2, pricing: { adult: 50, child: 30, infant: 0, frequency: "per_stay" } });
  assert.equal(perStay.frequency, "per_stay"); assert.equal(perStay.totalExtra, 50);
}
ok("charge frequency passes through (per_stay)");

// capacity rejections
assert.equal(calc({ adults: 0, children: 1, infants: 0, includedOccupancy: 2 }).valid, false, "no adult");
assert.ok(calc({ adults: 5, children: 0, infants: 0, includedOccupancy: 2 }).errors.some((e) => e.includes("מבוגרים")), "adults > max");
assert.ok(calc({ adults: 4, children: 4, infants: 0, includedOccupancy: 2 }).errors.some((e) => e.includes("חורג מהתפוסה")), "occupancy > max");
assert.ok(calc({ adults: 2, children: 0, infants: 0, includedOccupancy: 9 }).errors.some((e) => e.includes("עולים על התפוסה")), "included > max");
ok("capacity rejections: no adult / adults>max / occupancy>max / included>max");

// ---- §8 validateRoomOccupancy ----
const room = {
  maxOccupancy: 4, maxAdults: 3, maxChildren: 2, maxInfants: 1,
  defaultOccupancy: 2, includedOccupancy: 2, mode: "inherit",
  extra_adult: null, extra_child: null, extra_infant: null,
  published: true, propertyConfigured: true,
};
assert.deepEqual(rp.validateRoomOccupancy(room).errors, [], "valid room passes");
ok("valid published room passes validation");

assert.ok(rp.validateRoomOccupancy({ ...room, maxOccupancy: 6, maxAdults: 2, maxChildren: 2, maxInfants: 0 }).errors.some((e) => e.includes("בלתי אפשרית")), "impossible capacity");
ok("impossible capacity (6 max but limits allow 4) → error");

assert.ok(rp.validateRoomOccupancy({ ...room, includedOccupancy: 9 }).errors.some((e) => e.includes("חורגים")), "included>max");
assert.ok(rp.validateRoomOccupancy({ ...room, defaultOccupancy: 9 }).errors.some((e) => e.includes("ברירת מחדל")), "default>max");
assert.ok(rp.validateRoomOccupancy({ ...room, includedOccupancy: null }).errors.some((e) => e.includes("הכלולים")), "published + included null");
assert.ok(rp.validateRoomOccupancy({ ...room, propertyConfigured: false }).errors.some((e) => e.includes("הנכס")), "inherit + property unconfigured + published");
assert.ok(rp.validateRoomOccupancy({ ...room, mode: "override", extra_adult: -5 }).errors.some((e) => e.includes("שלילית")), "negative override");
{
  const w = rp.validateRoomOccupancy({ ...room, published: false, includedOccupancy: null });
  assert.deepEqual(w.errors, [], "unpublished incomplete room does not error");
  assert.ok(w.warnings.some((x) => x.includes("השלמה")), "unpublished incomplete → warning");
}
ok("validation: included/default>max, published-incomplete, inherit-missing-property, negative override, unpublished-warning");

console.log(`\n✓ room-pricing pure checks passed (${n} groups)`);
