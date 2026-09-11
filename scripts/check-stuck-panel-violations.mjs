#!/usr/bin/env node
// ============================================================
// check:stuck-panel-violations — the dashboard's "הזמנות ערוץ שנתקעו" panel
// reads TWO sources (D184), and this guard runs the real queries.
//
// WHAT IT PROVES, by execution against a fixture database:
//   · the COUNTER (D169) counts distinct parked bookings (quarantined/failed
//     revisions) and reports the oldest one's age;
//   · the VIOLATION LIST returns every open OTA_STAY_RESTRICTION_VIOLATION
//     row of the tenant, joined to its reservation — number, guest, room,
//     dates, nights, source channel, the engine's codes and Hebrew sentence —
//     newest first;
//   · a booking that is BOTH parked and violating appears ONCE, as a
//     violation row carrying stuck=true (through either link: the revision's
//     local_reservation_id, or connection+provider_booking_id);
//   · a RESOLVED row is excluded, another tenant's row is excluded, a
//     malformed context does not crash the read;
//   · the resolve predicate (resolveSyncErrorAction's UPDATE) closes exactly
//     one open row, records WHO, is idempotent, and is tenant-scoped.
//
// B2 (each turns this red; restore → green):
//   · neutralise the reservation join in loadStuckViolations
//     (e.g. `AND res.id = res.id` instead of the context link, or drop the
//     EXISTS in `stuck`) — the both-row loses its marker / rows vanish;
//   · drop `AND e.resolved_at IS NULL` — the resolved row lists.
//
// Its own scratch database on the isolated :5433 server (created, dropped).
// Usage: node scripts/check-stuck-panel-violations.mjs
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ---- static: the wiring around the read model ------------------------------
{
  const admin = read("src/lib/channel/admin.ts");
  const at = admin.indexOf("export async function resolveSyncErrorAction");
  assert.ok(at > 0, "resolveSyncErrorAction exists in lib/channel/admin.ts");
  const body = admin.slice(at);
  assert.match(body, /await requireChannelAdmin\(\)/, "the resolve action is gated by requireChannelAdmin (canManageChannels)");
  assert.match(body, /SET resolved_at = now\(\), resolved_by = \$\{actor\.userId\}/, "the resolve action records WHO (resolved_by = actor.userId)");
  assert.match(body, /tenant_id = \$\{actor\.tenantId\} AND resolved_at IS NULL/, "the resolve UPDATE is tenant-scoped and only closes an OPEN row");
  assert.ok(!/DELETE FROM guesthub\.channel_sync_errors/.test(admin), "a resolve is never a delete");
  ok("resolveSyncErrorAction: gated, tenant-scoped, records resolved_by, never deletes");

  const win = read("src/app/(dashboard)/dashboard/windows/StuckWindow.tsx");
  assert.match(win, /resolveSyncErrorAction\(r\.errorId\)/, "the window's button calls the resolve action with the error id");
  assert.match(win, /href=\{`\/reservations\?open=\$\{r\.reservationId\}`\}/, "a violation row links to its reservation");
  assert.match(win, /stk-vio-mark/, "the row carries the marker element");
  assert.match(win, /r\.stuck && /, "a both-row renders the stuck marker too");
  const screen = read("src/app/(dashboard)/dashboard/DashboardScreen.tsx");
  assert.match(screen, /subtitle: stuckSubtitle\(data\.stuck\)/, "the panel header count is derived from BOTH sources");
  const sub = screen.slice(screen.indexOf("function stuckSubtitle"));
  assert.match(sub, /stuck\.violations\.filter\(\(v\) => !v\.stuck\)/, "the header's both-case count is the UNION — a both-booking is not counted twice");
  assert.match(sub, /"הפרה" : "הפרות"/, "violations alone are counted in the header");
  const data = read("src/app/(dashboard)/dashboard/data.ts");
  assert.match(data, /loadStuckViolations\(sql, tenantId\)/, "the dashboard read model feeds the violations from lib/channel/stuck-panel.ts");
  assert.match(data, /loadStuckCounter\(sql, tenantId\)/, "…and the counter from the same module");
  const manifest = read("db/migrations/manifest.txt");
  assert.ok(manifest.includes("088_sync_errors_resolved_by.sql"), "migration 088 (resolved_by) is in the manifest");
  ok("UI + read model + manifest wiring is in place");
}

// ---- scratch database + migration chain ------------------------------------
const DB_NAME = `gh_stuck_panel_${process.pid}`;
const RUN_URL = TEST_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);
const psqlAdmin = (q) =>
  execSync(`psql "${TEST_URL}" -qX -c ${JSON.stringify(q)}`, { stdio: ["pipe", "ignore", "inherit"] });
psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME}`);
psqlAdmin(`CREATE DATABASE ${DB_NAME}`);
console.log(`applying migration chain to ${DB_NAME}…`);
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  execSync(`psql "${RUN_URL}" -v ON_ERROR_STOP=1 -qX < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
}

// ---- compile the REAL read model -------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "gh-stuck-panel-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/lib/channel/stuck-panel.ts")],
}));
execSync(`"${join(ROOT, "node_modules/.bin/tsc")}" -p "${join(tmp, "tsconfig.json")}"`, { cwd: ROOT, stdio: "inherit" });
const req = createRequire(join(ROOT, "package.json"));
const panel = req(join(out, "lib/channel/stuck-panel.js"));
const postgres = req("postgres");
const sql = postgres(RUN_URL, { prepare: false, max: 1 });

try {
  // ---- pure: the marker text from the stored context ----------------------
  {
    const dup = panel.violationsFromContext({ violations: [
      { code: "MIN_STAY_NOT_MET", message: "מינימום 2 לילות בטווח זה" },
      { code: "MIN_STAY_NOT_MET", message: "מינימום 2 לילות בטווח זה" },
      { code: "MAX_STAY_EXCEEDED", message: "מקסימום 7 לילות" },
    ] });
    assert.deepEqual(dup.codes, ["MIN_STAY_NOT_MET", "MAX_STAY_EXCEEDED"], "codes are de-duplicated, first-seen order");
    assert.equal(dup.text, "מינימום 2 לילות בטווח זה · מקסימום 7 לילות", "sentences are de-duplicated and joined");
    assert.deepEqual(panel.violationsFromContext(null), { codes: [], text: null }, "no context → no codes, text null (falls back to error_message)");
    assert.deepEqual(panel.violationsFromContext({ violations: "x" }), { codes: [], text: null }, "a non-array violations field is ignored");
    ok("violationsFromContext: dedup, order, fallback");
  }

  // ---- fixture --------------------------------------------------------------
  const uniq = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mkTenant = async (name) => (await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES (${name}, ${uniq("stuck-panel")}, 'Asia/Jerusalem', 'ILS') RETURNING id`)[0].id;
  const T = await mkTenant("בדיקת פאנל תקועות");
  const T2 = await mkTenant("טננט זר");
  const [user] = await sql`
    INSERT INTO guesthub.users (tenant_id, username, full_name) VALUES (${T}, ${uniq("op")}, 'מפעיל') RETURNING id`;
  const conn = async (tid) => (await sql`
    INSERT INTO guesthub.channel_connections (tenant_id, provider, environment, state)
    VALUES (${tid}, 'beds24', 'production', 'active') RETURNING id`)[0].id;
  const C = await conn(T);
  const C2 = await conn(T2);
  const [rt] = await sql`INSERT INTO guesthub.room_types (tenant_id, name, base_price) VALUES (${T}, 'סוג', 400) RETURNING id`;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_type_id, room_number, name, status, is_active)
    VALUES (${T}, ${rt.id}, '1245', 'חדר 1245', 'available', true) RETURNING id`;
  const guest = async (name) => (await sql`
    INSERT INTO guesthub.guests (tenant_id, full_name) VALUES (${T}, ${name}) RETURNING id`)[0].id;

  let seq = 9000;
  const reservation = async ({ tid = T, guestName, bookingId, checkIn, checkOut, status = "confirmed", ota = "booking", withRoom = true }) => {
    const gid = guestName ? await guest(guestName) : null;
    const [res] = await sql`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out,
         channel_connection_id, external_booking_id, ota_name, ota_reservation_code, source_id)
      VALUES (${tid}, ${String(++seq)}, ${gid}, ${status}, ${checkIn}, ${checkOut},
              ${tid === T ? C : C2}, ${bookingId}, ${ota}, ${bookingId ? `OTA-${bookingId}` : null}, NULL)
      RETURNING id, reservation_number`;
    if (withRoom && tid === T)
      await sql`
        INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
        VALUES (${tid}, ${res.id}, ${room.id}, ${checkIn}, ${checkOut})`;
    return res;
  };
  const revision = async ({ tid = T, bookingId, importStatus, localId = null, ageHours = 1 }) => sql`
    INSERT INTO guesthub.channel_booking_revisions
      (tenant_id, connection_id, provider_booking_id, provider_revision_id, revision_kind,
       import_status, local_reservation_id, created_at)
    VALUES (${tid}, ${tid === T ? C : C2}, ${bookingId}, ${`${bookingId}:${uniq("rev")}`}, 'modified',
            ${importStatus}, ${localId}, now() - make_interval(hours => ${ageHours}, mins => 1))`;
  const violation = async ({ tid = T, reservationId, ageHours, resolved = false, context, message = "הזמנת booking מפרה מגבלת שהות: מינימום 2 לילות בטווח זה." }) => (await sql`
    INSERT INTO guesthub.channel_sync_errors
      (tenant_id, connection_id, error_code, error_message, context, created_at, resolved_at, resolved_by)
    VALUES (${tid}, ${tid === T ? C : C2}, ${panel.VIOLATION_CODE}, ${message},
            ${sql.json(context ?? { reservation_id: reservationId, violations: [
              { code: "MIN_STAY_NOT_MET", message: "מינימום 2 לילות בטווח זה", date: null },
              { code: "MIN_STAY_NOT_MET", message: "מינימום 2 לילות בטווח זה", date: null },
            ] })},
            now() - make_interval(hours => ${ageHours}), ${resolved ? sql`now()` : null}, ${resolved ? user.id : null})
    RETURNING id`)[0].id;

  // A — stuck only: a parked revision linked by local_reservation_id, no violation
  const A = await reservation({ guestName: "אורח א", bookingId: "A1", checkIn: "2027-03-01", checkOut: "2027-03-03" });
  await revision({ bookingId: "A1", importStatus: "quarantined", localId: A.id, ageHours: 5 });
  await revision({ bookingId: "A1", importStatus: "failed", localId: A.id, ageHours: 2 }); // same booking twice → counts once
  // B — violating only (oldest violation)
  const B = await reservation({ guestName: "אורח ב", bookingId: "B1", checkIn: "2027-03-10", checkOut: "2027-03-11" });
  const vB = await violation({ reservationId: B.id, ageHours: 3 });
  // E — violating AND cancelled (middle)
  const E = await reservation({ guestName: "אורח ה", bookingId: "E1", checkIn: "2027-03-12", checkOut: "2027-03-15", status: "cancelled", ota: "expedia" });
  await violation({ reservationId: E.id, ageHours: 2, context: { reservation_id: E.id, violations: [{ code: "MAX_STAY_EXCEEDED", message: "מקסימום 2 לילות" }] } });
  // C — BOTH: violation (newest) + a failed revision linked ONLY by connection+booking id
  const C_ = await reservation({ guestName: "Haim Kerido", bookingId: "C1", checkIn: "2026-09-11", checkOut: "2026-09-12" });
  const vC = await violation({ reservationId: C_.id, ageHours: 1 });
  await revision({ bookingId: "C1", importStatus: "failed", localId: null, ageHours: 1 });
  // D — resolved (excluded)
  const D = await reservation({ guestName: "אורח ד", bookingId: "D1", checkIn: "2027-04-01", checkOut: "2027-04-02" });
  await violation({ reservationId: D.id, ageHours: 4, resolved: true });
  // another tenant's violation (excluded)
  const X = await reservation({ tid: T2, guestName: null, bookingId: "X1", checkIn: "2027-04-01", checkOut: "2027-04-02", withRoom: false });
  await violation({ tid: T2, reservationId: X.id, ageHours: 1 });
  // a malformed context (excluded, never a crash)
  await violation({ reservationId: null, ageHours: 1, context: { reservation_id: "not-a-uuid" } });
  await violation({ reservationId: null, ageHours: 1, context: {} });

  // ---- the counter ---------------------------------------------------------
  {
    const c = await panel.loadStuckCounter(sql, T);
    assert.equal(c.count, 2, "counter: two distinct parked bookings (A1 twice, C1 once) → 2");
    assert.equal(c.oldestHours, 5, "counter: the oldest parked revision is 5 whole hours old");
    const empty = await panel.loadStuckCounter(sql, T2);
    assert.deepEqual(empty, { count: 0, oldestHours: null }, "counter: nothing parked → 0 / null");
    ok("loadStuckCounter: distinct bookings, oldest age, tenant-scoped");
  }

  // ---- the violation list --------------------------------------------------
  {
    const rows = await panel.loadStuckViolations(sql, T);
    assert.deepEqual(rows.map((r) => r.reservationNumber), [C_.reservation_number, E.reservation_number, B.reservation_number],
      "three open violations of the tenant, newest first (C, E, B); D (resolved), T2's and the malformed rows are absent");
    const [rc, re, rb] = rows;
    assert.equal(rc.stuck, true, "C is BOTH: its failed revision links by connection+booking id → stuck=true");
    assert.equal(rb.stuck, false, "B is violating only → stuck=false");
    assert.equal(re.stuck, false, "E is violating only → stuck=false");
    assert.equal(re.cancelled, true, "E is cancelled and STILL listed, tagged");
    assert.equal(rc.cancelled, false, "C is live");
    assert.equal(rc.errorId, vC, "the row carries the channel_sync_errors id the button resolves");
    assert.equal(rc.guestName, "Haim Kerido", "guest name from guests.full_name");
    assert.equal(rc.roomNumber, "1245", "first room of the booking");
    assert.equal(rc.checkIn, "2026-09-11");
    assert.equal(rc.checkOut, "2026-09-12");
    assert.equal(rc.nights, 1, "nights = check_out − check_in");
    assert.equal(re.nights, 3);
    assert.equal(rc.otaName, "booking", "source channel as the import recorded it");
    assert.equal(re.otaName, "expedia");
    assert.equal(rc.otaReservationCode, "OTA-C1");
    assert.deepEqual(rc.codes, ["MIN_STAY_NOT_MET"], "codes from context.violations, de-duplicated");
    assert.equal(rc.violationText, "מינימום 2 לילות בטווח זה", "the marker text is the engine's sentence, once");
    assert.deepEqual(re.codes, ["MAX_STAY_EXCEEDED"]);
    assert.equal(re.violationText, "מקסימום 2 לילות");
    assert.match(rc.message, /מפרה מגבלת שהות/, "the stored error_message rides along verbatim");
    assert.ok(rc.createdAt > rb.createdAt, "createdAt is the ordering key");
    assert.deepEqual(await panel.loadStuckViolations(sql, T2).then((r) => r.map((x) => x.reservationId)), [X.id], "the other tenant sees only its own row");
    ok("loadStuckViolations: 3 rows, markers, fields, ordering, exclusions");
  }

  // ---- a violation whose reservation is gone is not listed (no crash) ------
  {
    const G = await reservation({ guestName: "אורח ז", bookingId: "G1", checkIn: "2027-05-01", checkOut: "2027-05-02" });
    await violation({ reservationId: G.id, ageHours: 0 });
    await sql`DELETE FROM guesthub.reservation_rooms WHERE reservation_id = ${G.id}`;
    await sql`DELETE FROM guesthub.reservations WHERE id = ${G.id}`;
    const rows = await panel.loadStuckViolations(sql, T);
    assert.equal(rows.length, 3, "a violation whose reservation was deleted has nowhere to link and is not listed");
    ok("orphaned violation row: excluded, no crash");
  }

  // ---- the resolve predicate (the action's UPDATE, verbatim) ---------------
  {
    const resolve = (id, tenantId, userId) => sql`
      UPDATE guesthub.channel_sync_errors
         SET resolved_at = now(), resolved_by = ${userId}
       WHERE id = ${id} AND tenant_id = ${tenantId} AND resolved_at IS NULL
       RETURNING id`;
    assert.equal((await resolve(vB, T2, user.id)).length, 0, "another tenant cannot close the row (0 rows)");
    assert.equal((await resolve(vB, T, user.id)).length, 1, "the owner tenant closes exactly one row");
    assert.equal((await resolve(vB, T, user.id)).length, 0, "a second click matches nothing — the first closure's author stands");
    const [row] = await sql`SELECT resolved_at, resolved_by FROM guesthub.channel_sync_errors WHERE id = ${vB}`;
    assert.ok(row.resolved_at, "resolved_at is set");
    assert.equal(row.resolved_by, user.id, "resolved_by records the operator (NULL would mean an automatic closure)");
    const after = await panel.loadStuckViolations(sql, T);
    assert.deepEqual(after.map((r) => r.reservationNumber), [C_.reservation_number, E.reservation_number], "the resolved row left the list; the others stay");
    const [cnt] = await sql`SELECT count(*)::int AS c FROM guesthub.channel_sync_errors WHERE id = ${vB}`;
    assert.equal(cnt.c, 1, "resolving never deletes — the row is history");
    ok("resolve: one row, tenant-scoped, idempotent, authored, never deleted");
  }

  console.log(`\nSTUCK PANEL VIOLATIONS CHECK: ${n} PASSED`);
} catch (e) {
  console.error(`STUCK PANEL VIOLATIONS CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  try { psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME}`); } catch { /* scratch DB */ }
}
