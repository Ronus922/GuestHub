// Settings-regression guard (§1/§10). Asserts that (a) the pre-existing Settings
// implementation at the branch base (main @ bc085b9) contained ONLY the VAT card —
// so nothing else could have been "removed" — and (b) the current shell preserves
// VAT and adds the three commercial modules, and the nav still exposes Settings +
// the now-enabled Rooms. Source-level (no DB). Usage: node scripts/check-settings-regression.mjs
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";

const BASE = "bc085b9";
let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };
const read = (p) => readFileSync(p, "utf8");
const gitShow = (ref, p) => { try { return execSync(`git show ${ref}:"${p}"`, { encoding: "utf8" }); } catch { return ""; } };

// ---- (a) what the BASE Settings actually contained ----
const baseFiles = execSync(`git ls-tree -r --name-only ${BASE} -- "src/app/(dashboard)/settings/"`, { encoding: "utf8" })
  .split("\n").filter(Boolean);
assert.deepEqual(
  baseFiles.map((f) => f.split("/").pop()).sort(),
  ["SettingsScreen.tsx", "actions.ts", "page.tsx"],
  "base /settings had exactly 3 files (VAT only)",
);
const baseScreen = gitShow(BASE, "src/app/(dashboard)/settings/SettingsScreen.tsx");
assert.ok(/vat/i.test(baseScreen), "base screen was the VAT card");
for (const gone of ["cancellation", "payment_polic", "booking_sources", "room_types", "currencies", "languages"]) {
  assert.ok(!baseScreen.toLowerCase().includes(gone), `base Settings never had a ${gone} module (nothing to restore)`);
}
ok("base /settings contained ONLY the VAT card — no module was removed by the rewrite");

// ---- (b) current shell preserves VAT + adds the modules ----
const sections = read("src/app/(dashboard)/settings/sections.ts");
for (const key of ['"vat"', '"extra-guest"', '"cancellation"', '"payment"'])
  assert.ok(sections.includes(key), `sections.ts exposes ${key}`);
ok("current settings shell exposes vat + extra-guest + cancellation + payment");

// VAT behaviour preserved: the action + section still present and unchanged in intent
const vatAction = read("src/app/(dashboard)/settings/actions.ts");
assert.ok(vatAction.includes("updateVatRateAction"), "updateVatRateAction preserved");
assert.ok(read("src/app/(dashboard)/settings/VatSection.tsx").includes("updateVatRateAction"), "VatSection uses the same VAT action");
ok("VAT module preserved (updateVatRateAction + VatSection intact)");

// ---- nav: Settings still linked; Rooms now enabled ----
const nav = read("src/components/layout/nav-items.ts");
const settingsRow = nav.split("\n").find((l) => l.includes('href: "/settings"'));
assert.ok(settingsRow && !/hidden:\s*true/.test(settingsRow), "Settings nav item present & visible");
const roomsRow = nav.split("\n").find((l) => l.includes('href: "/rooms"'));
assert.ok(roomsRow && !/hidden:\s*true/.test(roomsRow), "Rooms nav item enabled → /rooms");
assert.ok(nav.includes('href: "/rates"'), "existing רשת תעריפים nav preserved");
assert.ok(nav.includes('href: "/channels"'), "existing ערוצים nav preserved");
ok("nav preserved: Settings visible, Rooms enabled, rates/channels untouched");

console.log(`\n✓ settings-regression checks passed (${n} groups)`);
