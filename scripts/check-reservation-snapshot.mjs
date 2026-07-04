// Phase 4A — confirmed-reservation price SNAPSHOT (§6).
// Proves resolveStayPrice (src/lib/rates/rules.ts) — the single price-precedence
// rule shared by the reservation edit & move actions: a confirmed stay whose
// price basis (room + dates) is unchanged keeps its committed price even after
// the rate table changes; manual overrides win; genuinely re-priced stays use
// current rates. Pure logic, no DB. Usage: node scripts/check-reservation-snapshot.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "snap-"));
execSync(
  `pnpm exec tsc src/lib/rates/rules.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const { resolveStayPrice } = require(join(out, "rules.js"));

let n = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); n++; };

// The exact regression: guest agreed 500/night × 3 = 1500. Rates later jumped to
// 900/night (autoTotal 2700). Editing the (unchanged) stay must NOT re-price.
{
  const r = resolveStayPrice({ nights: 3, isManualRate: false, snapshot: { ratePerNight: 500, priceTotal: 1500 }, autoTotal: 2700 });
  assert.equal(r.priceTotal, 1500, "snapshot total preserved");
  assert.equal(r.ratePerNight, 500, "snapshot nightly preserved");
  ok("confirmed price is snapshotted — an unchanged stay ignores a later rate change");
}
// Snapshot without an exact total (date-only move) pins the nightly, re-derives total.
{
  const r = resolveStayPrice({ nights: 4, isManualRate: false, snapshot: { ratePerNight: 500 }, autoTotal: 3600 });
  assert.equal(r.ratePerNight, 500);
  assert.equal(r.priceTotal, 2000, "date-only move keeps nightly, total = nightly × newNights");
  ok("date-only move keeps the committed nightly rate");
}
// Per-night variation is preserved exactly by priceTotal (not flattened to nightly×nights).
{
  const r = resolveStayPrice({ nights: 3, isManualRate: false, snapshot: { ratePerNight: 517, priceTotal: 1550 }, autoTotal: 9999 });
  assert.equal(r.priceTotal, 1550, "exact committed total kept, not 517*3=1551");
  ok("committed total preserves per-night variation exactly");
}
// Manual override always wins, even over a snapshot.
{
  const r = resolveStayPrice({ nights: 2, isManualRate: true, manualRatePerNight: 700, snapshot: { ratePerNight: 500, priceTotal: 1000 }, autoTotal: 1800 });
  assert.equal(r.ratePerNight, 700);
  assert.equal(r.priceTotal, 1400, "manual override honored");
  ok("manual authorized override is preserved");
}
// No snapshot, not manual → auto-price from CURRENT rates.
{
  const r = resolveStayPrice({ nights: 3, isManualRate: false, autoTotal: 2700 });
  assert.equal(r.priceTotal, 2700);
  assert.equal(r.ratePerNight, 900, "auto nightly = total / nights");
  ok("a genuinely re-dated / re-roomed stay is re-priced from current rates");
}

console.log(`\nALL ${n} RESERVATION-SNAPSHOT CHECKS PASSED`);
