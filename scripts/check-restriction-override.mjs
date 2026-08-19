#!/usr/bin/env node
// ============================================================
// check:restriction-override — the 084 override may waive COMMERCIAL rules and
// nothing else.
//
// THE DEFECT CLASS THIS EXISTS FOR. "Let a manager book against a restriction"
// is one sentence, and it has exactly one catastrophic misreading: waiving the
// PHYSICAL block too. The two are not even distinguishable by error code —
// guesthub.pricing reports both a commercial stop-sell and a room_closures
// conflict as ROOM_CLOSED, and the ONLY discriminator is whether the error
// carries a date. A future edit that simplifies that branch away turns "may
// sell against a rate rule" into "may put a second guest in an occupied room",
// and nothing else in the tree would notice.
//
// So this guard runs the REAL functions, not a description of them:
//   · rules.OVERRIDABLE_STAY_RULE_CODES — the one declaration of the boundary
//   · pricing.firstEnforcedError — the enforcement split, called with the flag
//     ON, on the actual overloaded ROOM_CLOSED shapes
//   · auth.requirePermission — the primitive the action gates on
// plus ONE static assertion (the action's wiring), because a permission check
// that exists but is never called is the same defect with better paperwork.
//
// D127 collect-all: every failure is reported, then the guard fails once.
// Static + pure. No DB, no network, no build.
// Usage: node scripts/check-restriction-override.mjs
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

// ---- compile the real modules (tsc → CommonJS), same harness as check:pricing-engine ----
const tmp = mkdtempSync(join(tmpdir(), "gh-restr-"));
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
      join(ROOT, "src/lib/pricing/reservation-pricing.ts"),
      join(ROOT, "src/lib/auth/permission-check.ts"),
    ],
  }),
);
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};

const rules = req(join(out, "lib/rates/rules.js"));
const pricing = req(join(out, "lib/pricing/reservation-pricing.js"));
const auth = req(join(out, "lib/auth/permission-check.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// ============================================================
// 1. the overridable set is exactly the five commercial codes
// ============================================================
{
  const set = new Set(rules.OVERRIDABLE_STAY_RULE_CODES);
  // 10.2 — the two stay-LENGTH codes are IN the override group. They were the
  // only rules the calendar ever enforced, and the whole point of 084 is that
  // enforcing them no longer means an unliftable wall for a manager.
  assert.ok(set.has("MIN_STAY_NOT_MET"), "MIN_STAY_NOT_MET is overridable");
  assert.ok(set.has("MAX_STAY_EXCEEDED"), "MAX_STAY_EXCEEDED is overridable");
  assert.ok(set.has("CLOSED_ON_ARRIVAL"), "CLOSED_ON_ARRIVAL is overridable");
  assert.ok(set.has("CLOSED_ON_DEPARTURE"), "CLOSED_ON_DEPARTURE is overridable");
  assert.ok(set.has("STOP_SELL"), "STOP_SELL is overridable");
  assert.equal(set.size, 5, "the override group is exactly five codes — nothing crept in");
  assert.ok(rules.isOverridableStayCode("MIN_STAY_NOT_MET"), "isOverridableStayCode agrees with the set");
  // the default is NO: an unknown or future code is never overridable
  assert.equal(rules.isOverridableStayCode("ROOM_UNAVAILABLE"), false,
    "a physical/unknown code is NOT overridable — the default is a hard block");
  ok("the override group is the five COMMERCIAL codes, and only those");
}

// ============================================================
// 2. a PHYSICAL closure is not overridable — with the flag fully ON
// ============================================================
{
  const FLAGS_WITH_OVERRIDE = {
    availability: true,
    restrictions: true,
    pricing: true,
    overrideRestrictionCodes: pricing.OVERRIDABLE_RESTRICTION_CODES,
  };
  const e = (code, extra = {}) => ({ code, message: code, roomId: "r1", ...extra });

  // ROOM_CLOSED **without** a date = a room_closures conflict (engine.ts,
  // conflict_kind='closure'). Physical. Must survive the override.
  const physical = pricing.firstEnforcedError([e("ROOM_CLOSED")], FLAGS_WITH_OVERRIDE);
  assert.equal(physical?.code, "ROOM_CLOSED",
    "a PHYSICAL closure (ROOM_CLOSED with NO date) still blocks with the override flag on");

  // ROOM_CLOSED **with** a date = a commercial stop-sell. Waived.
  const commercial = pricing.firstEnforcedError([e("ROOM_CLOSED", { date: "2026-09-01" })], FLAGS_WITH_OVERRIDE);
  assert.equal(commercial, null,
    "a COMMERCIAL stop-sell (ROOM_CLOSED WITH a date) is waived by the override");

  // the rest of the physical/availability group is untouched by the override
  for (const code of ["ROOM_OUT_OF_ORDER", "ROOM_INACTIVE", "ROOM_UNAVAILABLE", "ROOM_NOT_FOUND"]) {
    assert.equal(pricing.firstEnforcedError([e(code)], FLAGS_WITH_OVERRIDE)?.code, code,
      `${code} still blocks with the override flag on`);
  }
  // occupancy is a capacity fact, never a sales rule
  assert.equal(pricing.firstEnforcedError([e("OCCUPANCY_EXCEEDED")], FLAGS_WITH_OVERRIDE)?.code,
    "OCCUPANCY_EXCEEDED", "an occupancy limit still blocks with the override flag on");

  // and the commercial ones ARE waived, so the guard is not passing by inertia
  for (const code of ["MIN_STAY_NOT_MET", "MAX_STAY_EXCEEDED", "CLOSED_ON_ARRIVAL", "CLOSED_ON_DEPARTURE"]) {
    assert.equal(pricing.firstEnforcedError([e(code, { date: "2026-09-01" })], FLAGS_WITH_OVERRIDE), null,
      `${code} is waived by the override`);
  }
  // a restriction NOT in the group stays blocked even under the override
  assert.equal(
    pricing.firstEnforcedError([e("ADVANCE_BOOKING_RULE_FAILED")], FLAGS_WITH_OVERRIDE)?.code,
    "ADVANCE_BOOKING_RULE_FAILED",
    "a restriction outside the override group still blocks");

  // WITHOUT the override set nothing is waived at all — the baseline is intact
  const noOverride = { availability: true, restrictions: true, pricing: true };
  assert.equal(pricing.firstEnforcedError([e("MIN_STAY_NOT_MET")], noOverride)?.code, "MIN_STAY_NOT_MET",
    "with no override set the restriction group blocks exactly as before");
  ok("physical blocks survive the override; only the five commercial codes are waived");
}

// ============================================================
// 3. the flag alone grants nothing — the permission is the gate
// ============================================================
{
  const KEY = "reservations.restriction_override";
  const actor = (roleKey, keys) => ({ roleKey, permissions: new Set(keys) });

  assert.throws(
    () => auth.requirePermission(actor("receptionist", ["reservations.create"]), KEY),
    (err) => err instanceof auth.AuthorizationError,
    "an actor WITHOUT the key is rejected — restrictionOverride=true does not self-authorize",
  );
  assert.equal(auth.hasPermission(actor("receptionist", ["reservations.create"]), KEY), false,
    "hasPermission is false for a role that was not granted the key");
  assert.doesNotThrow(
    () => auth.requirePermission(actor("manager", [KEY]), KEY),
    "the granted role passes",
  );
  assert.throws(() => auth.requirePermission(null, KEY), (err) => err instanceof auth.AuthorizationError,
    "no actor at all is rejected");

  // …and the action actually calls it, gated on the flag, BEFORE it prices.
  const src = readFileSync(join(ROOT, "src/app/(dashboard)/reservations/actions.ts"), "utf8");
  const create = src.slice(src.indexOf("export async function createReservationAction"));
  const gateAt = create.indexOf(`requirePermission(actor, "${KEY}")`);
  const priceAt = create.indexOf("validateAndPriceStays(");
  assert.ok(gateAt > -1, "createReservationAction calls requirePermission for the override key");
  assert.ok(/if \(input\.restrictionOverride\)\s*\n?\s*requirePermission/.test(create),
    "the check is gated on input.restrictionOverride");
  assert.ok(priceAt > -1 && gateAt < priceAt,
    "the permission is checked BEFORE the stays are validated/priced");
  assert.ok(/enforceAvailability: true/.test(create.slice(priceAt - 400, priceAt + 400)),
    "the create path still enforces availability — the override never relaxes it");
  ok("restrictionOverride=true without the permission is rejected, and the action checks it before pricing");
}

// ============================================================
// 4. the two declarations cannot drift
// ============================================================
{
  const projected = new Set(
    rules.OVERRIDABLE_STAY_RULE_CODES.map((c) => (c === "STOP_SELL" ? "ROOM_CLOSED" : c)),
  );
  assert.deepEqual(
    [...pricing.OVERRIDABLE_RESTRICTION_CODES].sort(),
    [...projected].sort(),
    "the engine-code set is exactly the projection of the ONE rules.ts declaration",
  );
  ok("OVERRIDABLE_RESTRICTION_CODES is derived from OVERRIDABLE_STAY_RULE_CODES, not re-typed");
}

console.log(`\ncheck-restriction-override: all ${n} checks passed`);
