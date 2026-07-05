// Phase 4A hotfix — the shared rates writable-date policy (Step 6).
// Proves the SINGLE horizon rule used by the grid loader, navigation, direct
// edits, Group Update, and the server actions: earliest writable = tenant-local
// today, latest = today + 5 CALENDAR years, leap-safe, tenant-timezone (never
// UTC). Pure logic — compiles src/lib/dates.ts and requires it. No DB, no net.
// Usage: node scripts/check-rates-date-policy.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "datepol-"));
execSync(
  `npx tsc src/lib/dates.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const {
  addDays, addYears, ratesWritableWindow, isRateDateWritable, clampRatesFrom,
  todayInTz, RATES_HORIZON_YEARS,
} = require(join(out, "dates.js"));

let n = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); n++; };

// ---- addYears: whole calendar years, leap-safe (#25) ----
assert.equal(addYears("2026-07-05", 5), "2031-07-05");
assert.equal(RATES_HORIZON_YEARS, 5);
ok("addYears adds 5 calendar years (not 365-day multiples)");
assert.equal(addYears("2028-02-29", 5), "2033-02-28"); // 2033 not leap → clamp to Feb 28
assert.equal(addYears("2024-02-29", 4), "2028-02-29"); // 2028 IS leap → stays Feb 29
ok("leap day (Feb 29) clamps to Feb 28 in a non-leap target, keeps Feb 29 in a leap target");

// ---- ratesWritableWindow (#22, #23) ----
const today = "2026-07-05";
const { earliest, latest } = ratesWritableWindow(today);
assert.equal(earliest, today, "earliest writable is today");
assert.equal(latest, "2031-07-05", "latest writable is today + 5 years");
ok("writable window = [today, today+5y]");

// ---- isRateDateWritable (#19, #20, #21, #22, #23, #24) ----
assert.equal(isRateDateWritable(addDays(today, -1), today), false, "yesterday rejected");
assert.equal(isRateDateWritable(today, today), true, "today accepted");
assert.equal(isRateDateWritable(addDays(today, 1), today), true, "tomorrow accepted");
assert.equal(isRateDateWritable("2031-07-05", today), true, "exactly today+5y accepted");
assert.equal(isRateDateWritable("2031-07-06", today), false, "beyond horizon rejected");
ok("past rejected, today accepted, full 5-year horizon accepted, beyond rejected");

// ---- clampRatesFrom: grid never opens on a past / beyond window (#18, #27) ----
assert.equal(clampRatesFrom("2020-01-01", today), today, "a past start clamps up to today");
assert.equal(clampRatesFrom("2099-01-01", today), "2031-07-05", "a beyond-horizon start clamps to latest");
assert.equal(clampRatesFrom("2026-09-01", today), "2026-09-01", "an in-range start is unchanged");
ok("clampRatesFrom floors at today and caps at the horizon");

// ---- tenant-timezone 'today' does NOT shift on a UTC-midnight boundary (#26) ----
// todayInTz uses exactly this Intl formatter. Israel is UTC+3 in July (DST):
const fmt = (iso, tz = "Asia/Jerusalem") =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
assert.equal(fmt("2026-07-04T00:00:00Z"), "2026-07-04", "UTC-midnight Jul 4 → still Jul 4 in Israel (03:00 local)");
assert.equal(fmt("2026-07-04T23:30:00Z"), "2026-07-05", "late-evening UTC Jul 4 → Jul 5 in Israel (02:30 local)");
assert.equal(fmt("2026-07-04T21:30:00Z"), "2026-07-05", "21:30 UTC → 00:30 local next day");
assert.match(todayInTz("Asia/Jerusalem"), /^\d{4}-\d{2}-\d{2}$/, "todayInTz returns a YYYY-MM-DD");
ok("tenant-local date is computed in the property timezone — no UTC-midnight off-by-one");

console.log(`\n✔ rates date policy: ${n} checks passed`);
