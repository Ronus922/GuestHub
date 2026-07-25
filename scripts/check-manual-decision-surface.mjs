#!/usr/bin/env node
// check:manual-decision-surface — a BLOCKED cancellation must be visible in the
// reservation panel, not only as an alert row on the channels screen.
//
// WHY. D93 keeps an inbound OTA cancellation that lands on a checked-in guest:
// the cancellation is recorded, `external_cancellation_confirmed_at` is stamped,
// and the nights are deliberately NOT freed. The reservation panel showed
// nothing at all, because its cancellation card is built only when
// `status === 'cancelled'` — and a blocked reservation is, by definition, not
// cancelled. The single surface was a `channel_sync_errors` row. An operator who
// opened the reservation saw a perfectly ordinary confirmed stay while the
// channel had already told the guest the booking was cancelled. That is
// human-in-the-loop with no loop, and it is the overbooking shape.
//
// WHAT IS ASSERTED. The state is DERIVED, never stored (031's one-domain rule):
//     external_cancellation_confirmed_at IS NOT NULL AND status <> 'cancelled'
// so the assertions drive the REAL predicate and the REAL query
// (src/lib/reservations/manual-decision.ts, compiled here) against a REAL
// database and compare against values read back from that database with
// INDEPENDENT queries — never against constants this file made up.
//
//   BEHAVIOUR (values read back from the DB)
//     1  blocked stay        → a view exists; confirmedAt/status match the row
//     2  nights held         → nightsHeld == SUM(check_out - check_in), read separately
//     3  room really held    → check_room_availability() still reports a
//                              'reservation' conflict for those dates
//     4  rooms listed        → the labels are the labels the rooms table holds
//     5  alert linkage       → openAlerts tracks channel_sync_errors, resolved → 0
//     6  negative: cancelled → the view disappears once the stay IS cancelled
//     7  negative: ordinary  → a confirmed stay with no confirmation → no view
//
//   CONTRACT (structural — a breach of the wiring, NOT of behaviour; every
//   failure message below says so in as many words)
//     8  the panel loads and renders the card
//     9  the derived state never became a stored column / a migration
//
// DATABASE. Staging only. Resolution order: CHECK_DB_URL → STAGING_OWNER_URL →
// STAGING_DATABASE_URL. Production markers are refused outright. The guard seeds
// its OWN synthetic tenant (a fixed UUID nothing else uses) with upserts and
// NEVER deletes a row — staging is shared.
//
// Usage:  node --env-file=.env.staging scripts/check-manual-decision-surface.mjs
//
// NOT REGISTERED IN package.json: that file belongs to the diff of
// fix/beds24-checkin-cancellation-guard (PR #112) and this branch is under an
// explicit no-touch rule for it. Register it as
// "check:manual-decision-surface": "node --env-file=.env.staging scripts/check-manual-decision-surface.mjs"
// once #112 has landed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const ROOT = process.cwd();
const OUT = join(ROOT, "dist", "check-manual-decision");
const SRC = join("src", "lib", "reservations", "manual-decision.ts");
const PANEL = join("src", "components", "reservations", "EditReservationPanel.tsx");
const ACTION = join("src", "app", "(dashboard)", "reservations", "manual-decision-actions.ts");

const DB_URL = process.env.CHECK_DB_URL || process.env.STAGING_OWNER_URL || process.env.STAGING_DATABASE_URL;
if (!DB_URL) {
  console.error(
    "REFUSED: no database. Run with --env-file=.env.staging (STAGING_OWNER_URL /\n" +
      "STAGING_DATABASE_URL) or set CHECK_DB_URL to a disposable database.",
  );
  process.exit(2);
}
for (const marker of ["bios-vps", "guesthub.bios.co.il", "db.bios.co.il", ":6543/", "@localhost:5432/", "@127.0.0.1:5432/"]) {
  if (DB_URL.includes(marker)) {
    console.error(`REFUSED: the database URL contains the production marker "${marker}"`);
    process.exit(1);
  }
}

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

// ---------------------------------------------------------------
// compile the REAL derivation module — no re-implementation lives here
// ---------------------------------------------------------------
if (!existsSync(join(ROOT, SRC))) {
  console.error(
    `FAIL: ${SRC} does not exist on this tree.\n` +
      "      The blocked-cancellation state has no derivation and therefore no surface:\n" +
      "      a reservation the channel cancelled while the guest is checked in shows\n" +
      "      nothing in the reservation panel. This is the defect the guard exists for.",
  );
  process.exit(1);
}
try {
  execFileSync(
    "pnpm",
    ["exec", "tsc", SRC, "--outDir", OUT, "--module", "commonjs", "--moduleResolution",
      "node10", "--target", "es2022", "--strict", "--skipLibCheck", "--esModuleInterop"],
    { cwd: ROOT, stdio: "pipe" },
  );
} catch (e) {
  console.error("FAIL: the derivation module does not compile.");
  console.error(String(e.stdout ?? e.message));
  process.exit(1);
}
const req = createRequire(import.meta.url);
const { loadManualDecisionView, isCancellationBlocked, MANUAL_DECISION_ALERT_CODE } =
  req(join(OUT, "manual-decision.js"));
assert.equal(typeof loadManualDecisionView, "function", "loadManualDecisionView is not exported");
assert.equal(typeof isCancellationBlocked, "function", "isCancellationBlocked is not exported");

const sql = postgres(DB_URL, { prepare: false, max: 2, onnotice: () => {} });

// ---- the guard's own tenant. Fixed UUIDs, upserts only, zero deletes. ----
const T = "b53d0000-0000-4000-8000-000000000001";
const ROOM = "b53d0000-0000-4000-8000-000000000002";
const RES_BLOCKED = "b53d0000-0000-4000-8000-000000000003";
const RES_PLAIN = "b53d0000-0000-4000-8000-000000000004";
const RR_BLOCKED = "b53d0000-0000-4000-8000-000000000005";
const RR_PLAIN = "b53d0000-0000-4000-8000-000000000006";
const ALERT = "b53d0000-0000-4000-8000-000000000007";
const day = (o) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
const IN = day(-1);
const OUT_DATE = day(3); // 4 nights
const CONFIRMED_AT = "2026-07-24 09:15:00+00";

async function seed() {
  await sql`
    INSERT INTO guesthub.tenants (id, name, slug)
    VALUES (${T}, 'בדיקת החלטת מפעיל', 'check-manual-decision')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  await sql`
    INSERT INTO guesthub.rooms (id, tenant_id, room_number, name, status, is_active)
    VALUES (${ROOM}, ${T}, 'B53', 'חדר בדיקה B53', 'available', true)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'available', is_active = true`;

  // the BLOCKED stay: checked in, the channel confirmed a cancellation, the
  // nights were never freed — exactly what applyCancellation leaves behind.
  await sql`
    INSERT INTO guesthub.reservations
      (id, tenant_id, reservation_number, status, check_in, check_out,
       ota_name, ota_reservation_code, external_cancellation_confirmed_at)
    VALUES (${RES_BLOCKED}, ${T}, 'B53-BLOCKED', 'checked_in', ${IN}, ${OUT_DATE},
            'BookingCom', 'B53-OTA-CODE', ${CONFIRMED_AT})
    ON CONFLICT (id) DO UPDATE SET
      status = 'checked_in', check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out,
      ota_name = EXCLUDED.ota_name, ota_reservation_code = EXCLUDED.ota_reservation_code,
      external_cancellation_confirmed_at = EXCLUDED.external_cancellation_confirmed_at`;
  await sql`
    INSERT INTO guesthub.reservation_rooms
      (id, tenant_id, reservation_id, room_id, check_in, check_out, adults)
    VALUES (${RR_BLOCKED}, ${T}, ${RES_BLOCKED}, ${ROOM}, ${IN}, ${OUT_DATE}, 2)
    ON CONFLICT (id) DO UPDATE SET
      check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out, room_id = EXCLUDED.room_id`;

  // the ORDINARY stay: same tenant, no channel confirmation at all
  await sql`
    INSERT INTO guesthub.reservations
      (id, tenant_id, reservation_number, status, check_in, check_out)
    VALUES (${RES_PLAIN}, ${T}, 'B53-PLAIN', 'checked_in', ${day(20)}, ${day(22)})
    ON CONFLICT (id) DO UPDATE SET
      status = 'checked_in', external_cancellation_confirmed_at = NULL`;
  await sql`
    INSERT INTO guesthub.reservation_rooms
      (id, tenant_id, reservation_id, room_id, check_in, check_out, adults)
    VALUES (${RR_PLAIN}, ${T}, ${RES_PLAIN}, ${ROOM}, ${day(20)}, ${day(22)}, 1)
    ON CONFLICT (id) DO UPDATE SET check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out`;

  // the operator alert both D93 gates raise — the surface that already existed
  await sql`
    INSERT INTO guesthub.channel_sync_errors
      (id, tenant_id, error_code, error_message, context, resolved_at)
    VALUES (${ALERT}, ${T}, ${MANUAL_DECISION_ALERT_CODE},
            'הזמנה B53-BLOCKED בוטלה בערוץ אבל האורח בצ׳ק-אין',
            ${sql.json({ reservation_id: RES_BLOCKED })}, NULL)
    ON CONFLICT (id) DO UPDATE SET resolved_at = NULL, context = EXCLUDED.context`;
}

try {
  await seed();
  console.log(`derivation module: ${SRC}`);
  console.log(`alert code       : ${MANUAL_DECISION_ALERT_CODE}\n`);

  // ---------------------------------------------------------------
  // 1 — the blocked stay produces a view whose facts ARE the row's facts
  // ---------------------------------------------------------------
  const view = await loadManualDecisionView(sql, T, RES_BLOCKED);
  assert.ok(
    view,
    "BEHAVIOUR: a reservation the channel cancelled while the guest is checked in " +
      "produced NO manual-decision view — the panel has nothing to show and the " +
      "operator is never told the room is being held.",
  );
  const [row] = await sql`
    SELECT status, ota_name, ota_reservation_code,
           external_cancellation_confirmed_at::text AS confirmed_at
    FROM guesthub.reservations WHERE id = ${RES_BLOCKED} AND tenant_id = ${T}`;
  assert.equal(view.status, row.status, "BEHAVIOUR: the view's status is not the row's status");
  assert.equal(
    view.confirmedAt,
    row.confirmed_at,
    "BEHAVIOUR: the view's confirmation time is not the timestamp stored on the reservation",
  );
  assert.equal(view.otaName, row.ota_name, "BEHAVIOUR: the view's channel name is not the row's");
  assert.equal(view.inventoryReleased, false, "BEHAVIOUR: the view claims the inventory was released");
  ok(`blocked stay surfaces: status=${view.status} confirmedAt=${view.confirmedAt} (both read back from the row)`);

  // ---------------------------------------------------------------
  // 2 — the nights it reports held are the nights the stay rows hold
  // ---------------------------------------------------------------
  const [{ nights }] = await sql`
    SELECT COALESCE(SUM(check_out - check_in), 0)::int AS nights
    FROM guesthub.reservation_rooms
    WHERE reservation_id = ${RES_BLOCKED} AND tenant_id = ${T}`;
  assert.equal(
    view.nightsHeld,
    nights,
    `BEHAVIOUR: the view reports ${view.nightsHeld} held nights, the stay rows hold ${nights}`,
  );
  assert.ok(nights > 0, "BEHAVIOUR: the fixture holds no nights — the assertion would be vacuous");
  ok(`nights held = ${view.nightsHeld}, independently summed from reservation_rooms = ${nights}`);

  // ---------------------------------------------------------------
  // 3 — the room really is still held: the canonical availability function
  //     (migration 004) reports a reservation conflict over those dates
  // ---------------------------------------------------------------
  const conflicts = await sql`
    SELECT conflict_kind, conflict_id
    FROM guesthub.check_room_availability(${T}, ARRAY[${ROOM}]::uuid[], ${IN}, ${OUT_DATE}, ARRAY[]::uuid[])`;
  const held = conflicts.some((c) => c.conflict_kind === "reservation");
  assert.ok(
    held,
    "BEHAVIOUR: check_room_availability reports the room FREE for the blocked dates — " +
      "the nights were released after all, and the card would be lying about the hold",
  );
  ok(`check_room_availability still reports a 'reservation' conflict for ${IN}→${OUT_DATE}`);

  // ---------------------------------------------------------------
  // 4 — the rooms it lists are the rooms the database names
  // ---------------------------------------------------------------
  const dbRooms = await sql`
    SELECT COALESCE(r.name, r.room_number, '—') AS label
    FROM guesthub.reservation_rooms rr
    LEFT JOIN guesthub.rooms r ON r.id = rr.room_id
    WHERE rr.reservation_id = ${RES_BLOCKED} AND rr.tenant_id = ${T}
    ORDER BY 1`;
  assert.deepEqual(
    view.roomsHeld.map((r) => r.roomLabel).sort(),
    dbRooms.map((r) => r.label).sort(),
    "BEHAVIOUR: the rooms the card would name are not the rooms the reservation occupies",
  );
  ok(`rooms held listed verbatim from the rooms table: ${view.roomsHeld.map((r) => r.roomLabel).join(", ")}`);

  // ---------------------------------------------------------------
  // 5 — the alert linkage is live, not decorative
  // ---------------------------------------------------------------
  assert.equal(
    view.openAlerts,
    1,
    "BEHAVIOUR: the open channel_sync_errors alert for this reservation is not counted",
  );
  await sql`UPDATE guesthub.channel_sync_errors SET resolved_at = now() WHERE id = ${ALERT}`;
  const afterResolve = await loadManualDecisionView(sql, T, RES_BLOCKED);
  assert.equal(
    afterResolve.openAlerts,
    0,
    "BEHAVIOUR: a RESOLVED alert is still counted as open — the panel would keep crying wolf",
  );
  await sql`UPDATE guesthub.channel_sync_errors SET resolved_at = NULL WHERE id = ${ALERT}`;
  ok("openAlerts follows channel_sync_errors: 1 while open, 0 once resolved");

  // ---------------------------------------------------------------
  // 6 — negative: once the stay IS cancelled the state is gone
  // ---------------------------------------------------------------
  await sql`
    UPDATE guesthub.reservations SET status = 'cancelled'
    WHERE id = ${RES_BLOCKED} AND tenant_id = ${T}`;
  const cancelledView = await loadManualDecisionView(sql, T, RES_BLOCKED);
  assert.equal(
    cancelledView,
    null,
    "BEHAVIOUR: a genuinely cancelled reservation still reports 'needs a manual decision' — " +
      "the card would sit on every cancelled OTA booking forever",
  );
  await sql`
    UPDATE guesthub.reservations SET status = 'checked_in'
    WHERE id = ${RES_BLOCKED} AND tenant_id = ${T}`;
  ok("negative: status='cancelled' → no view (the decision was made, the state is over)");

  // ---------------------------------------------------------------
  // 7 — negative: an ordinary stay never triggers it
  // ---------------------------------------------------------------
  const plainView = await loadManualDecisionView(sql, T, RES_PLAIN);
  assert.equal(
    plainView,
    null,
    "BEHAVIOUR: an ordinary checked-in stay with NO channel cancellation reports a blocked " +
      "cancellation — a false alarm on every reservation in the property",
  );
  ok("negative: no external_cancellation_confirmed_at → no view");

  // ---------------------------------------------------------------
  // 8 — CONTRACT: the panel actually loads and renders the card.
  //     A wiring assertion, NOT a behaviour assertion: it proves the surface is
  //     mounted, it cannot prove the surface is correct. Assertions 1-7 do that.
  // ---------------------------------------------------------------
  const panel = readFileSync(join(ROOT, PANEL), "utf8");
  assert.ok(
    /getManualDecisionAction\s*\(/.test(panel),
    `CONTRACT BREACH (wiring, not behaviour): ${PANEL} never calls getManualDecisionAction — ` +
      "the derivation is correct and nothing in the UI asks for it.",
  );
  assert.ok(
    /manualDecision\s*&&/.test(panel) && /נדרשת החלטת מפעיל/.test(panel),
    `CONTRACT BREACH (wiring, not behaviour): ${PANEL} does not render a card for the blocked ` +
      "state — the reservation panel is silent again and the alert row is the only surface.",
  );
  assert.ok(
    /manualDecision\.nightsHeld/.test(panel) && /manualDecision\.confirmedAt/.test(panel),
    `CONTRACT BREACH (wiring, not behaviour): ${PANEL} renders the card without the two facts ` +
      "that make it actionable — when the channel confirmed, and how many nights are still held.",
  );
  const action = readFileSync(join(ROOT, ACTION), "utf8");
  assert.ok(
    /loadManualDecisionView\s*\(\s*sql\s*,\s*actor\.tenantId/.test(action),
    `CONTRACT BREACH (wiring, not behaviour): ${ACTION} does not call the derivation ` +
      "tenant-scoped with the actor's tenant.",
  );
  assert.ok(
    /requirePermission\(\s*actor\s*,\s*"reservations\.view"\s*\)/.test(action),
    `CONTRACT BREACH (wiring, not behaviour): ${ACTION} does not gate the read on ` +
      "reservations.view.",
  );
  ok("CONTRACT: the panel loads the derived state and renders the card with its facts");

  // ---------------------------------------------------------------
  // 9 — CONTRACT: the state stayed DERIVED. Structural by nature.
  // ---------------------------------------------------------------
  const migDir = join(ROOT, "db", "migrations");
  const offenders = readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /needs_manual_decision/.test(readFileSync(join(migDir, f), "utf8")));
  assert.deepEqual(
    offenders,
    [],
    `CONTRACT BREACH (design, not behaviour): a migration introduced a stored ` +
      `needs_manual_decision column (${offenders.join(", ")}). The state is derived from ` +
      "external_cancellation_confirmed_at + status — a stored flag is a second source of " +
      "truth that drifts the moment the stay is resolved through another route (031).",
  );
  ok("CONTRACT: no migration stores the state — it stays derived (031's one-domain rule)");

  console.log(`\nOK — ${n} assertions passed (7 behavioural, 2 contract)`);
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  if (e.expected !== undefined || e.actual !== undefined)
    console.error(`  expected: ${JSON.stringify(e.expected)}\n  actual:   ${JSON.stringify(e.actual)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
