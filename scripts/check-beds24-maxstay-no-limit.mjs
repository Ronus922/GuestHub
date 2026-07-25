#!/usr/bin/env node
// check:beds24-maxstay-no-limit — a local "no limit" must actually remove the
// limit AT BEDS24, not just in our database.
//
// WHY. `pricing_plan_rates.max_stay IS NULL` means "no maximum stay". Beds24
// has NO value that means that, and — the part that makes this dangerous — no
// way to CLEAR a daily value at all. Measured live 2026-07-25 against
// production (there is no staging), room 1318, seven days 191 days out, each
// variant preceded by a maxStay=5 sentinel so "ignored" and "cleared" stayed
// distinguishable:
//
//   maxStay: 0     → 201 + warning "capped to 1"            → becomes 1
//   maxStay: null  → 201 {"success":true}, no modified      → IGNORED
//   maxStay: ""    → same                                    → IGNORED
//   maxStay: 3650  → 201 + warning "capped to room 365"      → becomes 365
//   omitted        → IGNORED (control)
//
// So a builder that OMITS the field when the local value is NULL leaves the old
// limit standing upstream forever. The UI then says "ללא הגבלה" while Beds24
// keeps refusing every stay longer than 31 nights — silent under-selling that
// no screen and no error can show. 4,830 rows across 15 units are in that
// state today. The fix is to translate NULL into the room's OWN ceiling, read
// from the provider.
//
// WHAT THIS GUARD RUNS. The REAL drain (drainBeds24AriDirtyRanges) against the
// disposable test DB (:5433), in front of a STATEFUL mock that implements the
// measured contract above: it keeps a per-(room,date) upstream value, applies
// the clamp, and — critically — treats an absent/null maxStay as a NO-OP that
// leaves the previous value in place. Every assertion below reads that upstream
// state back, so it measures BEHAVIOUR, not the shape of the payload.
//
// It does NOT call Beds24. A guard that wrote to the live listing on every run
// would be a real commercial write with no way back; the measurement above is
// encoded in the mock instead, which is the same choice check:beds24-ari-drain
// makes for the rest of the calendar contract.
//
// Usage: node scripts/check-beds24-maxstay-no-limit.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import Module from "node:module";
import { join } from "node:path";
import postgres from "postgres";

const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;
process.env.CHANNEL_SECRETS_KEY = "check-beds24-maxstay-key";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const ROOT = process.cwd();

execSync("pnpm exec tsc -p tsconfig.worker.json", { stdio: "inherit" });
const OUT = join(ROOT, "dist", "worker");
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const require2 = createRequire(import.meta.url);
const ari = require2(join(OUT, "lib/channel/beds24-ari-sync.js"));
const ceilingsMod = require2(join(OUT, "lib/channel/beds24-room-ceilings.js"));
const { encryptSecret } = require2(join(OUT, "lib/channel/crypto.js"));

// ============================================================
// The stateful Beds24 mock — the measured contract, not a stub
// ============================================================
const ACCESS_TOKEN = "check-maxstay-access-token";
const PROPERTY = "999003";
const B24_WIDE = "708101";   // room-level ceiling 365
const B24_NARROW = "708102"; // room-level ceiling 200 — proves nothing is hardcoded
const CEILING = { [B24_WIDE]: 365, [B24_NARROW]: 200 };

const iso = (d) => d.toISOString().slice(0, 10);
const day = (o) => iso(new Date(Date.now() + o * 86_400_000));

/** what Beds24 currently enforces: `${roomId}|${date}` → maxStay (or undefined) */
let upstream = new Map();
/** every POST body this run */
let calls = [];
let propertyReads = 0;
/** make GET /properties fail, to prove the push is never blocked on it */
let propertiesFail = false;
const violations = [];
const must = (c, m) => { if (!c) violations.push(m); };
const noViolations = () =>
  assert.equal(violations.length, 0, `wire-contract violation(s): ${violations.join(" | ")}`);

const eachDate = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = iso(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000))) out.push(d);
  return out;
};

const fakeFetch = async (url, init) => {
  const u = new URL(String(url));
  must(u.host === "api.beds24.com", `unexpected outbound host: ${u.host}`);
  const headers = Object.fromEntries(
    Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  must(headers.token === ACCESS_TOKEN, "Beds24 v2 takes the access token in a bare `token` header");
  const credit = {
    "Content-Type": "application/json",
    "x-five-min-limit-remaining": "97.6",
    "x-five-min-limit-resets-in": "155",
    "x-request-cost": "1.2",
  };

  // ---- the ceiling read ----
  if (u.pathname === "/v2/properties") {
    propertyReads += 1;
    must((init?.method ?? "GET") === "GET", "the ceiling read is a GET — it must never write");
    if (propertiesFail) return new Response(JSON.stringify({ success: false }), { status: 500, headers: credit });
    return new Response(JSON.stringify({
      success: true,
      data: [{
        id: Number(PROPERTY),
        roomTypes: [
          { id: Number(B24_WIDE), name: "Wide", maxStay: CEILING[B24_WIDE], minStay: null },
          { id: Number(B24_NARROW), name: "Narrow", maxStay: CEILING[B24_NARROW], minStay: null },
        ],
      }],
    }), { status: 200, headers: credit });
  }

  // ---- the calendar write ----
  must(u.pathname === "/v2/inventory/rooms/calendar", `unexpected path ${u.pathname}`);
  must((init?.method ?? "GET") === "POST", "the calendar write is a POST");
  const body = JSON.parse(init.body);
  calls.push(body);
  const warnings = [];
  for (const entry of body) {
    const roomId = String(entry.roomId);
    const ceiling = CEILING[roomId];
    for (const r of entry.calendar ?? []) {
      // THE MEASURED SEMANTICS. Absent or null ⇒ nothing happens: the value
      // already stored upstream survives. This is the whole bug.
      if (r.maxStay === undefined || r.maxStay === null || r.maxStay === "") continue;
      must(Number.isInteger(r.maxStay),
        `maxStay must be an integer on the wire (got ${JSON.stringify(r.maxStay)})`);
      let effective = r.maxStay;
      if (effective < 1) { effective = 1; warnings.push("maxStay capped to 1"); }
      else if (ceiling !== undefined && effective > ceiling) {
        effective = ceiling; warnings.push(`maxStay capped to room maxStay ${ceiling}`);
      }
      for (const d of eachDate(r.from, r.to)) upstream.set(`${roomId}|${d}`, effective);
    }
  }
  return new Response(JSON.stringify(
    warnings.length ? { success: true, warnings } : { success: true },
  ), { status: 200, headers: credit });
};

globalThis.fetch = async () => {
  must(false, "a request escaped the injected fetch — a token mint would burn real credits");
  return new Response(JSON.stringify({ success: false }), { status: 500 });
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const slug = `b24-maxstay-${Date.now()}`;
let tenantId;
const PRICE = 480;
// a dirty range is [date_from, date_to) — EXCLUSIVE upper bound, the same
// convention projectBeds24Ari uses — so a range of day(0)..day(SPAN) pushes
// exactly SPAN dates, not SPAN + 1.
const SPAN = 6;

try {
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES ('Beds24 maxStay Check', ${slug}, 'Asia/Jerusalem', 'ILS') RETURNING id`;
  tenantId = tenant.id;
  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenantId}, 'MaxStay Type', 400) RETURNING id`;

  const mkRoom = async (num) => {
    const [r] = await sql`
      INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
      VALUES (${tenantId}, ${num}, ${rt.id}, 'available', true) RETURNING id`;
    const [su] = await sql`
      INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${tenantId}, ${num}, ${`יחידה ${num}`}, ${rt.id}) RETURNING id`;
    await sql`
      INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
      VALUES (${tenantId}, ${su.id}, ${r.id})`;
    await sql`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
      VALUES (${tenantId}, ${su.id}, 'base', 'מחיר בסיס', true, 'base')`;
    return { roomId: r.id, suId: su.id };
  };
  const WIDE = await mkRoom("MS-WIDE");
  const NARROW = await mkRoom("MS-NARROW");

  const [plan] = await sql`
    INSERT INTO guesthub.pricing_plans
      (tenant_id, sellable_unit_id, code, name, plan_kind, is_active, is_archived, is_visible_channels)
    VALUES (${tenantId}, NULL, 'beds24', 'תוכנית ערוץ', 'base', true, false, true) RETURNING id`;
  for (const u of [WIDE, NARROW]) {
    await sql`
      INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
      VALUES (${tenantId}, ${plan.id}, ${u.suId}, true)`;
  }
  // start every date with an ENFORCED 31 — the state 4,830 real rows are in
  for (let d = 0; d <= SPAN + 2; d++) {
    for (const u of [WIDE, NARROW]) {
      await sql`
        INSERT INTO guesthub.pricing_plan_unit_rates
          (tenant_id, pricing_plan_id, sellable_unit_id, date, price, max_stay)
        VALUES (${tenantId}, ${plan.id}, ${u.suId}, ${day(d)}, ${PRICE}, 31)`;
    }
  }

  const [connRow] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at)
    VALUES
      (${tenantId}, 'beds24', 'production', 'active', true, false, true, false,
       ${encryptSecret("check-refresh-token")}, ${encryptSecret(ACCESS_TOKEN)},
       now() + interval '12 hours')
    RETURNING id`;
  const connId = connRow.id;
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, local_rate_plan_id, status)
    VALUES
      (${tenantId}, ${connId}, ${PROPERTY}, ${B24_WIDE}, ${WIDE.roomId}, ${plan.id}, 'mapped'),
      (${tenantId}, ${connId}, ${PROPERTY}, ${B24_NARROW}, ${NARROW.roomId}, ${plan.id}, 'mapped')`;

  const loadConn = async () => {
    const c = (await ari.loadDrainableBeds24Connections(sql)).find((x) => x.id === connId);
    assert.ok(c, "the connection is drainable");
    return c;
  };
  const markDirty = async (roomId) => {
    await sql`
      INSERT INTO guesthub.channel_dirty_ranges
        (tenant_id, connection_id, room_id, local_rate_plan_id, kind, date_from, date_to,
         status, attempts, next_attempt_at)
      VALUES (${tenantId}, ${connId}, ${roomId}, ${plan.id}, 'restrictions',
              ${day(0)}, ${day(SPAN)}, 'pending', 0, now())`;
  };
  const drain = async () => {
    calls = [];
    const s = await ari.drainBeds24AriDirtyRanges(sql, await loadConn(), { fetchImpl: fakeFetch });
    noViolations();
    return s;
  };
  /** every maxStay Beds24 is enforcing for a room across the pushed window */
  const enforced = (b24RoomId) =>
    eachDate(day(0), day(SPAN - 1)).map((d) => upstream.get(`${b24RoomId}|${d}`));
  const sentMaxStays = () => {
    const out = [];
    for (const body of calls) for (const e of body) for (const r of e.calendar ?? []) {
      out.push({ roomId: String(e.roomId), present: "maxStay" in r, value: r.maxStay });
    }
    return out;
  };
  const setMaxStay = (suId, value) => sql`
    UPDATE guesthub.pricing_plan_unit_rates SET max_stay = ${value}
    WHERE tenant_id = ${tenantId} AND pricing_plan_id = ${plan.id} AND sellable_unit_id = ${suId}`;

  // ============================================================
  // 1. BASELINE — an explicit local limit is what Beds24 ends up enforcing
  // ============================================================
  ceilingsMod.clearBeds24CeilingCache();
  await markDirty(WIDE.roomId);
  const s1 = await drain();
  assert.equal(s1.failed, 0, "the baseline drain does not fail");
  assert.deepEqual(enforced(B24_WIDE), Array(SPAN).fill(31),
    `a local max_stay of 31 is enforced upstream on all ${SPAN} pushed dates`);
  ok(`BASELINE: an explicit local max_stay reaches Beds24 and is enforced (31 on ${SPAN}/${SPAN} dates)`);

  // ============================================================
  // 2. THE ASSERTION — local NULL must leave the room UNLIMITED upstream.
  //    On the pre-fix code the builder omits the field, the mock's no-op keeps
  //    31, and this fails. That is exactly leg A.
  // ============================================================
  await setMaxStay(WIDE.suId, null);
  await markDirty(WIDE.roomId);
  await drain();
  const afterNull = enforced(B24_WIDE);
  assert.deepEqual(afterNull, Array(SPAN).fill(CEILING[B24_WIDE]),
    `a local max_stay of NULL must leave Beds24 enforcing the room ceiling ` +
    `(${CEILING[B24_WIDE]}); it is enforcing ${JSON.stringify(afterNull)}. ` +
    `An omitted maxStay is a NO-OP upstream: the OLD limit survives forever.`);
  ok("NULL ⇒ the room's ceiling is enforced upstream — the old limit is really gone");

  // ============================================================
  // 3. the field is SENT, not omitted — the mechanism, stated
  // ============================================================
  const sent = sentMaxStays().filter((x) => x.roomId === B24_WIDE);
  assert.ok(sent.length > 0, "the NULL drain issued a calendar write for the room");
  assert.ok(sent.every((x) => x.present && Number.isInteger(x.value)),
    `every range must carry an explicit integer maxStay; got ${JSON.stringify(sent)}`);
  ok("the wire carries an explicit integer maxStay — never an omission, never null");

  // ============================================================
  // 4. NOT HARDCODED — a room with a different ceiling gets ITS ceiling
  // ============================================================
  await setMaxStay(NARROW.suId, null);
  await markDirty(NARROW.roomId);
  await drain();
  assert.deepEqual(enforced(B24_NARROW), Array(SPAN).fill(CEILING[B24_NARROW]),
    `the narrow room's ceiling is ${CEILING[B24_NARROW]}, not the other room's ` +
    `${CEILING[B24_WIDE]} — the value must come from the provider, per room`);
  ok(`the ceiling is per-room and provider-sourced (${CEILING[B24_NARROW]}, not ${CEILING[B24_WIDE]})`);

  // ============================================================
  // 5. CLEAN 201 — sending the ceiling itself must raise NO warning.
  //    Sending 3650 and letting Beds24 clamp would work too, but every push
  //    would carry a warnings[] array, inspectEnvelope marks any such body
  //    `partial`, and every commercial push would read partial forever.
  // ============================================================
  await setMaxStay(WIDE.suId, null);
  await markDirty(WIDE.roomId);
  const s5 = await drain();
  assert.equal(s5.failed, 0, "the drain succeeds");
  const [range] = await sql`
    SELECT status, last_error_code FROM guesthub.channel_dirty_ranges
    WHERE tenant_id = ${tenantId} AND room_id = ${WIDE.roomId}
    ORDER BY revision DESC LIMIT 1`;
  assert.equal(range.status, "synced",
    "translating NULL must not make the range partial/retryable — a value above " +
    "the ceiling would warn on every push and never settle");
  assert.equal(range.last_error_code, null, "a clean push records no error code");
  ok("the translated value is the ceiling itself: a clean push, no warning, range synced");

  // ============================================================
  // 6. CACHED — the ceiling read is one call, not one per drain
  // ============================================================
  const before = propertyReads;
  await markDirty(WIDE.roomId);
  await drain();
  assert.equal(propertyReads, before,
    `the ceiling was re-read ${propertyReads - before} extra time(s); it is a constant ` +
    `in the Beds24 panel and re-reading it spends a credit on every drain`);
  ok("the ceiling read is cached — a second drain spends no extra credit");

  // ============================================================
  // 7. FAIL-OPEN — an unreadable ceiling must never block a commercial push
  // ============================================================
  ceilingsMod.clearBeds24CeilingCache();
  propertiesFail = true;
  upstream.set(`${B24_WIDE}|${day(0)}`, 31); // a stale limit sitting upstream
  await markDirty(WIDE.roomId);
  const s7 = await drain();
  propertiesFail = false;
  assert.equal(s7.failed, 0,
    "a failed ceiling read must not fail the drain — price and availability still have to go out");
  const omitted = sentMaxStays().filter((x) => x.roomId === B24_WIDE);
  assert.ok(omitted.length > 0 && omitted.every((x) => !x.present),
    `with no readable ceiling the field must be OMITTED, never guessed: ${JSON.stringify(omitted)}`);
  assert.equal(upstream.get(`${B24_WIDE}|${day(0)}`), 31,
    "omitting leaves the upstream value untouched — the documented no-op, not a silent 1");
  ok("FAIL-OPEN: an unreadable ceiling omits the field and still pushes; nothing is guessed");

  console.log(`\ncheck-beds24-maxstay-no-limit: all ${n} assertions passed`);
} catch (e) {
  console.error(`\ncheck-beds24-maxstay-no-limit FAILED\n`, e);
  process.exitCode = 1;
} finally {
  if (tenantId) await sql`DELETE FROM guesthub.tenants WHERE id = ${tenantId}`.catch(() => {});
  await sql.end();
}
