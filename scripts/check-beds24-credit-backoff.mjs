#!/usr/bin/env node
// check:beds24-credit-backoff — the Beds24 credit window really slows the worker.
//
// WHY. Beds24 meters by CREDITS: 100 per rolling 5-minute window per account,
// dynamic per-request cost. The worker's only reaction to pressure used to be a
// blind retry, and the header it *thought* it was reading
// ("x-fivemincreditlimit-remaining") does not exist on the wire — which is why
// 100% of the persisted creditsRemaining values were NULL. The real names,
// captured live from api.beds24.com on 2026-07-24 with the production token:
//
//   x-five-min-limit-remaining: 97.6   x-five-min-limit-resets-in: 155
//   x-request-cost:             1.2
//
// This check encodes THAT contract in the mock — so it fails on unfixed code —
// and proves both required scenarios through the REAL compiled worker modules:
//   (a) Remaining below the derived threshold  → the run stops issuing calls and
//       waits the provider's own resets-in, instead of walking its page/row cap.
//   (b) HTTP 429                               → its own path, cooldown from
//       Retry-After when present, else resets-in; never a blind retry.
//
// ---- B2 HISTORY: what each section exists to catch --------------------------
// A guard is only real if it goes RED when the central predicate it claims to
// protect is turned into `false` while every name, import and call site stays
// in place. Three predicates survived that treatment and the holes they left
// are why the last four sections exist (measured 2026-07-25, staging :5434):
//   · `if (gate.pause) break` in sendCalendarRequests → `false`: 15/15 GREEN.
//     Every outbound fixture compressed into ONE request body, so the burst-stop
//     was never asked to stop a burst.        → "burst control" + "burst-stop".
//   · the gate's `next.waitMs > pause.waitMs` → `false` (i.e. FIRST wait wins
//     instead of LONGEST): 15/15 GREEN. Only the shortening direction was
//     tested.                                 → the extending case in "gate".
//   · `res.category === "rate_limited"` → `false` in the calendar sender:
//     15/15 GREEN. No outbound fixture ever answered 429.
//                                             → the two "outbound 429" sections.
//   · `warnings.length === 0` in the pause condition → `true`: vacuously green,
//     no fixture ever produced a warning.     → the "partial warnings" section.
// Keep every one of these sections behavioural: they must read the DATABASE (or
// the real module's own return value) after a real run, never the source text.
//
// Usage: node scripts/check-beds24-credit-backoff.mjs
//   TEST_DATABASE_URL — any NON-production database with the migration chain
//   applied. It must NOT be the shared testdb schema when other work is running
//   against it; an isolated database is the safe choice.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
process.env.CHANNEL_SECRETS_KEY = "check-beds24-credit-backoff-key";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const ROOT = process.cwd();

// ---- CONTRACT assertions (structural) -------------------------------------
// These read SOURCE TEXT, not behaviour. They can only catch a contract breach
// — a renamed/duplicated wire constant — never a behaviour breach. Every
// behavioural claim in this file is made below, against the real modules and a
// real database. A contract assertion is never evidence that the gate works.
const CONTRACT = (m) => `CONTRACT BREACH (structural, not behaviour): ${m}`;
const creditsSrc = readFileSync(join(ROOT, "src/lib/channel/beds24-credits.ts"), "utf8");
for (const header of [
  "x-five-min-limit-remaining",
  "x-five-min-limit-resets-in",
  "x-request-cost",
]) {
  assert.ok(creditsSrc.includes(`"${header}"`),
    CONTRACT(`the measured header ${header} is no longer declared in beds24-credits.ts`));
}
const httpSrc = readFileSync(join(ROOT, "src/lib/channel/beds24-http.ts"), "utf8");
assert.ok(
  !httpSrc.includes("fivemincreditlimit"),
  CONTRACT("the header name that never existed on the wire is back in the HTTP core"),
);
assert.match(httpSrc, /readBeds24Credits/,
  CONTRACT("the HTTP core no longer reads the meter through the one reader"));
ok("CONTRACT: the measured Beds24 credit header names, declared once, read once");

// ---- compile the real worker graph and require it the worker's own way ----
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
const credits = require2(join(OUT, "lib/channel/beds24-credits.js"));
const breaker = require2(join(OUT, "lib/channel/circuit-breaker.js"));
const imp = require2(join(OUT, "lib/channel/beds24-booking-import.js"));
const ari = require2(join(OUT, "lib/channel/beds24-ari-sync.js"));
const { encryptSecret } = require2(join(OUT, "lib/channel/crypto.js"));

// ---- the meter, read off the EXACT header set captured live ----
const LIVE = {
  "x-five-min-limit-remaining": "97.6",
  "x-five-min-limit-resets-in": "155",
  "x-request-cost": "1.2",
};
const live = credits.readBeds24Credits((k) => LIVE[k] ?? null);
assert.deepEqual(live, { remaining: 97.6, resetsInSec: 155, cost: 1.2 },
  "the live 2026-07-24 header set parses into the meter (fractional, NOT rounded)");
// /authentication/details returns NO credit headers — absence must never read
// as "no credits left"
assert.deepEqual(credits.readBeds24Credits(() => null),
  { remaining: null, resetsInSec: null, cost: null }, "a meterless response is null, not zero");
assert.equal(credits.evaluateBeds24Credits(credits.readBeds24Credits(() => null)), null,
  "a meterless response never triggers a pause");
ok("meter: the live header set parses exactly; an absent meter is null, never a pause");

// ---- the threshold is DERIVED from the measurement, not chosen by feel ----
assert.equal(credits.BEDS24_CREDIT_CEILING, 100, "documented account ceiling");
assert.equal(credits.BEDS24_MEASURED_CALL_COST, 1.2, "the live-measured cost of one call");
assert.equal(
  credits.BEDS24_LOW_CREDIT_THRESHOLD,
  10 * credits.BEDS24_MEASURED_CALL_COST,
  "threshold = 10 calls of headroom at the measured cost (see the derivation in beds24-credits.ts)",
);
assert.ok(credits.BEDS24_LOW_CREDIT_THRESHOLD < credits.BEDS24_CREDIT_CEILING / 4,
  "the threshold reserves a minority of the window — it paces, it does not stall");
ok(`threshold: ${credits.BEDS24_LOW_CREDIT_THRESHOLD} credits = 10 × measured cost ${credits.BEDS24_MEASURED_CALL_COST} (${credits.BEDS24_CREDIT_CEILING}-credit ceiling)`);

// ---- (a) low Remaining, at the decision level ----
const lowSnap = { remaining: 8.4, resetsInSec: 137, cost: 1.2 };
const lowPause = credits.evaluateBeds24Credits(lowSnap);
assert.equal(lowPause?.reason, "low_credits", "below the threshold → a pause, not a retry");
assert.equal(lowPause.waitMs, 137_000, "the wait comes from ResetsIn, not from a constant");
assert.equal(credits.evaluateBeds24Credits({ remaining: 12, resetsInSec: 137, cost: 1.2 }), null,
  "exactly at the threshold still flows (strictly-below is the gate)");
// no ResetsIn → one full window, never zero (a zero wait IS a blind retry)
assert.equal(credits.evaluateBeds24Credits({ remaining: 1, resetsInSec: null, cost: null }).waitMs,
  credits.BEDS24_CREDIT_WINDOW_MS, "a missing ResetsIn falls back to one whole window");
ok("(a) low Remaining → pause whose length is the provider's own ResetsIn");

// ---- (b) HTTP 429, its own path ----
const rl = credits.evaluateBeds24Credits({ remaining: 45, resetsInSec: 90, cost: 1.2 },
  { httpStatus: 429 });
assert.equal(rl?.reason, "rate_limited",
  "429 pauses even while Remaining still looks healthy (45 > threshold)");
assert.equal(rl.waitMs, 90_000, "no Retry-After → the cooldown is the credit window's ResetsIn");
const rlRetryAfter = credits.evaluateBeds24Credits({ remaining: 45, resetsInSec: 90, cost: 1.2 },
  { httpStatus: 429, retryAfterMs: 30_000 });
assert.equal(rlRetryAfter.waitMs, 30_000, "Retry-After wins when Beds24 sends one");
assert.ok(credits.evaluateBeds24Credits({ remaining: null, resetsInSec: null, cost: null },
  { httpStatus: 429 }).waitMs >= 1_000, "a bare 429 still never retries immediately");
ok("(b) 429 → its own path: Retry-After when sent, else ResetsIn, never an instant retry");

// ---- the gate: one pause per run, longest wait wins ----
const gate = credits.createBeds24CreditGate();
assert.equal(gate.observe({ remaining: 97.6, resetsInSec: 155, cost: 1.2 }), null, "healthy → flows");
assert.equal(gate.pause, null, "no pause while the window has room");
gate.observe({ remaining: 45, resetsInSec: 20, cost: 1.2 }, { httpStatus: 429 });
assert.equal(gate.pause.waitMs, 20_000, "the 429 set the pause");
gate.observe({ remaining: 2, resetsInSec: 5, cost: 1.2 });
assert.equal(gate.pause.waitMs, 20_000, "a shorter later reading never shortens a live pause");
assert.equal(gate.last.remaining, 2, "the newest meter reading is still surfaced for diagnostics");
// B2 GAP (g25): the assertion above is satisfied by "the FIRST pause wins" just
// as well as by "the LONGEST pause wins" — replacing the comparison with
// `pause === null` kept the whole check green. The rule only has teeth in the
// other direction: a later reading that states a LONGER provider wait must
// EXTEND the live pause, or the run resumes while the window is still shut.
gate.observe({ remaining: 1, resetsInSec: 200, cost: 1.2 });
assert.equal(gate.pause.waitMs, 200_000,
  "a LATER, LONGER provider-stated wait must EXTEND the live pause — 'longest wins', not 'first wins'");
assert.equal(gate.pause.reason, "low_credits", "and the extending reading owns the pause it set");
ok("gate: the longest provider-stated wait wins for the whole run — it extends as well as resists shortening");

// ---- the §16 breaker honours a credit pause as a rate limit ----
assert.equal(breaker.failureKindOf("credit_paused"), "rate_limited",
  "a credit pause is breaker-equivalent to a 429 (provider-stated cooldown, not exponential)");
const opened = breaker.onCircuitFailure(breaker.CLOSED, breaker.failureKindOf("credit_paused"),
  1_000_000, { retryAfterMs: 137_000 });
assert.equal(opened.openUntil, 1_137_000,
  "the connection stops calling for exactly the credit window's remaining span");
ok("breaker: a credit pause opens the circuit for exactly the ResetsIn span");

// ============================================================
// DB-backed: the gate really runs inside the worker's own pull path.
// The fake Beds24 serves the REAL headers; a page walk that ignores the meter
// burns MAX_PAGES (50) calls = 60 credits = 60% of the whole window.
// ============================================================
const PROPERTY = "999002";
const B24_ROOM = "707200";
const day = (o) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);

/** what the fake serves next: null = a healthy 200, otherwise a scripted mode */
let mode = { kind: "healthy", remaining: 97.6, resetsIn: 155 };
let calls = 0;
const booking = (id) => ({
  id: Number(id), status: "new", propertyId: Number(PROPERTY), roomId: Number(B24_ROOM),
  arrival: day(5), departure: day(7), price: 500, currency: "ILS",
  modifiedTime: "2026-07-24T10:00:00Z", channel: "booking", apiReference: `ref-${id}`,
  firstName: "בדיקה", lastName: `אורח-${id}`,
});
const meter = (remaining, resetsIn, cost = 1.2) => ({
  // THE REAL WIRE NAMES — a reader that looks for anything else sees nothing
  "x-five-min-limit-remaining": String(remaining),
  "x-five-min-limit-resets-in": String(resetsIn),
  "x-request-cost": String(cost),
  "content-type": "application/json",
});
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  assert.equal(u.host, "api.beds24.com", `unexpected outbound host: ${u.host}`);
  calls += 1;
  if (mode.kind === "rate_limited") {
    // a real Beds24 429 carries the meter and NO Retry-After
    return new Response(JSON.stringify({ success: false }), {
      status: 429, headers: meter(mode.remaining, mode.resetsIn),
    });
  }
  const idFilter = u.searchParams.get("id");
  const rows = idFilter ? [booking(idFilter)] : [booking(880000 + calls)];
  return new Response(
    // nextPageExists is ALWAYS true: an ungated walker keeps going to MAX_PAGES
    JSON.stringify({ success: true, data: rows, pages: { nextPageExists: !idFilter } }),
    { status: 200, headers: meter(mode.remaining, mode.resetsIn) },
  );
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const slug = `b24-credits-${Date.now()}`;
let tenantId;
let outTenantId;

try {
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('Beds24 Credit Check', ${slug}) RETURNING id`;
  tenantId = tenant.id;
  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenantId}, 'Credit Type', 400) RETURNING id`;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
    VALUES (${tenantId}, 'B24-C1', ${rt.id}, 'available', true) RETURNING id`;
  const [conn] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at,
       last_inbound_import_at)
    VALUES
      (${tenantId}, 'beds24', 'production', 'active', true,
       true, true, false,
       ${encryptSecret("check-refresh-token")}, ${encryptSecret("check-access-token")},
       now() + interval '12 hours', now())
    RETURNING id, tenant_id, api_key_ciphertext, access_token_ciphertext,
              access_token_expires_at, last_inbound_import_at`;
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, status)
    VALUES (${tenantId}, ${conn.id}, ${PROPERTY}, ${B24_ROOM}, ${room.id}, 'mapped')`;
  const inbound = { ...conn, last_inbound_import_at: new Date() };

  // ---- control: a healthy window is NOT throttled ----
  mode = { kind: "healthy", remaining: 97.6, resetsIn: 155 };
  calls = 0;
  let summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal(summary.creditPause, null, "a healthy window never pauses");
  assert.ok(calls > 1, `a healthy walk keeps paging (calls=${calls})`);
  assert.equal(summary.credits.remaining, 97.6,
    "the meter reached the summary — proof the REAL header names are read end to end");
  assert.equal(summary.credits.cost, 1.2, "the per-request cost reached the summary");
  ok(`control: a healthy window pages freely (${calls} calls) and reports the live meter`);

  // ---- (a) DB-backed low Remaining: the walk stops after ONE page ----
  mode = { kind: "healthy", remaining: 8.4, resetsIn: 137 };
  calls = 0;
  summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal(calls, 1, `low credits must stop the page walk after ONE call (got ${calls})`);
  assert.equal(summary.creditPause?.reason, "low_credits", "the pull reports WHY it stopped");
  assert.equal(summary.creditPause.waitMs, 137_000, "the wait is the provider's ResetsIn");
  assert.ok(summary.errors.some((e) => e.includes("קרדיטים")),
    "the operator-visible reason is the Hebrew credit message, never an upstream body");
  ok("(a) low Remaining: the real pull path stops after one call instead of walking 50");

  // ---- (b) DB-backed 429: its own path, cooldown from ResetsIn ----
  mode = { kind: "rate_limited", remaining: 0, resetsIn: 90 };
  calls = 0;
  summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal(calls, 1, `a 429 must stop the walk immediately (got ${calls} calls)`);
  assert.equal(summary.creditPause?.reason, "rate_limited", "429 is its own reported reason");
  assert.equal(summary.creditPause.waitMs, 90_000,
    "no Retry-After → the cooldown is the credit window's ResetsIn, not a blind retry");
  ok("(b) HTTP 429: the real pull path stops at once and waits the ResetsIn span");

  // ---- the 20-minute reconciliation sweep obeys the same gate ----
  const [guest] = await sql`
    INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name)
    VALUES (${tenantId}, 'בדיקת', 'קרדיט', 'בדיקת קרדיט') RETURNING id`;
  for (let i = 0; i < 3; i++) {
    await sql`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, check_in, check_out,
         status, total_price, channel_connection_id, external_booking_id)
      VALUES (${tenantId}, ${`CRD-${i}`}, ${guest.id}, ${day(3)}, ${day(5)},
              'confirmed', 500, ${conn.id}, ${`77000${i}`})`;
  }
  mode = { kind: "healthy", remaining: 5.5, resetsIn: 60 };
  calls = 0;
  const rec = await imp.runBeds24BookingReconciliation(sql, inbound);
  assert.equal(calls, 1,
    `the reconciliation sweep must stop after the first low-credit reading (got ${calls})`);
  assert.equal(rec.creditPause?.reason, "low_credits", "the sweep reports the pause");
  assert.equal(rec.creditPause.waitMs, 60_000, "and waits the provider's ResetsIn");
  ok("reconciliation: the 50-reservation sweep yields on the same gate (1 call, not 3)");

  // ============================================================
  // OUTBOUND — the ARI drain, the half this check used to leave uncovered.
  //
  // Everything above exercises the INBOUND pull. The outbound gate lives in
  // drainBeds24AriDirtyRanges, and until this section existed the entire
  // outbound gate could be deleted with all assertions still green — the check
  // was leaning on the pure module plus the pull path. Every assertion below
  // reads the DATABASE after a real drain: what happened to the claimed range,
  // not what the source says.
  // ============================================================
  // A tenant may hold ONE beds24/production connection (unique constraint), so
  // the outbound half gets its own tenant — the inbound fixtures above stay
  // untouched and both are cleaned up together.
  const OUT_TOKEN = "check-credit-outbound-token";
  const OUT_ROOM = "707310";
  const [otenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES ('Beds24 Credit Outbound', ${`${slug}-out`}, 'Asia/Jerusalem', 'ILS') RETURNING id`;
  outTenantId = otenant.id;
  const [ort] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${outTenantId}, 'Outbound Type', 400) RETURNING id`;
  const [oroom] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
    VALUES (${outTenantId}, 'B24-OUT', ${ort.id}, 'available', true) RETURNING id`;
  const [osu] = await sql`
    INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
    VALUES (${outTenantId}, 'B24-OUT', 'יחידת יוצא', ${ort.id}) RETURNING id`;
  await sql`
    INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
    VALUES (${outTenantId}, ${osu.id}, ${oroom.id})`;
  await sql`
    INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
    VALUES (${outTenantId}, ${osu.id}, 'base', 'מחיר בסיס', true, 'base')`;
  const [oplan] = await sql`
    INSERT INTO guesthub.pricing_plans
      (tenant_id, sellable_unit_id, code, name, plan_kind, is_active, is_archived, is_visible_channels)
    VALUES (${outTenantId}, NULL, 'beds24-out', 'תוכנית ערוץ', 'base', true, false, true) RETURNING id`;
  await sql`
    INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
    VALUES (${outTenantId}, ${oplan.id}, ${osu.id}, true)`;
  for (let d = 0; d <= 30; d++) {
    await sql`
      INSERT INTO guesthub.pricing_plan_unit_rates
        (tenant_id, pricing_plan_id, sellable_unit_id, date, price, min_stay_arrival)
      VALUES (${outTenantId}, ${oplan.id}, ${osu.id}, ${day(d)}, 512.5, 2)`;
  }
  const [oconn] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at)
    VALUES (${outTenantId}, 'beds24', 'production', 'active', true, false, true, false,
            ${encryptSecret("check-refresh-token")}, ${encryptSecret(OUT_TOKEN)},
            now() + interval '12 hours')
    RETURNING id`;
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, local_rate_plan_id, status)
    VALUES (${outTenantId}, ${oconn.id}, ${PROPERTY}, ${OUT_ROOM}, ${oroom.id}, ${oplan.id}, 'mapped')`;

  /** how the calendar mock answers: status + the meter it carries */
  let push = { status: 201, remaining: 97.6, resetsIn: 155 };
  let pushCalls = 0;
  const pushFetch = async (url) => {
    pushCalls += 1;
    assert.equal(new URL(String(url)).host, "api.beds24.com", "outbound must stay on Beds24");
    const h = meter(push.remaining, push.resetsIn);
    // Beds24 normally sends NO Retry-After; the scripted cases that DO set one
    // prove the HTTP core prefers it over the credit window's resets-in.
    if (push.retryAfterSec !== undefined) h["retry-after"] = String(push.retryAfterSec);
    if (push.status !== 201) {
      return new Response(JSON.stringify({ success: false }), { status: push.status, headers: h });
    }
    // a 200/201 that Beds24 qualified: the write landed, but not intact
    if (push.warnings) {
      return new Response(
        JSON.stringify([{ success: true, warnings: [{ field: "minStay" }], roomId: Number(OUT_ROOM) }]),
        { status: 201, headers: h },
      );
    }
    return new Response(
      JSON.stringify([{ success: true, modified: { field: "price1" }, roomId: Number(OUT_ROOM) }]),
      { status: 201, headers: h },
    );
  };
  const loadOut = async () => {
    const cs = await ari.loadDrainableBeds24Connections(sql);
    const c = cs.find((x) => x.id === oconn.id);
    assert.ok(c, "the outbound connection is drainable");
    return c;
  };
  const markDirty = async (from, to) => {
    const [row] = await sql`
      INSERT INTO guesthub.channel_dirty_ranges
        (tenant_id, connection_id, room_id, kind, date_from, date_to, status, attempts, next_attempt_at)
      VALUES (${outTenantId}, ${oconn.id}, ${oroom.id}, 'availability', ${from}, ${to}, 'pending', 0, now())
      RETURNING id`;
    return row.id;
  };
  const rangeRow = async (id) => (await sql`
    SELECT status, attempts, last_error_code,
           (next_attempt_at > now() + interval '60 seconds') AS deferred_past_a_minute
    FROM guesthub.channel_dirty_ranges WHERE id = ${id}`)[0];
  const connRow = async () => (await sql`
    SELECT last_error, consecutive_failures,
           GREATEST(0, EXTRACT(EPOCH FROM (circuit_open_until - now()))) AS open_for_sec
    FROM guesthub.channel_connections WHERE id = ${oconn.id}`)[0];
  const lastEvidence = async () => (await sql`
    SELECT outcome, error_code, context FROM guesthub.channel_evidence_ledger
    WHERE connection_id = ${oconn.id} ORDER BY created_at DESC, id DESC LIMIT 1`)[0];
  /** the operator-facing error row — the ONE place the pause's REASON is named
   *  (the evidence ledger records every pause as 'credit_paused') */
  const lastSyncError = async () => (await sql`
    SELECT error_code, created_at FROM guesthub.channel_sync_errors
    WHERE connection_id = ${oconn.id} ORDER BY created_at DESC, id DESC LIMIT 1`)[0];
  /** fixture management, never an assertion: the cooldown has elapsed */
  const rearm = (id) => sql`
    UPDATE guesthub.channel_dirty_ranges SET next_attempt_at = now() WHERE id = ${id}`.then(() =>
    sql`UPDATE guesthub.channel_connections
        SET circuit_open_until = NULL, consecutive_failures = 0, last_error = NULL
        WHERE id = ${oconn.id}`);
  const drain = async () => ari.drainBeds24AriDirtyRanges(sql, await loadOut(), { fetchImpl: pushFetch });

  // ---- outbound control: a healthy window really pushes and really syncs ----
  push = { status: 201, remaining: 97.6, resetsIn: 155 };
  pushCalls = 0;
  let dr = await markDirty(day(10), day(14));
  let s = await drain();
  assert.equal(pushCalls, 1, `the drain must actually POST the calendar (got ${pushCalls})`);
  assert.equal(s.synced, 1, `a healthy window syncs the range (got ${JSON.stringify(s)})`);
  assert.equal((await rangeRow(dr)).status, "synced", "the claimed range completes");
  ok("outbound control: a healthy window pushes the calendar and syncs the range");

  // ---- outbound (a): low Remaining on a SUCCESSFUL response ----
  // The push succeeded, but the meter says the window is nearly spent. The
  // claimed range must NOT be marked synced-and-forgotten and must NOT be
  // charged an attempt: it is re-armed for after the provider's own reset, and
  // the breaker is held for that span. Deleting the outbound gate marks it
  // 'synced' instead — which is exactly what this assertion catches.
  push = { status: 201, remaining: 8.4, resetsIn: 137 };
  await rearm(dr);
  dr = await markDirty(day(15), day(18));
  s = await drain();
  let row = await rangeRow(dr);
  assert.equal(row.status, "pending",
    `a credit pause must leave the claimed range PENDING for the next window (got '${row.status}' — the outbound credit gate is not running)`);
  assert.equal(row.attempts, 0,
    "a credit pause is not a range failure — it may never consume an attempt");
  assert.equal(row.deferred_past_a_minute, true,
    "the range is re-armed for after the provider's own resets-in, not for right now");
  assert.equal(s.creditPausedMs, 137_000,
    `the drain must report the provider-stated pause (got ${s.creditPausedMs} — the outbound credit gate is not running)`);
  let c = await connRow();
  assert.ok(Math.abs(Number(c.open_for_sec) - 137) <= 3,
    `the breaker holds the connection for the credit window's resets-in (open for ${c.open_for_sec}s, expected ~137s)`);
  let ev = await lastEvidence();
  assert.equal(ev.error_code, "credit_paused", "the evidence ledger names the pause");
  ok("outbound (a): low Remaining re-arms the claimed range without an attempt and holds the breaker for resets-in");

  // ---- outbound (D98): a REAL failure carrying a low meter is STILL a failure
  // Every response feeds the gate, the failing ones included. A 500 that merely
  // arrived while the meter read low must not be laundered into a credit pause:
  // it has to charge an attempt and record last_error, or a range that can
  // never succeed retries forever and never reaches max_attempts.
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE id = ${dr}`;
  await rearm(dr);
  push = { status: 500, remaining: 8.4, resetsIn: 137 };
  const bad = await markDirty(day(20), day(23));
  await drain();
  row = await rangeRow(bad);
  assert.equal(row.attempts, 1,
    `a 500 must charge an attempt even when the credit meter is low (got attempts=${row.attempts} — the credit pause swallowed a real provider failure, D98)`);
  assert.equal(row.last_error_code, "server_error",
    `the range records the REAL provider error, not the pause (got '${row.last_error_code}')`);
  c = await connRow();
  assert.ok(c.last_error !== null,
    "the connection surfaces the provider failure to the operator, not a credit message");
  ev = await lastEvidence();
  assert.equal(ev.outcome, "failed",
    `the evidence ledger records a FAILED outbound run, not a partial credit pause (got '${ev.outcome}')`);
  assert.equal(ev.error_code, "server_error", "with the provider's own error code");
  assert.ok(Math.abs(Number(c.open_for_sec) - 137) <= 3,
    `and the connection is still held for the credit window (open for ${c.open_for_sec}s) — charged AND paced`);
  ok("outbound (D98): a 500 arriving on a low meter still charges an attempt and records the real error");

  // ---- outbound (D98): the dead letter still exists ----
  // The end state the swallowed failure destroyed: a permanently-failing range
  // must stop retrying. Five drains, max_attempts=5 → status 'failed'.
  push = { status: 500, remaining: 8.4, resetsIn: 137 };
  const doomed = await markDirty(day(25), day(28));
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE id = ${bad}`;
  const before = pushCalls;
  for (let i = 0; i < 8; i++) {
    await rearm(doomed);
    await drain();
  }
  row = await rangeRow(doomed);
  assert.equal(row.status, "failed",
    `a permanently-failing range must dead-letter (got '${row.status}', attempts=${row.attempts}) — an unbounded retry burns the very credits the pause exists to protect`);
  assert.equal(row.attempts, 5, "it dead-letters at max_attempts, no later");
  assert.ok(pushCalls - before <= 5,
    `and the drain stops calling Beds24 once the range is dead (issued ${pushCalls - before} calls over 8 scheduler passes)`);
  ok("outbound (D98): a permanently-failing range still reaches the dead letter at max_attempts");

  // ============================================================
  // g25 — THE SLOWDOWN ITSELF. Everything above claims the drain "stops", but
  // every outbound fixture so far compresses into exactly ONE request body, so
  // the loop never reaches a second iteration and the burst-stop
  //     if (gate.pause) { deferred += …; break; }
  // could be turned into `if (gate.pause && false)` with all 15 assertions
  // still green. A gate that is never asked to stop a BURST is not a gate.
  //
  // So: 131 consecutive days priced in an alternating pattern. Range
  // compression cannot collapse them (neighbouring days differ), giving 131
  // calendar ranges = 2 request bodies at CALENDAR_ENTRIES_PER_REQUEST=100.
  // The control below PROVES the payload really needs two calls; the low-meter
  // run then has to issue exactly one.
  // ============================================================
  const BURST_FROM = 40, BURST_TO = 171; // date_to is exclusive → days 40..170
  await sql`
    INSERT INTO guesthub.pricing_plan_unit_rates
      (tenant_id, pricing_plan_id, sellable_unit_id, date, price, min_stay_arrival)
    SELECT ${outTenantId}, ${oplan.id}, ${osu.id},
           -- anchored on the SAME day() basis the fixtures use, never current_date
           (${day(0)}::date + d)::date,
           -- alternating price: consecutive days can never compress into one range
           CASE WHEN d % 2 = 0 THEN 500.00 ELSE 501.50 END,
           2
    FROM generate_series(${BURST_FROM}::int, ${BURST_TO - 1}::int) AS d`;

  // ---- control: the burst really is more than one request ----
  push = { status: 201, remaining: 97.6, resetsIn: 155 };
  await rearm(doomed);
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'failed' WHERE id = ${doomed}`;
  let burst = await markDirty(day(BURST_FROM), day(BURST_TO));
  pushCalls = 0;
  s = await drain();
  assert.ok(pushCalls >= 2,
    `the burst fixture must need MORE THAN ONE request or the burst-stop is untestable (got ${pushCalls})`);
  assert.equal(s.synced, 1, `a healthy window still completes the burst (got ${JSON.stringify(s)})`);
  const burstRequests = pushCalls;
  ok(`burst control: 131 uncompressible days = ${burstRequests} request bodies, all sent on a healthy window`);

  // ---- the burst-stop: ONE low reading ends the run mid-burst ----
  push = { status: 201, remaining: 8.4, resetsIn: 137 };
  await rearm(burst);
  burst = await markDirty(day(BURST_FROM), day(BURST_TO));
  pushCalls = 0;
  s = await drain();
  assert.equal(pushCalls, 1,
    `the FIRST low-credit response must end the burst: expected 1 call, got ${pushCalls} of ${burstRequests} — the outbound burst-stop is not running`);
  assert.equal(s.requests, 1, "and the run reports the single call it actually made");
  row = await rangeRow(burst);
  assert.equal(row.status, "pending", "the half-sent range stays claimable for the next window");
  assert.equal(row.attempts, 0, "a burst cut short by credits is still not a range failure");
  ev = await lastEvidence();
  assert.equal(Number(ev.context.deferredBatches), burstRequests - 1,
    `the evidence ledger records the request bodies the gate held back (got ${ev.context.deferredBatches}, expected ${burstRequests - 1}) — 0 means the run never stopped`);
  assert.equal(Number(ev.context.creditsRemaining), 8.4,
    "with the meter reading that caused it, off the row the worker wrote");
  ok(`burst-stop: the drain issued 1 of ${burstRequests} request bodies and deferred the rest`);

  // ============================================================
  // g25 — THE OUTBOUND 429. Every outbound scenario above answers 201 or 500,
  // so nothing ever fed `httpStatus: 429` to the gate from the calendar sender:
  // deleting that wiring (`res.category === "rate_limited"` → false) left all
  // 15 assertions green. The discriminating fixture answers 429 while the meter
  // still reads HEALTHY (45 ≫ threshold 12) — then ONLY the 429 path can
  // produce a pause, and a run that charges the range an attempt has treated a
  // provider-stated cooldown as an ordinary failure.
  // ============================================================
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE id = ${burst}`;
  push = { status: 429, remaining: 45, resetsIn: 90 };
  await rearm(burst);
  const throttled = await markDirty(day(3), day(6));
  pushCalls = 0;
  s = await drain();
  assert.equal(pushCalls, 1, `a 429 must end the outbound run at once (got ${pushCalls} calls)`);
  assert.equal(s.creditPausedMs, 90_000,
    `an outbound 429 must pause for the provider's own span even on a HEALTHY meter (got ${s.creditPausedMs} — the 429 never reached the credit gate)`);
  row = await rangeRow(throttled);
  assert.equal(row.attempts, 0,
    `a 429 is a provider-stated cooldown, not a range failure: attempts must stay 0 (got ${row.attempts})`);
  assert.equal(row.status, "pending", "and the range is still claimable after the cooldown");
  assert.equal(row.deferred_past_a_minute, true, "re-armed for after the 429's own span");
  ev = await lastEvidence();
  assert.equal(ev.outcome, "partial",
    `a 429 is a pause, not a failed run (got '${ev.outcome}' — the 429 never reached the credit gate)`);
  assert.equal(ev.error_code, "credit_paused", "the ledger files it under the credit pause");
  assert.equal((await lastSyncError()).error_code, "rate_limited",
    "and the operator-facing error names the 429 itself, not a generic low-credit slowdown");
  c = await connRow();
  assert.ok(Math.abs(Number(c.open_for_sec) - 90) <= 3,
    `the breaker holds the connection for the 429's span (open for ${c.open_for_sec}s, expected ~90s)`);
  ok("outbound 429: a healthy meter plus a 429 still pauses — the refusal reaches the gate");

  // ---- and Retry-After outranks the credit window, end to end ----
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE id = ${throttled}`;
  push = { status: 429, remaining: 45, resetsIn: 240, retryAfterSec: 30 };
  await rearm(throttled);
  const withRetryAfter = await markDirty(day(3), day(6));
  pushCalls = 0;
  s = await drain();
  assert.equal(s.creditPausedMs, 30_000,
    `Retry-After (30s) must outrank the credit window's resets-in (240s) through the REAL HTTP core (got ${s.creditPausedMs})`);
  assert.equal((await rangeRow(withRetryAfter)).attempts, 0, "still not a range failure");
  c = await connRow();
  assert.ok(Math.abs(Number(c.open_for_sec) - 30) <= 3,
    `and the breaker holds for Retry-After, not for resets-in (open for ${c.open_for_sec}s, expected ~30s)`);
  ok("outbound 429: Retry-After beats resets-in through the real HTTP core");

  // ---- g25: the pause may not swallow PARTIAL WARNINGS either (D98's sibling)
  // `warnings.length === 0` is the third conjunct of the pause condition and no
  // fixture ever produced a warning, so it could be replaced by `true` with
  // everything green. A qualified write (200 + per-room warnings) that happens
  // to arrive on a low meter must still be charged and surfaced as
  // partial_warnings — otherwise the operator never learns the calendar landed
  // incomplete, and the range is re-armed as if nothing was wrong.
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE id = ${withRetryAfter}`;
  push = { status: 201, remaining: 8.4, resetsIn: 137, warnings: true };
  await rearm(withRetryAfter);
  const qualified = await markDirty(day(3), day(6));
  s = await drain();
  row = await rangeRow(qualified);
  assert.equal(row.attempts, 1,
    `a qualified write on a low meter must still be charged an attempt (got ${row.attempts} — the credit pause swallowed the warnings)`);
  assert.equal(row.last_error_code, "partial_warnings",
    `the range records that the calendar landed incomplete (got '${row.last_error_code}')`);
  assert.equal((await lastSyncError()).error_code, "partial_warnings",
    "and the operator sees the warnings, not a credit-slowdown notice");
  ev = await lastEvidence();
  assert.equal(ev.error_code, "partial_warnings", "the ledger names the warnings too");
  c = await connRow();
  assert.ok(Math.abs(Number(c.open_for_sec) - 137) <= 3,
    `while the connection is still paced for the credit window (open for ${c.open_for_sec}s, expected ~137s)`);
  ok("outbound: a low meter never launders partial warnings into a silent credit pause");

  console.log(`\ncheck-beds24-credit-backoff: all ${n} assertions passed`);
} finally {
  for (const tid of [outTenantId, tenantId].filter(Boolean)) {
    const tenantId = tid;
    for (const t of [
      "channel_evidence_ledger", "channel_sync_errors", "channel_dirty_ranges",
      "channel_booking_revisions", "channel_sync_jobs", "channel_beds24_room_mappings",
      "channel_connections", "audit_logs", "reservation_rooms", "reservations", "guests",
      "pricing_plan_unit_rates", "pricing_plan_units", "pricing_plans",
      "sellable_unit_rooms", "sellable_units", "rooms", "room_types", "tenants",
    ]) {
      await sql.unsafe(
        t === "tenants"
          ? `DELETE FROM guesthub.tenants WHERE id = '${tenantId}'`
          : `DELETE FROM guesthub.${t} WHERE tenant_id = '${tenantId}'`,
      );
    }
  }
  await sql.end();
}
