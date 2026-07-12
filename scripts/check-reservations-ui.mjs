// ============================================================
// /reservations list — redesign + single visible-number rule.
//
// The page shows exactly ONE reservation number per row (מס׳ הזמנה):
// the OTA code when the channel supplied one, else the internal #number.
// The internal id stays the identity for opening/editing/keys. The real
// feature is Reservations — no Orders route/page/component may appear.
//
// Static source assertions in the house style (see check-status-default.mjs):
// they read the real files and fail the moment someone reintroduces the
// duplicate number, a second column, or an Orders surface.
// Usage: node scripts/check-reservations-ui.mjs
// ============================================================
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const read = (p) => readFileSync(p, "utf8");

const SCREEN = "src/app/(dashboard)/reservations/ReservationsScreen.tsx";
const PAGE = "src/app/(dashboard)/reservations/page.tsx";
const DATA = "src/app/(dashboard)/reservations/data.ts";
const HELPER = "src/lib/reservations/visible-number.ts";

// ---- 1. the production route is /reservations; no Orders surface exists ----
assert.ok(existsSync(PAGE), "the canonical Reservations route must exist");
const page = read(PAGE);
assert.match(page, /ReservationsScreen/, "the route must render ReservationsScreen");

const badNames = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (/^orders$/i.test(e)) badNames.push(p);
      walk(p);
    } else if (/^orders(page|screen)?\.(ts|tsx)$/i.test(e)) badNames.push(p);
  }
})("src");
assert.deepEqual(badNames, [], "no Orders route/page/component may exist");
for (const forbidden of ["OrdersPage", "OrdersScreen", "OrdersTable", "ReservationsV2"]) {
  assert.ok(!read(SCREEN).includes(forbidden) && !page.includes(forbidden),
    `${forbidden} must not exist — the feature is Reservations`);
}
ok("route is /reservations; no Orders route, page or parallel component");

// ---- 2. the fallback rule is real: run it ----
// Strip the (tiny, known) type annotations and execute the actual source, so
// the rule is verified by behavior, not by reading comments.
const helperSrc = read(HELPER);
const fnSrc = helperSrc
  .match(/export function getVisibleReservationNumber[\s\S]*\n\}/)?.[0]
  ?.replace(/\(r: \{[\s\S]*?\}\): string \{/, "(r) {")
  ?.replace(/^export /, "");
assert.ok(fnSrc && !fnSrc.includes("): string"), "could not extract a runnable helper — update this check");
const getVisible = new Function(`${fnSrc}; return getVisibleReservationNumber;`)();
assert.equal(getVisible({ reservation_number: "1071", ota_reservation_code: "6508475478" }),
  "6508475478", "an OTA reservation must show the OTA code only");
assert.equal(getVisible({ reservation_number: "1071", ota_reservation_code: null }),
  "#1071", "a direct reservation must fall back to the internal number");
assert.equal(getVisible({ reservation_number: "1071", ota_reservation_code: "  " }),
  "#1071", "a blank OTA code must fall back to the internal number");
ok("visible-number rule behaves: OTA code first, internal #number fallback");

// ---- 3. the screen consumes ONLY the helper — never a second number ----
const screen = read(SCREEN);
assert.ok(!screen.includes("row.ota_reservation_code"),
  "the screen must not render the OTA code directly — only via the helper");
assert.ok(!screen.includes("row.reservation_number"),
  "the screen must not render the internal number directly — only via the helper");
assert.ok(!/rl-otacode|rv-otacode/.test(screen),
  "the secondary OTA-code line must not return");
const headerCount = screen.split("מס׳ הזמנה").length - 1;
assert.equal(headerCount, 1, "exactly ONE reservation-number column header");
// desktop and mobile render through the SAME row markup — the helper is called
// once for sorting and once in the single number cell.
const calls = screen.split("getVisibleReservationNumber(").length - 1;
assert.equal(calls, 2, "one sort usage + one visible cell — no duplicated fallback logic");
ok("one מס׳ הזמנה column; helper is the only number source (desktop = mobile)");

// ---- 4. the internal identity still drives everything ----
assert.match(screen, /key=\{row\.id\}/, "React keys stay on the internal id");
assert.match(screen, /setPanelId\(row\.id\)/, "row click opens by the internal id");
assert.match(screen, /reservationId=\{panelId\}/, "the SidePanel receives the internal id");
const data = read(DATA);
assert.match(data, /res\.ota_reservation_code/, "the read model must keep the existing OTA field");
assert.ok(!data.includes("visible-number"),
  "the DB layer must not depend on the presentation rule");
ok("internal id remains the identity for keys, opening and editing");

// ---- 5. no schema or import changes rode along ----
assert.ok(!/ALTER TABLE|CREATE TABLE|ADD COLUMN/i.test(data),
  "the read model must not carry schema changes");
const importer = "src/lib/channel/booking-import.ts";
if (existsSync(importer)) {
  assert.ok(!read(importer).includes("visible-number"),
    "Channex ingestion must not know about the presentation rule");
}
ok("no schema change; ingestion untouched by the presentation rule");

// ---- 6. canonical primitives ----
for (const cls of ["card", "chip chip-neutral", "field-input", "empty-state", "ltr-num"]) {
  assert.ok(screen.includes(cls), `the screen must use the canonical .${cls}`);
}
assert.match(screen, /<Icon\b/, "icons come from the ONE <Icon> component");
ok("screen is built from canonical design-system primitives");

console.log(`\ncheck-reservations-ui: ${n} groups passed ✔`);
