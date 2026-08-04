#!/usr/bin/env node
// ============================================================
// check:beds24-failure-evidence — failures must carry their own evidence (D112).
//
// WHY. On 2026-07-28 reconstructing what Beds24 actually said took hours: the
// failure path mapped the response to a category string and DISCARDED the
// original. "(422)" was printed for a response that was HTTP 201, and the word
// that mattered — "invalid dates" — sat in a body field the code deliberately
// suppressed. This guard makes that class of defect red forever:
//
//   · C1 — every outbound calendar failure persists, on channel_sync_errors:
//     the HTTP status ACTUALLY received (verbatim), the raw response body
//     (unmodified, ≤2KB, explicit truncation marker), the request payload that
//     produced it, and a UTC timestamp. Captured BEFORE parsing: a non-JSON
//     error page must survive too.
//   · C2 — no printed value that was not on the response: the operator message
//     for a 2xx-with-success:false names the REAL status (201), never "422".
//   · C3 — the provider's own message text ("invalid dates") reaches the
//     operator-facing error message and the raw body is selected by the
//     /channels dashboard loader.
//
// B2-STYLE SENSITIVITY. Every assertion here reads the STORED row back from
// the DB after driving the real drain against a mock provider. Neutralising
// the persistence (dropping the columns from the INSERT, mapping the body away
// before storage, faking the status) while keeping the surrounding structure
// intact turns this guard red — the evidence is asserted on the row, not on
// the code path.
//
// Runs the REAL compiled worker modules against an isolated test DB (:5433,
// schema rebuilt from the full migration chain — which also proves migration
// 060 applies) and a substituted fetch. Nothing here touches production.
//
// Usage: node scripts/check-beds24-failure-evidence.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { join } from "node:path";
import postgres from "postgres";

const ROOT = process.cwd();
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
process.env.DATABASE_URL = TEST_URL;
process.env.CHANNEL_SECRETS_KEY = "check-beds24-failure-evidence-key";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

// ---- static: the persistence and the surface exist in the source ----
// (cheap tripwires; the REAL proof is the stored-row assertions below)
const queueSrc = readFileSync(join(ROOT, "src/lib/channel/queue.ts"), "utf8");
for (const col of ["http_status", "response_body", "response_truncated", "request_payload", "response_received_at"]) {
  assert.match(queueSrc, new RegExp(col),
    `logChannelError must persist ${col} — a failure path that reports a category without the raw provider response is a defect (GUIDELINES)`);
}
const adminSrc = readFileSync(join(ROOT, "src/lib/channel/admin.ts"), "utf8");
assert.match(adminSrc, /http_status/, "the /channels dashboard loader selects http_status (C3 — surface it)");
assert.match(adminSrc, /response_body/, "the /channels dashboard loader selects response_body (C3 — surface it)");
ok("STATIC: the error-record INSERT and the operator dashboard SELECT both carry the raw evidence");

// ---- rebuild the schema from the tree under test's own migration chain ----
// (drop as supabase_admin — it owns the schema; the chain is replayable only
// on a virgin schema, see 054's rename)
console.log("rebuilding schema from the full migration chain…");
execSync(`psql "${TEST_URL}" -q -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS guesthub CASCADE;'`,
  { stdio: ["pipe", "ignore", "inherit"] });
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  execSync(`psql "${TEST_URL}" -q -v ON_ERROR_STOP=1 -f "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"] });
}
ok("FIXTURE: full migration chain applied from scratch (includes 062_channel_failure_evidence)");

// ---- compile the real worker graph and require it the worker's own way ----
execSync("pnpm exec tsc -p tsconfig.worker.json", { stdio: "inherit", cwd: ROOT });
const OUT = join(ROOT, "dist", "worker");
// beds24-properties / beds24-booking-reports sit OUTSIDE the worker graph
// (admin-action modules) — compile them into the same tree with the same
// options so the guard tests the real code, not a re-implementation.
// (`paths` has no CLI flag, so this goes through a transient tsconfig.)
const EXTRA_TSCONFIG = join(ROOT, "tsconfig.check-failure-evidence.tmp.json");
writeFileSync(EXTRA_TSCONFIG, JSON.stringify({
  extends: "./tsconfig.worker.json",
  include: [
    "src/lib/channel/beds24-properties.ts",
    "src/lib/channel/beds24-booking-reports.ts",
  ],
}));
try {
  execSync(`pnpm exec tsc -p "${EXTRA_TSCONFIG}"`, { stdio: "inherit", cwd: ROOT });
} finally {
  rmSync(EXTRA_TSCONFIG, { force: true });
}
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const require2 = createRequire(import.meta.url);
const ari = require2(join(OUT, "lib/channel/beds24-ari-sync.js"));
const props = require2(join(OUT, "lib/channel/beds24-properties.js"));
const reports = require2(join(OUT, "lib/channel/beds24-booking-reports.js"));
const inbound = require2(join(OUT, "lib/channel/beds24-booking-import.js"));
const { encryptSecret } = require2(join(OUT, "lib/channel/crypto.js"));

// ============================================================
// mock provider — each scenario states exactly what the wire said
// ============================================================
const ACCESS_TOKEN = "check-failure-evidence-access-token";
const PROPERTY = "999003";
const B24_ROOM = "707201";

const iso = (d) => d.toISOString().slice(0, 10);
const day = (offset) => iso(new Date(Date.now() + offset * 86_400_000));

/** the exact body TEXT the mock answered with, per calendar call, in order */
let wireBodies = [];
/** the request bodies (parsed) the drain POSTed, in order */
let sentPayloads = [];
let reply = { mode: "success" };

const creditHeaders = {
  "Content-Type": "application/json",
  "x-five-min-limit-remaining": "97.6",
  "x-five-min-limit-resets-in": "155",
  "x-request-cost": "1.2",
};

const fakeFetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.pathname === "/v2/authentication/token") {
    // scenario: the mint is rejected and the auth body says WHY
    const text = JSON.stringify({ error: "invalid refresh token", code: 401 });
    wireBodies.push(text);
    return new Response(text, { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (u.pathname === "/v2/properties") {
    return new Response(JSON.stringify({
      success: true,
      data: [{ id: Number(PROPERTY), roomTypes: [{ id: Number(B24_ROOM), maxStay: 365 }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  assert.equal(u.pathname, "/v2/inventory/rooms/calendar", `unexpected call: ${u.pathname}`);
  sentPayloads.push(JSON.parse(init.body));

  if (reply.mode === "network") throw new TypeError("fetch failed");

  let status = 201;
  let text;
  if (reply.mode === "invalid_dates_201") {
    // TODAY'S INCIDENT, verbatim shape: HTTP 201, per-item success:false, and
    // the word that matters inside errors[].message.
    text = JSON.stringify([{
      success: false,
      errors: [{ action: "process inventory rooms calendar", field: "numAvail", message: "invalid dates" }],
    }]);
  } else if (reply.mode === "huge_body") {
    text = JSON.stringify([{
      success: false,
      errors: [{ action: "process inventory rooms calendar", message: "invalid dates" }],
      padding: "x".repeat(4000),
    }]);
  } else if (reply.mode === "html_502") {
    status = 502;
    text = "<html><body><h1>502 Bad Gateway</h1>nginx</body></html>";
    wireBodies.push(text);
    return new Response(text, { status, headers: { "Content-Type": "text/html" } });
  } else {
    text = JSON.stringify([{ success: true, modified: { field: "price1" }, roomId: Number(B24_ROOM) }]);
  }
  wireBodies.push(text);
  return new Response(text, { status, headers: creditHeaders });
};

globalThis.fetch = async () => {
  throw new Error("the drain reached the REAL network — a substituted fetch was bypassed");
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const slug = `b24-evidence-${Date.now()}`;
let tenantId;

try {
  // ---- scaffold (same shape as check-beds24-ari-drain) ----
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES ('Failure Evidence Check', ${slug}, 'Asia/Jerusalem', 'ILS') RETURNING id`;
  tenantId = tenant.id;
  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenantId}, 'Evidence Type', 400) RETURNING id`;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
    VALUES (${tenantId}, 'EV-1', ${rt.id}, 'available', true) RETURNING id`;
  const [su] = await sql`
    INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
    VALUES (${tenantId}, 'EV-1', 'יחידה EV-1', ${rt.id}) RETURNING id`;
  await sql`
    INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
    VALUES (${tenantId}, ${su.id}, ${room.id})`;
  await sql`
    INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
    VALUES (${tenantId}, ${su.id}, 'base', 'מחיר בסיס', true, 'base')`;
  const [plan] = await sql`
    INSERT INTO guesthub.pricing_plans
      (tenant_id, sellable_unit_id, code, name, plan_kind, is_active, is_archived, is_visible_channels)
    VALUES (${tenantId}, NULL, 'beds24', 'תוכנית ערוץ', 'base', true, false, true) RETURNING id`;
  await sql`
    INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
    VALUES (${tenantId}, ${plan.id}, ${su.id}, true)`;
  for (let d = 0; d <= 40; d++) {
    await sql`
      INSERT INTO guesthub.pricing_plan_unit_rates
        (tenant_id, pricing_plan_id, sellable_unit_id, date, price, min_stay_arrival)
      VALUES (${tenantId}, ${plan.id}, ${su.id}, ${day(d)}, 512.5, 2)`;
  }
  const [connRow] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at)
    VALUES
      (${tenantId}, 'beds24', 'production', 'active', true,
       false, true, false,
       ${encryptSecret("check-refresh-token")}, ${encryptSecret(ACCESS_TOKEN)},
       now() + interval '12 hours')
    RETURNING id`;
  const connId = connRow.id;
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, local_rate_plan_id, status)
    VALUES (${tenantId}, ${connId}, ${PROPERTY}, ${B24_ROOM}, ${room.id}, ${plan.id}, 'mapped')`;

  const loadConn = async () => {
    const conns = await ari.loadDrainableBeds24Connections(sql);
    const c = conns.find((x) => x.id === connId);
    assert.ok(c, "the active, baselined connection is drainable");
    return c;
  };
  const markDirty = async (from, to) => {
    const [row] = await sql`
      INSERT INTO guesthub.channel_dirty_ranges
        (tenant_id, connection_id, room_id, kind, date_from, date_to, status, attempts, next_attempt_at)
      VALUES (${tenantId}, ${connId}, ${room.id}, 'availability', ${from}, ${to}, 'pending', 0, now())
      RETURNING id`;
    return row.id;
  };
  const resetBreaker = () => sql`
    UPDATE guesthub.channel_connections
    SET circuit_open_until = NULL, consecutive_failures = 0, last_error = NULL
    WHERE id = ${connId}`;
  const drain = async () => {
    wireBodies = [];
    sentPayloads = [];
    return ari.drainBeds24AriDirtyRanges(sql, await loadConn(), { fetchImpl: fakeFetch });
  };
  const lastError = async () => (await sql`
    SELECT error_code, error_message, http_status, response_body, response_truncated,
           request_payload, response_received_at, created_at
    FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${tenantId} ORDER BY created_at DESC, id DESC LIMIT 1`)[0];
  const lastEvidence = async () => (await sql`
    SELECT outcome, error_code, error_message, context
    FROM guesthub.channel_evidence_ledger
    WHERE tenant_id = ${tenantId} ORDER BY created_at DESC, id DESC LIMIT 1`)[0];

  // ============================================================
  // 1. TODAY'S INCIDENT — HTTP 201 + success:false + "invalid dates"
  // ============================================================
  reply = { mode: "invalid_dates_201" };
  await markDirty(day(10), day(14));
  const t0 = new Date();
  let summary = await drain();
  assert.equal(summary.synced, 0, "the rejected write never syncs");
  let err = await lastError();
  assert.ok(err, "a failure writes an error record");

  // C1 — the actual status, verbatim. THE regression: "(422)" for an HTTP 201.
  assert.equal(err.http_status, 201,
    `http_status must be the status ACTUALLY received (201), got ${err.http_status}`);
  // C1 — the raw body, unmodified, stored before parsing/mapping.
  assert.equal(err.response_body, wireBodies[0],
    "response_body must be the raw wire body, verbatim and unmodified");
  assert.ok(err.response_body.includes("invalid dates"),
    "the provider's own words survive on the stored body");
  assert.equal(err.response_truncated, false, "an under-2KB body is not marked truncated");
  // C1 — the request payload that produced it.
  assert.ok(err.request_payload, "the request payload that produced the failure is stored");
  assert.deepEqual(err.request_payload, sentPayloads[sentPayloads.length - 1],
    "request_payload is the exact batch that was POSTed");
  // C1 — a UTC timestamp taken at the moment of failure.
  assert.ok(err.response_received_at, "response_received_at is recorded");
  const dt = Math.abs(new Date(err.response_received_at).getTime() - t0.getTime());
  assert.ok(dt < 60_000, `response_received_at is the observation moment (Δ=${dt}ms)`);
  // the mapped category is DERIVED data kept ALONGSIDE — it never replaces the original
  assert.equal(err.error_code, "validation", "the derived category still exists beside the evidence");
  // C2 — no value that was not on the response: the message names 201, never 422.
  assert.ok(!String(err.error_message).includes("422"),
    `the message printed a status that was never received: ${err.error_message}`);
  assert.ok(String(err.error_message).includes("201"),
    "the message names the status actually received");
  // C3 — the provider's own message reaches the operator-facing error text.
  assert.ok(String(err.error_message).includes("invalid dates"),
    `the operator must see the provider's own words, got: ${err.error_message}`);
  // the evidence ledger carries the same raw evidence in its context
  const ev = await lastEvidence();
  assert.equal(ev.context.httpStatus, 201, "evidence-ledger context carries the verbatim status");
  assert.ok(String(ev.context.rawBody).includes("invalid dates"),
    "evidence-ledger context carries the raw body");
  ok("HTTP 201 + success:false: status verbatim (201, not 422), raw body + payload + UTC stamp stored, provider's words surfaced");

  // ============================================================
  // 2. truncation — >2KB body stores a verbatim 2048-char prefix + marker
  // ============================================================
  await resetBreaker();
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE tenant_id = ${tenantId}`;
  reply = { mode: "huge_body" };
  await markDirty(day(15), day(17));
  await drain();
  err = await lastError();
  assert.equal(err.http_status, 201);
  assert.equal(err.response_body.length, 2048, "the stored body is cut at exactly 2048 chars");
  assert.equal(err.response_body, wireBodies[0].slice(0, 2048),
    "the stored prefix is verbatim — truncated, never rewritten");
  assert.equal(err.response_truncated, true, "the truncation is explicitly marked");
  ok("oversize body: verbatim 2KB prefix + explicit truncation marker");

  // ============================================================
  // 3. capture happens BEFORE parsing — a non-JSON 502 page survives raw
  // ============================================================
  await resetBreaker();
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE tenant_id = ${tenantId}`;
  reply = { mode: "html_502" };
  await markDirty(day(18), day(20));
  await drain();
  err = await lastError();
  assert.equal(err.http_status, 502, "the 5xx status is stored verbatim");
  assert.equal(err.response_body, "<html><body><h1>502 Bad Gateway</h1>nginx</body></html>",
    "a non-JSON error page is stored raw — the evidence exists before (and despite) JSON parsing");
  assert.equal(err.error_code, "server_error", "the derived category rides alongside");
  ok("non-JSON 502 page: raw body captured before parsing, status verbatim");

  // ============================================================
  // 4. transport failure — nothing arrived, and the record says exactly that
  // ============================================================
  await resetBreaker();
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE tenant_id = ${tenantId}`;
  reply = { mode: "network" };
  await markDirty(day(21), day(23));
  await drain();
  err = await lastError();
  assert.equal(err.error_code, "network_error");
  assert.equal(err.http_status, null,
    "no response arrived — the status is NULL, never a fabricated number");
  assert.equal(err.response_body, null, "no body arrived — NULL, never a stand-in string");
  assert.ok(err.request_payload, "the payload that went unanswered is still stored");
  assert.ok(err.response_received_at, "the moment the transport failure was observed is stamped");
  ok("transport failure: explicit null status/body (absence recorded, never faked), payload + stamp still stored");

  // ============================================================
  // 5. FABRICATED STATUS — properties: a 200 without the property is a 200
  // ============================================================
  {
    const wire = JSON.stringify({
      success: true,
      data: [{ id: 111, name: "Somebody Else's Property", roomTypes: [] }],
      pages: { nextPageExists: false },
    });
    const missing = await props.getBeds24Property({
      token: ACCESS_TOKEN, baseUrl: "https://api.beds24.com/v2", id: "999777",
      fetchImpl: async () => new Response(wire, { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    assert.equal(missing.ok, false, "a missing property is a failure");
    assert.equal(missing.httpStatus, 200,
      `the wire said 200 — a fabricated 404 is forbidden (got ${missing.httpStatus})`);
    assert.ok(/HTTP 200/.test(missing.message) && !missing.message.includes("404"),
      `the message must name the status actually received, got: ${missing.message}`);
    assert.equal(missing.raw?.body, wire, "the listing that lacked the property is kept verbatim");

    // bad_response on a 2xx: the "unexpected" body IS the evidence
    const weird = JSON.stringify({ success: false, error: "maintenance window" });
    const bad = await props.getBeds24Property({
      token: ACCESS_TOKEN, baseUrl: "https://api.beds24.com/v2", id: "999777",
      fetchImpl: async () => new Response(weird, { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.category, "bad_response");
    assert.equal(bad.raw?.body, weird, "the unexpected body rides on the failure, verbatim");
    ok("properties: missing-from-200 reports HTTP 200 (never a fabricated 404); the unexpected body is kept");
  }

  // ============================================================
  // 6. FABRICATED STATUS — booking reports: no HTTP call ⇒ no status printed
  // ============================================================
  {
    let calls = 0;
    const invalid = await reports.reportBeds24BookingStatus(
      { fetchImpl: async () => { calls += 1; throw new Error("must not be called"); } },
      { token: ACCESS_TOKEN, baseUrl: "https://api.beds24.com/v2", bookingId: "not-a-number", action: "invalid_card" },
    );
    assert.equal(calls, 0, "an invalid booking id never reaches the network");
    assert.equal(invalid.ok, false);
    assert.ok(!invalid.message.includes("422"),
      `no HTTP happened — printing a status is fabrication: ${invalid.message}`);
    assert.equal(invalid.raw?.httpStatus, null, "the evidence records that no response exists");

    const html = "<html>502 from a proxy</html>";
    const wireFail = await reports.reportBeds24BookingStatus(
      { fetchImpl: async () => new Response(html, { status: 502, headers: { "Content-Type": "text/html" } }) },
      { token: ACCESS_TOKEN, baseUrl: "https://api.beds24.com/v2", bookingId: "12345", action: "invalid_card" },
    );
    assert.equal(wireFail.ok, false);
    assert.equal(wireFail.httpStatus, 502);
    assert.ok(/HTTP 502/.test(wireFail.message), `the printed status is the wire's: ${wireFail.message}`);
    assert.equal(wireFail.raw?.body, html, "the raw 502 page rides on the failure");
    ok("booking reports: local rejection prints no status; a wire failure prints the wire's own");
  }

  // ============================================================
  // 7. TOKEN EVIDENCE PERSISTED — the auth body that says WHY lands on the record
  // ============================================================
  {
    await resetBreaker();
    await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE tenant_id = ${tenantId}`;
    await sql`UPDATE guesthub.channel_connections
              SET access_token_expires_at = now() - interval '1 hour' WHERE id = ${connId}`;
    reply = { mode: "success" }; // the mint 401s at the router before any calendar call
    await markDirty(day(25), day(27));
    await drain();
    const [tokErr] = await sql`
      SELECT error_code, error_message, http_status, response_body, response_received_at
      FROM guesthub.channel_sync_errors
      WHERE tenant_id = ${tenantId} AND error_code = 'credentials_unauthorized'
      ORDER BY created_at DESC LIMIT 1`;
    assert.ok(tokErr, "a credential failure writes an error record (it used to leave none)");
    assert.equal(tokErr.http_status, 401, "the auth status is stored verbatim");
    assert.ok(String(tokErr.response_body).includes("invalid refresh token"),
      "the auth body that explains WHY the token was rejected is persisted");
    assert.ok(/HTTP 401/.test(tokErr.error_message) ,
      `the operator message names the wire status: ${tokErr.error_message}`);
    assert.ok(tokErr.response_received_at, "the observation moment is stamped");
    // restore the working credential state for the next scenario
    await sql`UPDATE guesthub.channel_connections
              SET access_token_expires_at = now() + interval '12 hours' WHERE id = ${connId}`;
    await sql`UPDATE guesthub.channel_sync_errors SET resolved_at = now()
              WHERE tenant_id = ${tenantId} AND error_code = 'credentials_unauthorized'`;
    await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE tenant_id = ${tenantId}`;
    ok("token failure: 401 + the provider's own reason persisted on the error record via the drain");
  }

  // ============================================================
  // 8. INBOUND PULL EVIDENCE PERSISTED — a broken /bookings poll leaves a record
  // ============================================================
  {
    const [row] = await sql`
      SELECT id, tenant_id, api_key_ciphertext, access_token_ciphertext,
             access_token_expires_at, last_inbound_import_at
      FROM guesthub.channel_connections WHERE id = ${connId}`;
    const proxyPage = "<html>503 upstream unavailable</html>";
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      assert.ok(u.pathname.startsWith("/v2/bookings"), `unexpected pull call: ${u.pathname}`);
      return new Response(proxyPage, { status: 503, headers: { "Content-Type": "text/html" } });
    };
    try {
      await inbound.runBeds24InboundPull(sql, row);
      await inbound.runBeds24InboundPull(sql, row); // dedup: still ONE unresolved row
    } finally {
      globalThis.fetch = prevFetch;
    }
    const pullErrs = await sql`
      SELECT http_status, response_body FROM guesthub.channel_sync_errors
      WHERE tenant_id = ${tenantId} AND error_code = 'inbound_pull_server_error'
        AND resolved_at IS NULL`;
    assert.equal(pullErrs.length, 1,
      `one unresolved record per code — repeated polls must not bury the list (got ${pullErrs.length})`);
    assert.equal(pullErrs[0].http_status, 503, "the poll's 503 is stored verbatim");
    assert.equal(pullErrs[0].response_body, proxyPage, "the raw proxy page is persisted");
    ok("inbound pull: HTTP failure persists status + raw body, deduplicated per code");
  }

  console.log(`\ncheck-beds24-failure-evidence: all ${n} assertions passed`);
} finally {
  if (tenantId) {
    for (const t of [
      "channel_evidence_ledger", "channel_sync_errors", "channel_dirty_ranges",
      "channel_sync_jobs", "channel_beds24_room_mappings", "channel_connections",
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
