import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = mkdtempSync(join(process.cwd(), "node_modules/.cache/check-in-check-out-"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
execSync(
  `pnpm exec tsc src/lib/check-in-check-out.ts src/lib/check-in-check-out-policy.ts src/lib/dates.ts --outDir ${out} ` +
    "--module esnext --target es2022 --moduleResolution bundler --skipLibCheck",
  { stdio: "inherit" },
);
const compiledDomainPath = join(out, "check-in-check-out.js");
writeFileSync(
  compiledDomainPath,
  readFileSync(compiledDomainPath, "utf8")
    .replace('"./dates"', '"./dates.js"')
    .replaceAll('"./check-in-check-out-policy"', '"./check-in-check-out-policy.js"'),
);
const domain = await import(compiledDomainPath);

let checks = 0;
const ok = (name) => {
  process.stdout.write(`  ✓ ${name}\n`);
  checks += 1;
};

const defaults = domain.parseCheckInCheckOutSettings(undefined);
assert.deepEqual(defaults, domain.DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS);
ok("absent settings resolve to the single canonical default without persistence");

const saved = {
  timezone: "Asia/Jerusalem",
  regular: { weekdays: [0, 2, 5], check_in_from: "16:30", check_out_until: "10:15" },
  special: {
    saturday: true,
    holiday_eve: false,
    holiday: true,
    check_in_from: "13:45",
    check_out_until: "12:30",
  },
};
assert.deepEqual(domain.parseCheckInCheckOutSettings(saved), saved);
assert.deepEqual(domain.validateCheckInCheckOutSettings(saved), { success: true, data: saved });
ok("saved snake_case values parse and validate without loss");

for (const invalid of ["24:00", "15:60", "5:00", "15", "15:000", "not-a-time", ""]) {
  assert.equal(domain.isValidHourMinute(invalid), false, `${invalid} must be rejected`);
  assert.equal(
    domain.validateCheckInCheckOutSettings({
      ...saved,
      regular: { ...saved.regular, check_in_from: invalid },
    }).success,
    false,
  );
}
assert.equal(domain.isValidHourMinute("00:00"), true);
assert.equal(domain.isValidHourMinute("23:59"), true);
ok("HH:mm validation accepts only possible zero-padded times");

const incomplete = domain.parseCheckInCheckOutSettings({
  regular: { weekdays: [], check_in_from: "bad" },
  special: { saturday: "yes", check_out_until: "09:30" },
});
assert.deepEqual(incomplete.regular.weekdays, [0, 1, 2, 3, 4, 5]);
assert.equal(incomplete.regular.check_in_from, "15:00");
assert.equal(incomplete.special.saturday, true);
assert.equal(incomplete.special.check_out_until, "09:30");
ok("incomplete legacy data uses safe field-level fallbacks");

assert.equal(domain.classifyIsraelDate("2026-07-13", defaults), "regular");
assert.equal(domain.classifyIsraelDate("2026-07-17", defaults), "regular");
assert.equal(domain.classifyIsraelDate("2026-07-18", defaults), "saturday");
assert.equal(domain.classifyIsraelDate("2026-04-02", defaults), "holiday");
assert.equal(domain.classifyIsraelDate("2026-04-01", defaults), "holiday_eve");
assert.equal(domain.classifyIsraelDate("2026-09-12", defaults), "holiday");
ok("regular, Friday, Saturday, Israel holiday/eve and holiday-over-Saturday precedence resolve");

const excludedMonday = {
  ...defaults,
  regular: { ...defaults.regular, weekdays: [0, 2, 3, 4, 5] },
};
assert.equal(domain.classifyIsraelDate("2026-07-13", excludedMonday), "regular_fallback");
assert.equal(domain.resolveScheduleForDate("2026-07-13", excludedMonday).schedule, "regular");
ok("unconfigured weekday has an explicit safe regular fallback");

const noHolidayEve = {
  ...defaults,
  special: { ...defaults.special, holiday_eve: false },
};
const eve = domain.resolveScheduleForDate("2026-04-01", noHolidayEve);
assert.equal(eve.category, "holiday_eve");
assert.equal(eve.schedule, "regular");
ok("date classification remains canonical when a special category is disabled");

const stay = domain.resolveStaySchedule("2026-07-17", "2026-07-18", defaults);
assert.equal(stay.arrival.check_in_from, "15:00");
assert.equal(stay.departure.check_out_until, "12:00");
assert.equal(stay.departure.category, "saturday");
ok("arrival and departure schedules resolve independently");

const atJerusalem = (iso) => new Date(iso);
assert.equal(
  domain.evaluateSameDayCheckInCutoff("2026-07-13", defaults, atJerusalem("2026-07-13T11:59:00Z")).allowed,
  true,
  "14:59 Israel daylight time",
);
const exact = domain.evaluateSameDayCheckInCutoff(
  "2026-07-13",
  defaults,
  atJerusalem("2026-07-13T12:00:00Z"),
);
assert.equal(exact.allowed, false);
assert.equal(exact.code, "SAME_DAY_CHECKIN_CUTOFF_PASSED");
assert.equal(
  domain.evaluateSameDayCheckInCutoff("2026-07-13", defaults, atJerusalem("2026-07-13T12:01:00Z")).allowed,
  false,
);
assert.equal(
  domain.evaluateSameDayCheckInCutoff("2026-07-14", defaults, atJerusalem("2026-07-13T20:00:00Z")).allowed,
  true,
);
ok("same-day cutoff allows 14:59, rejects 15:00/15:01, and leaves tomorrow unaffected");

const winterExact = domain.evaluateSameDayCheckInCutoff(
  "2026-12-06",
  defaults,
  atJerusalem("2026-12-06T13:00:00Z"),
);
assert.equal(winterExact.local_date, "2026-12-06");
assert.equal(winterExact.allowed, false, "13:00Z is 15:00 in winter Israel time");
const dstSpring = domain.evaluateSameDayCheckInCutoff(
  "2026-03-27",
  defaults,
  atJerusalem("2026-03-27T12:00:00Z"),
);
assert.equal(dstSpring.local_date, "2026-03-27");
assert.equal(dstSpring.allowed, false, "DST transition day is evaluated in Asia/Jerusalem");
ok("cutoff uses Asia/Jerusalem across standard time and DST transition dates");

const action = readFileSync("src/app/(dashboard)/settings/check-in-check-out-actions.ts", "utf8");
const mutation = readFileSync("src/lib/check-in-check-out-mutation.ts", "utf8");
assert.match(action, /saveCheckInCheckOutSettingsCore\(\{ actor, raw, db: sql \}\)/);
assert.match(mutation, /requirePermission\(actor, "settings\.edit"\)/);
assert.match(mutation, /validateCheckInCheckOutSettings\(raw\)/);
assert.match(mutation, /FOR UPDATE/);
assert.match(mutation, /COALESCE\(settings, '\{\}'::jsonb\)/);
assert.match(mutation, /\{check_in_check_out\}/);
assert.match(mutation, /writeAuditRecord/);
assert.match(action, /revalidatePath\("\/settings"\)/);
for (const forbidden of [
  "@/lib/channel", "guesthub.reservations", "guesthub.payments", "guesthub.rate", "guesthub.inventory",
  "enqueue", "outbox",
]) {
  assert.equal(mutation.toLowerCase().includes(forbidden), false, `settings mutation must not touch ${forbidden}`);
}
ok("one action-core mutation is permission-gated, validated, locked, merged, audited and isolated");

const page = readFileSync("src/app/(dashboard)/settings/page.tsx", "utf8");
assert.match(page, /getTenantCheckInCheckOutSettings\(actor\.tenantId\)/);
const settingsReader = readFileSync("src/lib/settings.ts", "utf8");
assert.match(settingsReader, /settings->'check_in_check_out'/);
assert.match(settingsReader, /parseCheckInCheckOutSettings/);
ok("Settings page uses the canonical side-effect-free tenant reader");

const ui = readFileSync("src/app/(dashboard)/settings/CheckInCheckOutSection.tsx", "utf8");
assert.match(ui, /submittingRef/);
assert.match(ui, /useUnsavedGuard/);
assert.match(ui, /aria-live="polite"/);
assert.match(ui, /type="time"/);
assert.match(ui, /disabled=\{saving \|\| !dirty \|\| !validation\.success\}/);
ok("UI has live preview, dirty/invalid/pending guard, duplicate guard and accessible time controls");

const shell = readFileSync("src/components/layout/Shell.tsx", "utf8");
const sidebar = readFileSync("src/components/layout/Sidebar.tsx", "utf8");
const topbar = readFileSync("src/components/layout/TopBar.tsx", "utf8");
const settingsShell = readFileSync("src/app/(dashboard)/settings/SettingsShell.tsx", "utf8");
const checkHoursCss = readFileSync("src/app/styles/check-in-check-out.css", "utf8");
assert.match(sidebar, /fixed inset-y-0 start-0/);
assert.match(sidebar, /md:relative/);
assert.match(sidebar, /aria-hidden=\{isMobile && !mobileOpen\}/);
assert.match(sidebar, /onNavigate\(\);[\s\S]{0,80}openNewReservation/);
assert.match(shell, /event\.key !== "Escape"/);
assert.match(shell, /backdrop-blur-sm md:hidden/);
assert.match(shell, /\[pathname\]/);
assert.match(topbar, /aria-controls="dashboard-sidebar"/);
assert.match(topbar, /aria-expanded=\{expanded\}/);
assert.match(settingsShell, /xl:hidden/);
assert.match(settingsShell, /<select/);
assert.match(settingsShell, /hidden shrink-0 p-3 xl:block/);
assert.match(checkHoursCss, /@container \(min-width: 680px\)/);
ok("responsive shell reclaims mobile width and exposes accessible compact Settings navigation");

for (const path of [
  "src/lib/channel/payloads.ts",
  "src/lib/channel/queue.ts",
  "src/lib/channel/booking-import.ts",
  "src/app/(dashboard)/reservations/actions.ts",
  "src/lib/rates/service.ts",
  "src/lib/inventory.ts",
]) {
  const source = readFileSync(path, "utf8");
  assert.equal(source.includes("check_in_check_out"), false, `${path} must remain independent`);
}
ok("channel, OTA import, manual reservations, rates and inventory remain independent");

process.stdout.write(`\n✓ check-in/check-out checks passed (${checks} groups)\n`);
