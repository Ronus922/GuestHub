#!/usr/bin/env node
// ============================================================
// check:ota-confirm-once — an OTA confirmation fires ONCE per reservation,
// ever, and NEVER for a reservation that existed before the cutover (D119).
//
// THE FAILURE THIS EXISTS TO CATCH. The Beds24 import re-sees every booking
// inside LOOKBACK_DAYS on every pull. Emitting a confirm event on that path,
// without protection, would create FIRST-ever confirm events for reservations
// that were booked weeks ago — real WhatsApps to guests, retroactively. The
// occurrence key alone cannot stop that: it prevents a SECOND event, not a
// first one for a historical row. Migration 068 occupies the key for every
// reservation that existed at cutover; the emission sits inside the import's
// CREATE branch, where a re-import cannot reach it.
//
// B2-STYLE. Two halves, each red if its fix is reverted:
//   · STRUCTURE — static, no DB. The emit is syntactically inside the create
//     branch; the occurrence key is per-reservation-LIFETIME; the unique index
//     backs it; migration 068 exists, is in the manifest, covers EVERY
//     reservation, and asserts its own row count.
//   · BEHAVIOUR — against an isolated test DB (:5433), inside one transaction
//     that always rolls back. Runs the REAL migration-068 body and builds the
//     occurrence key from the REAL template in outbox.ts, then proves:
//       (a) a pre-existing reservation emits NOTHING when the emitter runs
//           against it — the simulated re-pull;
//       (b) a post-cutover reservation emits exactly once, and a second attempt
//           emits nothing;
//       (c) a watermark row is invisible to the worker's claim predicate.
//     Neutralising the backfill (068's INSERT) turns (a) red.
//
// Never touches production: the DB half refuses production markers and rolls
// back. Usage: node scripts/check-ota-confirm-once.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
let n = 0;
const ok = (m) => { n += 1; console.log(`✓ ${n}. ${m}`); };

const MIGRATION = "068_ota_confirm_watermark.sql";
const bookingImport = read("src/lib/channel/booking-import.ts");
const outbox = read("src/lib/communications/outbox.ts");
const watermark = read(`db/migrations/${MIGRATION}`);

// ============================================================
// STRUCTURE
// ============================================================

// ---- 1. the emit sits INSIDE the create branch of applyLiveRevision ----
// Not "somewhere in the file", not "after the if/else": inside the `else` block
// that runs only when lockExternalReservation found no existing reservation.
// Moving it out is the exact regression that would fire on every re-pull.
{
  const fnStart = bookingImport.indexOf("async function applyLiveRevision(");
  assert.ok(fnStart > 0, "applyLiveRevision must remain locatable in booking-import.ts");

  const calls = [...bookingImport.matchAll(/enqueueReservationConfirmed\s*\(/g)];
  assert.equal(calls.length, 1,
    `booking-import.ts must emit reservation.confirmed from exactly ONE place (found ${calls.length})`);
  const callAt = calls[0].index;

  // the if/else that decides UPDATE-existing vs CREATE-new
  const ifAt = bookingImport.indexOf("if (existing) {", fnStart);
  assert.ok(ifAt > fnStart, "the create/update branch `if (existing) {` must remain in applyLiveRevision");
  // walk braces from the `{` of the if, to find where its block ends
  const blockEnd = (from) => {
    let depth = 0;
    for (let i = from; i < bookingImport.length; i += 1) {
      const c = bookingImport[i];
      if (c === "{") depth += 1;
      else if (c === "}") { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  };
  const ifOpen = bookingImport.indexOf("{", ifAt);
  const ifClose = blockEnd(ifOpen);
  assert.ok(ifClose > ifOpen, "the `if (existing)` block must be brace-balanced");
  const elseAt = bookingImport.indexOf("else", ifClose);
  assert.ok(elseAt > ifClose && elseAt - ifClose < 8, "the create branch must be the `else` of `if (existing)`");
  const elseOpen = bookingImport.indexOf("{", elseAt);
  const elseClose = blockEnd(elseOpen);
  assert.ok(elseClose > elseOpen, "the create branch must be brace-balanced");

  assert.ok(callAt > elseOpen && callAt < elseClose,
    "enqueueReservationConfirmed must sit INSIDE the create branch — from the UPDATE branch, or after the if/else, "
    + "a re-import of an existing reservation would reach it and fire retroactively");
  assert.ok(!(callAt > ifOpen && callAt < ifClose),
    "the confirm emit must never sit in the UPDATE branch — status is rewritten to 'confirmed' there on every re-import");
  ok("the confirm emit is syntactically unreachable from a re-import (inside applyLiveRevision's create branch only)");
}

// ---- 2. the occurrence key is per-reservation-LIFETIME ----
// A key carrying a revision id, an attempt counter or a timestamp would make
// every pull a new "occurrence" and defeat the unique index entirely.
const keyTemplate = (() => {
  const m = outbox.match(/const occurrenceKey = `(reservation:\$\{args\.reservationId\}:confirmed:v1)`/);
  assert.ok(m, "enqueueReservationConfirmed must build the key `reservation:${args.reservationId}:confirmed:v1`");
  return m[1];
})();
for (const varying of ["revisionId", "Date", "now(", "attempt", "occurredAt", "status"]) {
  assert.equal(keyTemplate.includes(varying), false,
    `the confirm occurrence key must not vary with "${varying}" — it would stop being once-per-reservation`);
}
assert.match(outbox, /ON CONFLICT \(tenant_id, event_type, aggregate_type, occurrence_key\) DO NOTHING/);
assert.match(read("db/migrations/036_guest_communications.sql"),
  /UNIQUE \(tenant_id, event_type, aggregate_type, occurrence_key\)/,
  "the dedupe is only real while the unique index backs it");
ok("the confirm occurrence key is per-reservation-lifetime and backed by a unique index");

// ---- 3. the cutover watermark migration ----
{
  const manifest = read("db/migrations/manifest.txt").split("\n").map((l) => l.trim());
  assert.ok(manifest.includes(MIGRATION),
    `${MIGRATION} must be listed in manifest.txt — the runner ABORTS on an unlisted migration and the deploy would never apply it`);
  // the watermark must occupy the SAME key the emitter builds
  const sqlKey = keyTemplate.replace("${args.reservationId}", "' || r.id || '");
  assert.ok(watermark.includes(`'${sqlKey}'`),
    `the watermark must occupy the emitter's own key expression ('${sqlKey}') — a different key protects nothing`);
  assert.match(watermark, /'processed'/,
    "watermark rows must be written already-processed, or the worker would claim and SEND them");
  assert.match(watermark, /IF written <> missing_before THEN\s+RAISE EXCEPTION/,
    "the migration must abort unless it covered EVERY reservation lacking the key — a partial watermark looks like protection and is not");
  assert.match(watermark, /IF missing_after <> 0 THEN\s+RAISE EXCEPTION/,
    "the migration must abort if any reservation is left uncovered");
  // no origin filter: the cutover is about TIME, not about which path emits
  assert.equal(/booking_origin\s*(=|IN|<>)/.test(watermark), false,
    "the watermark must cover EVERY reservation — filtering by origin leaves rows a future emitter could fire");
  ok("migration 068 is registered, occupies the emitter's own key, is already-processed, self-asserting, and origin-blind");
}

// ============================================================
// BEHAVIOUR — isolated test DB, one transaction, always rolled back
// ============================================================
const url = process.env.TEST_DATABASE_URL
  || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (url.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

// The emitter's INSERT, faithfully: same columns, same conflict target, same
// key — the key itself derived from outbox.ts above, so a change to the real
// template changes what this simulation writes.
const emit = (tx, tenantId, reservationId, origin) => tx`
  INSERT INTO guesthub.communication_events
    (tenant_id, event_type, aggregate_type, reservation_id, source,
     occurrence_key, payload, occurred_at)
  VALUES (${tenantId}, 'reservation.confirmed', 'reservation', ${reservationId}, ${origin},
          ${keyTemplate.replace("${args.reservationId}", reservationId)}, '{}'::jsonb, now())
  ON CONFLICT (tenant_id, event_type, aggregate_type, occurrence_key) DO NOTHING
  RETURNING id`;

let failure = null;
try {
  await sql.begin(async (tx) => {
    const [tenant] = await tx`
      INSERT INTO guesthub.tenants (name, slug)
      VALUES ('ota-confirm-once guard', ${`ota-confirm-once-${process.pid}`}) RETURNING id`;
    const mkReservation = async (number, origin, status) => {
      const [r] = await tx`
        INSERT INTO guesthub.reservations
          (tenant_id, reservation_number, check_in, check_out, status, booking_origin)
        VALUES (${tenant.id}, ${number}, '2026-09-01', '2026-09-03', ${status}, ${origin})
        RETURNING id`;
      return r.id;
    };

    // --- the world at cutover: reservations that already exist, no events ---
    const preConfirmed = await mkReservation("GUARD-PRE-1", "ota", "confirmed");
    const preCancelled = await mkReservation("GUARD-PRE-2", "ota", "cancelled");
    const preLocal = await mkReservation("GUARD-PRE-3", "back_office", "confirmed");
    const before = await tx`
      SELECT count(*)::int AS c FROM guesthub.communication_events WHERE tenant_id = ${tenant.id}`;
    assert.equal(before[0].c, 0, "the guard's fixture must start with no events");

    // --- run the REAL migration body (not a paraphrase of it) ---
    await tx.unsafe(watermark).simple();
    const marks = await tx`
      SELECT reservation_id, status, occurrence_key
      FROM guesthub.communication_events
      WHERE tenant_id = ${tenant.id} AND event_type = 'reservation.confirmed'
      ORDER BY occurrence_key`;
    assert.equal(marks.length, 3,
      `the watermark must cover every pre-existing reservation (covered ${marks.length} of 3)`);
    for (const row of marks) {
      assert.equal(row.status, "processed", "a watermark row must be already-processed");
      assert.equal(row.occurrence_key, keyTemplate.replace("${args.reservationId}", row.reservation_id));
    }
    ok("migration 068 watermarks every pre-existing reservation, already-processed, on the emitter's own key");

    // idempotent: a second application writes nothing and still passes its own
    // assertions (they would RAISE and abort this transaction otherwise)
    await tx.unsafe(watermark).simple();
    const afterSecond = await tx`
      SELECT count(*)::int AS c FROM guesthub.communication_events WHERE tenant_id = ${tenant.id}`;
    assert.equal(afterSecond[0].c, 3, "re-running the watermark must write nothing");
    ok("migration 068 is idempotent — a second application writes zero rows");

    // --- (a) THE SIMULATED RE-PULL: the emitter runs against pre-existing rows
    let emitted = 0;
    for (const id of [preConfirmed, preCancelled, preLocal]) {
      const rows = await emit(tx, tenant.id, id, "ota");
      emitted += rows.length;
    }
    assert.equal(emitted, 0,
      `a re-pull emitted ${emitted} confirm event(s) for pre-existing reservations — the cutover watermark is not protecting them`);
    const live = await tx`
      SELECT count(*)::int AS c FROM guesthub.communication_events
      WHERE tenant_id = ${tenant.id} AND status <> 'processed'`;
    assert.equal(live[0].c, 0, "no pre-existing reservation may end up with a sendable confirm event");
    ok("a simulated full re-pull emits ZERO events for reservations that existed at cutover");

    // --- (c) a watermark row is invisible to the worker's claim predicate ----
    const claimable = await tx`
      SELECT count(*)::int AS c FROM guesthub.communication_events
      WHERE tenant_id = ${tenant.id}
        AND available_at <= now() AND attempt_count < max_attempts
        AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= now()))`;
    assert.equal(claimable[0].c, 0, "the worker must never be able to claim a watermark row");
    ok("watermark rows are invisible to the worker's claim predicate — nothing can be sent from them");

    // --- (b) a reservation created AFTER cutover emits exactly once ---------
    const fresh = await mkReservation("GUARD-NEW-1", "ota", "confirmed");
    const first = await emit(tx, tenant.id, fresh, "ota");
    assert.equal(first.length, 1, "a reservation created after the cutover must emit its confirmation");
    const second = await emit(tx, tenant.id, fresh, "ota");
    assert.equal(second.length, 0, "a second emission for the same reservation must be swallowed by the occurrence key");
    const third = await emit(tx, tenant.id, fresh, "back_office");
    assert.equal(third.length, 0, "the key is per RESERVATION — a different source must not open a second slot");
    const total = await tx`
      SELECT count(*)::int AS c FROM guesthub.communication_events
      WHERE tenant_id = ${tenant.id} AND reservation_id = ${fresh}`;
    assert.equal(total[0].c, 1, "one reservation, one confirmation — ever");
    ok("a post-cutover reservation emits exactly once; a second, third or differently-sourced attempt emits nothing");

    // leave nothing behind, whatever the outcome
    throw new Error("__rollback__");
  });
} catch (error) {
  if (error?.message !== "__rollback__") failure = error;
}
await sql.end({ timeout: 5 });
if (failure) { console.error(`✗ ${failure.message}`); process.exit(1); }

console.log(`\n✓ check:ota-confirm-once — ${n} checks passed`);
