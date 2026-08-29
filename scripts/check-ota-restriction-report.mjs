// ============================================================
// D153 — OTA stay-restriction REPORTING guard.
//
// Two rules this suite exists to hold:
//   1. an OTA import NEVER blocks on a stay restriction (the booking already
//      happened at the channel; refusing it hides a sold room instead of
//      un-selling it) — but a violation IS reported so the underlying defect
//      (bad ARI projection / manual extranet override) becomes visible;
//   2. skipChecksForRr may only skip a stay that kept its committed dates.
//
// Runs against the ISOLATED test DB (guesthub-testdb, :5433) inside one
// transaction that ROLLS BACK. Never touches production.
// Usage: node scripts/check-ota-restriction-report.mjs
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "./lib/collect-assert.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";

// fail-closed: this script must never run against production
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
// Its OWN scratch database on the same isolated server, created fresh and
// dropped at the end. The shared test DB accumulates drift between suites (the
// chain no longer re-applies to it), and a suite that asserts on rows must not
// depend on whatever a previous run left behind.
const ADMIN_URL = TEST_URL;
const DB_NAME = `gh_ota_check_${process.pid}`;
const RUN_URL = TEST_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);
const psqlAdmin = (q) =>
  execSync(`psql "${ADMIN_URL}" -qX -c ${JSON.stringify(q)}`, { stdio: ["pipe", "ignore", "inherit"] });

psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME}`);
psqlAdmin(`CREATE DATABASE ${DB_NAME}`);
process.env.DATABASE_URL = RUN_URL;

console.log(`applying migration chain to ${DB_NAME}…`);
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  execSync(`psql "${RUN_URL}" -v ON_ERROR_STOP=1 -qX < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
}

console.log("compiling the engine + seam + reporter via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-ota-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [
    join(ROOT, "src/lib/pricing/engine.ts"),
    join(ROOT, "src/lib/pricing/reservation-pricing.ts"),
    join(ROOT, "src/lib/channel/ota-restriction-report.ts"),
  ],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  try {
    return origResolve.call(this, request, ...rest);
  } catch (e) {
    // the compiled graph lives in a tmp dir with no node_modules — bare deps
    // (postgres, …) resolve from the project root instead
    if (request.startsWith(".") || request.startsWith("/")) throw e;
    return req.resolve(request);
  }
};

const reporter = req(join(out, "lib/channel/ota-restriction-report.js"));
const seam = req(join(out, "lib/pricing/reservation-pricing.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

const postgres = req("postgres");
const sql = postgres(RUN_URL, { prepare: false, max: 1 });
class Rollback extends Error {}

// 2027-04-05 .. 2027-04-09 — five priced nights, min_stay_arrival=3 on the 5th
const IN = "2027-04-05", OUT = "2027-04-07"; // 2 nights → violates the 3-night min

async function buildFixture(tx) {
  const uniq = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [tenant] = await tx`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency, settings)
    VALUES ('בדיקת דיווח מגבלות OTA', ${uniq("ota-restriction")}, 'Asia/Jerusalem', 'ILS',
      ${tx.json({ vat_rate: 18 })}) RETURNING id`;
  const T = tenant.id;
  const [rt] = await tx`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${T}, 'סוג בדיקה', 400) RETURNING id`;
  const [room] = await tx`
    INSERT INTO guesthub.rooms ${tx({
      tenant_id: T, room_type_id: rt.id, room_number: "961", name: "חדר 961",
      status: "available", is_active: true,
      max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1,
      min_occupancy: 1, included_occupancy: 2, default_occupancy: 2,
      extra_guest_pricing_mode: "inherit",
    })} RETURNING id`;
  const [su] = await tx`
    INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
    VALUES (${T}, '961', 'יחידה 961', ${rt.id}) RETURNING id`;
  await tx`
    INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
    VALUES (${T}, ${su.id}, ${room.id})`;
  const [bp] = await tx`
    INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
    VALUES (${T}, ${su.id}, 'base', 'מחיר בסיס', true, 'base') RETURNING id`;

  const rate = (date, price, extra = {}) => tx`
    INSERT INTO guesthub.pricing_plan_rates ${tx({
      tenant_id: T, sellable_unit_id: su.id, pricing_plan_id: bp.id, date, price, ...extra,
    })}`;
  // the arrival date carries a 3-night minimum; the rest are unrestricted
  await rate("2027-04-05", 500, { min_stay_arrival: 3 });
  for (const d of ["2027-04-06", "2027-04-07", "2027-04-08", "2027-04-09"]) await rate(d, 500);
  // two clean windows with no restriction at all — separate rooms/dates keep
  // the double-booking exclusion constraint out of the way between scenarios
  for (const d of ["2027-05-10", "2027-05-11", "2027-05-12"]) await rate(d, 500);
  for (const d of ["2027-06-01", "2027-06-02", "2027-06-03"]) await rate(d, 500);

  const [conn] = await tx`
    INSERT INTO guesthub.channel_connections (tenant_id, provider, state)
    VALUES (${T}, 'beds24', 'active') RETURNING id`;

  return { T, roomId: room.id, connectionId: conn.id };
}

const mkStay = (roomId, checkIn, checkOut) => ({
  roomId, localRatePlanId: null, checkIn, checkOut,
  adults: 2, children: 0, infants: 0,
});

const ctxFor = (f, reservationId) => ({
  tenantId: f.T, connectionId: f.connectionId, reservationId,
  reservationNumber: "9101", bookingId: "BK-123", otaName: "Booking.com",
});

// a real reservation row, exactly as the import writes it — no validation
async function importBooking(tx, f, checkIn, checkOut) {
  const [g] = await tx`
    INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name)
    VALUES (${f.T}, 'אורח', 'בדיקה', 'אורח בדיקה') RETURNING id`;
  const [r] = await tx`
    INSERT INTO guesthub.reservations
      (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out, total_price)
    VALUES (${f.T}, ${`R${Math.floor(Math.random() * 1e6)}`}, ${g.id}, 'confirmed',
            ${checkIn}, ${checkOut}, 1000) RETURNING id`;
  const [rr] = await tx`
    INSERT INTO guesthub.reservation_rooms
      (tenant_id, reservation_id, room_id, check_in, check_out, adults, children, infants,
       rate_per_night, price_total, is_manual_rate, price_mode)
    VALUES (${f.T}, ${r.id}, ${f.roomId}, ${checkIn}, ${checkOut}, 2, 0, 0,
            500, 1000, true, 'manual_night') RETURNING id`;
  return { reservationId: r.id, rrId: rr.id };
}

const countErrors = async (tx, T) => {
  const [c] = await tx`
    SELECT count(*)::int AS c FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${T} AND error_code = 'OTA_STAY_RESTRICTION_VIOLATION'`;
  return c.c;
};

try {
  await sql.begin(async (tx) => {
    const f = await buildFixture(tx);

    // ---- 1: a clean import reports nothing ----
    {
      const { reservationId } = await importBooking(tx, f, "2027-05-10", "2027-05-12");
      const found = await reporter.reportOtaRestrictionViolations(
        tx, ctxFor(f, reservationId), [mkStay(f.roomId, "2027-05-10", "2027-05-12")],
      );
      assert.equal(found.length, 0, "a compliant stay must produce no violation");
      assert.equal(await countErrors(tx, f.T), 0, "no operator error row for a clean import");
      ok("ייבוא תקין עובר נקי — אפס ממצאים, אפס שורות שגיאה");
    }

    // ---- 2: a min-stay violation is WRITTEN and REPORTED ----
    let violatingReservationId;
    {
      const { reservationId } = await importBooking(tx, f, IN, OUT);
      violatingReservationId = reservationId;
      const found = await reporter.reportOtaRestrictionViolations(
        tx, ctxFor(f, reservationId), [mkStay(f.roomId, IN, OUT)],
      );
      assert.equal(found.length, 1, "the 2-night stay must violate the 3-night arrival minimum");
      assert.equal(found[0].code, "MIN_STAY_NOT_MET", "the reported code");
      assert.equal(found[0].date, IN, "the violation is anchored on the arrival date");

      // the booking itself was written — the whole point
      const [row] = await tx`
        SELECT check_in::text AS check_in, check_out::text AS check_out
        FROM guesthub.reservation_rooms WHERE reservation_id = ${reservationId}`;
      assert.equal(row.check_in, IN, "the violating stay is still written (check_in)");
      assert.equal(row.check_out, OUT, "the violating stay is still written (check_out)");

      // and it landed on the operator's surface, unresolved
      const [err] = await tx`
        SELECT error_code, error_message, context, resolved_at, date_from::text AS date_from
        FROM guesthub.channel_sync_errors
        WHERE tenant_id = ${f.T} AND error_code = 'OTA_STAY_RESTRICTION_VIOLATION'`;
      assert.ok(err, "an operator-visible error row exists");
      assert.equal(err.resolved_at, null, "it is unresolved, so the channels screen shows it");
      assert.equal(err.date_from, IN, "the error row carries the stay window");
      assert.equal(err.context.reservation_id, violatingReservationId, "traceable to the reservation");
      assert.equal(err.context.violations.length, 1, "the structured violation rides in context");
      ok("ייבוא שמפר min-stay נכתב וגם מסומן — שורה גלויה ולא-פתורה למפעיל");
    }

    // ---- 3: a reporter failure never blocks ----
    {
      // an rrId-free stay pointing at a room that does not exist: the engine
      // rejects the request, and the reporter must still return cleanly
      const bogus = "00000000-0000-0000-0000-000000000000";
      const before = await countErrors(tx, f.T);
      const found = await reporter.reportOtaRestrictionViolations(
        tx, ctxFor(f, violatingReservationId), [mkStay(bogus, IN, OUT)],
      );
      assert.ok(Array.isArray(found), "the reporter returns an array, never throws");
      assert.equal(await countErrors(tx, f.T), before, "a non-restriction failure adds no noise");
      ok("כשל בבדיקה עצמה לא מפיל את הייבוא ולא מייצר רעש");
    }

    // ---- 4: the skipChecksForRr invariant ----
    {
      const { rrId } = await importBooking(tx, f, "2027-06-01", "2027-06-03");

      // same dates → the skip is legitimate and prices without touching the engine
      const same = await seam.priceReservationStays(
        tx, f.T,
        [{ rrId, roomId: f.roomId, checkIn: "2027-06-01", checkOut: "2027-06-03",
           adults: 2, children: 0, infants: 0, isManualRate: true, ratePerNight: 500 }],
        { source: "manual_reservation", enforceAvailability: true, enforceRestrictions: true,
          skipChecksForRr: new Set([rrId]) },
      );
      assert.equal(same.length, 1, "an untouched stay still prices");
      ok("שהות שדילגה ותאריכיה לא השתנו — עוברת כרגיל");

      // changed dates while still asking to skip → must be refused
      let threw = null;
      try {
        await seam.priceReservationStays(
          tx, f.T,
          [{ rrId, roomId: f.roomId, checkIn: "2027-06-02", checkOut: "2027-06-03",
             adults: 2, children: 0, infants: 0, isManualRate: true, ratePerNight: 500 }],
          { source: "manual_reservation", enforceAvailability: true, enforceRestrictions: true,
            skipChecksForRr: new Set([rrId]) },
        );
      } catch (e) { threw = e; }
      assert.ok(threw, "a re-dated stay must NOT be allowed to skip its checks");
      assert.equal(threw.code, "INVALID_DATE_RANGE", "refused as a malformed request");
      ok("שהות שדילגה אך תאריכיה השתנו — נחסמת");
    }

    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

  console.log(`\nOTA RESTRICTION REPORT CHECK: ${n} PASSED`);
} catch (e) {
  console.error(`OTA RESTRICTION REPORT CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  try { psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME}`); } catch { /* scratch DB */ }
}
