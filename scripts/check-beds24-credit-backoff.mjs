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
// Usage: node scripts/check-beds24-credit-backoff.mjs
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

// ---- static: the wire names are the MEASURED ones, in exactly one place ----
const creditsSrc = readFileSync(join(ROOT, "src/lib/channel/beds24-credits.ts"), "utf8");
for (const header of [
  "x-five-min-limit-remaining",
  "x-five-min-limit-resets-in",
  "x-request-cost",
]) {
  assert.ok(creditsSrc.includes(`"${header}"`), `the measured header ${header} is declared`);
}
const httpSrc = readFileSync(join(ROOT, "src/lib/channel/beds24-http.ts"), "utf8");
assert.ok(
  !httpSrc.includes("fivemincreditlimit"),
  "the header name that never existed on the wire is gone from the HTTP core",
);
assert.match(httpSrc, /readBeds24Credits/, "the HTTP core reads the meter through the one reader");
ok("static: the measured Beds24 credit header names, declared once, read once");

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
ok("gate: the longest provider-stated wait wins for the whole run");

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

  console.log(`\ncheck-beds24-credit-backoff: all ${n} assertions passed`);
} finally {
  if (tenantId) {
    for (const t of [
      "channel_sync_errors", "channel_dirty_ranges", "channel_booking_revisions",
      "channel_sync_jobs", "channel_beds24_room_mappings", "channel_connections",
      "audit_logs", "reservation_rooms", "reservations", "guests", "rooms",
      "room_types", "tenants",
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
