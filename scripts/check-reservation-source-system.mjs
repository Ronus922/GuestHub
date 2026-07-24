// ============================================================
// The "מהמערכת" booking source (key = system) — migration 056.
//
// The source dropdown is DB-driven (lookup_items category 'booking_sources');
// there is no hardcoded option list in the codebase. So the ONE thing the code
// still has to guarantee is the invariant the seed depends on:
//
//   'system' must NEVER be treated as an EXTERNAL channel.
//
// If it were, EditReservationPanel would compute `externalReservation = true`
// and the card section would drop to the read-only "external_unavailable"
// state — a reservation the hotel itself created would stop being editable.
// The external signal derived from a source key is exactly ONE expression
// (normalizeVisibleChannel(...) !== null), so this file pins both ends: the
// pure mapping, and the fact that the panel has no second source-derived gate.
//
// Usage: node scripts/check-reservation-source-system.mjs
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const read = (p) => readFileSync(p, "utf8");

const out = mkdtempSync(join(tmpdir(), "src-system-"));
execSync(
  `pnpm exec tsc src/lib/colors.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const { CHANNEL_CONFIG, CHANNEL_ORDER, normalizeVisibleChannel, resolveChannelBadge } =
  require(join(out, "colors.js"));

// ---- 1. 'system' is INTERNAL — never an external/visible channel ----
assert.equal(
  normalizeVisibleChannel("system"),
  null,
  "'system' must not resolve to a visible channel — that is what marks a reservation external",
);
assert.equal(
  resolveChannelBadge("system"),
  "manual",
  "'system' wears the internal 'manual' badge, like phone/walk_in",
);
assert.ok(!Object.keys(CHANNEL_CONFIG).includes("system"), "'system' is not a channel definition");
assert.ok(![...CHANNEL_ORDER].includes("system"), "'system' never appears in the channel legend");
ok("'system' is internal: no visible channel, no legend entry, manual badge");

// ---- 2. the existing mapping is untouched (no collateral damage) ----
assert.equal(normalizeVisibleChannel("booking_com"), "booking");
assert.equal(normalizeVisibleChannel("booking"), "booking");
assert.equal(normalizeVisibleChannel("airbnb"), "airbnb");
assert.equal(normalizeVisibleChannel("expedia"), "expedia");
assert.equal(normalizeVisibleChannel("direct"), "site", "direct still = the hotel's own site");
assert.equal(normalizeVisibleChannel("site"), "site");
assert.equal(normalizeVisibleChannel("website"), "site");
assert.equal(normalizeVisibleChannel("phone"), null);
assert.equal(normalizeVisibleChannel("walk_in"), null);
assert.equal(normalizeVisibleChannel(null), null);
ok("every pre-existing source key maps exactly as before");

// ---- 3. the panel has ONE source-derived external gate, and editability is not it ----
const PANEL = "src/components/reservations/EditReservationPanel.tsx";
const panel = read(PANEL);
assert.match(
  panel,
  /const externalReservation\s*=\s*\n?\s*Boolean\(detail\?\.ota\) \|\| normalizeVisibleChannel\(detailSource\?\.key \?\? null\) !== null;/,
  "the ONLY source-derived external signal is normalizeVisibleChannel(sourceKey) !== null",
);
assert.equal(
  (panel.match(/normalizeVisibleChannel\(/g) ?? []).length,
  1,
  "no second source→external mapping may appear in the panel",
);
assert.ok(
  !/["']system["']/.test(panel),
  "the panel must not special-case the 'system' source key — it is an ordinary internal source",
);
// field editability depends on permission + lifecycle ONLY, never on externalReservation
assert.match(
  panel,
  /const canEditNow = canEdit && detail\?\.status !== "cancelled";/,
  "field editability = permission + not-cancelled; it must not consult externalReservation",
);
ok("system ⇒ externalReservation false; editability gate never reads the external flag");

// ---- 4. migration 056 seeds the row, additively and idempotently ----
const MIG = "db/migrations/056_source_system.sql";
assert.ok(existsSync(MIG), "migration 056 must exist");
const mig = read(MIG);
assert.match(mig, /category='booking_sources'|'booking_sources'/, "seeds the real category");
assert.match(mig, /'system'/, "seeds key 'system'");
assert.match(mig, /'מהמערכת'/, "seeds the Hebrew label מהמערכת");
assert.match(mig, /ON CONFLICT \(tenant_id, category, key\) DO NOTHING/, "idempotent replay");
assert.match(mig, /MAX\(s\.sort_order\) \+ 1/, "lands last in each tenant's list — no renumbering");
assert.ok(!/\bDELETE\b/i.test(mig), "a lookup migration never deletes rows");
assert.ok(!/\bUPDATE\b/i.test(mig), "a lookup migration never updates existing rows");
assert.ok(!/DO UPDATE/i.test(mig), "no upsert — existing rows are left exactly as they are");
const manifest = read("db/migrations/manifest.txt");
assert.match(manifest, /^056_source_system\.sql$/m, "056 is listed in the migration manifest");
ok("056 is additive, idempotent, manifest-listed; no DELETE/UPDATE");

console.log(`\ncheck-reservation-source-system: ${n} groups passed ✔`);
