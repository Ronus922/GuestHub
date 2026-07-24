#!/usr/bin/env node
// check:beds24-ari-drain — the outbound ARI drain, end to end, against a mock
// that encodes Beds24's REAL calendar contract.
//
// WHY. drainBeds24AriDirtyRanges is the only path that tells Beds24 what a room
// costs and whether it is sellable. Every one of its failure modes is silent by
// nature: a range wrongly marked 'synced' means Beds24 keeps selling yesterday's
// price forever, and nothing in the UI says so. The dangerous ones, all proven
// upstream behaviour and all encoded in the mock below:
//   · Beds24 answers 200/201 with a PER-ITEM envelope — success:false inside a
//     2xx body is a REJECTED write (multiplePostResponse, apiV2). Reading the
//     HTTP status alone marks rejected ranges synced.
//   · a warnings[] array on an otherwise-2xx body is a PARTIAL write; the
//     affected ranges must stay retryable, and no upstream text may leak.
//   · Beds24 REJECTS calendar writes for dates before today (per-value
//     "process inventory rooms calendar" warnings, probed live 2026-07-24) —
//     without the past-date clamp such a range retries until dead-letter and
//     pins the /rates chip on "הסנכרון נכשל".
//   · v2 authenticates with a bare `token` header — NOT `Authorization: Bearer`.
//   · price1 is MAJOR currency units with decimals; `to` in a calendar range is
//     INCLUSIVE. Either mistake silently corrupts the live listing.
//   · a 429 must open the connection breaker for the Retry-After the provider
//     asked for, and the next drain must send NOTHING.
//
// The check runs the REAL compiled worker modules against an isolated test DB
// (:5433) and a substituted fetch; the DB scaffold is a real tenant with real
// rooms, sellable units, a designated Rate Plan and real dirty ranges.
//
// Usage: node scripts/check-beds24-ari-drain.mjs
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
process.env.CHANNEL_SECRETS_KEY = "check-beds24-ari-drain-key";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const ROOT = process.cwd();

// ---- static: the ONE endpoint and the ONE auth scheme (contract facts the
// mock below also enforces on the wire — asserted here so a rename is caught
// even if a scenario is ever skipped) ----
const ariSrc = readFileSync(join(ROOT, "src/lib/channel/beds24-ari.ts"), "utf8");
const httpSrc = readFileSync(join(ROOT, "src/lib/channel/beds24-http.ts"), "utf8");
assert.match(ariSrc, /path: "\/inventory\/rooms\/calendar"/,
  "the calendar push targets POST /inventory/rooms/calendar");
assert.match(httpSrc, /headers: \{ token: opts\.token \}/,
  "Beds24 v2 authenticates with a bare `token` header, never Authorization/Bearer");
assert.match(httpSrc, /"x-fivemincreditlimit-remaining"/,
  "the credit-window counter is read from the real header name");
ok("static: one endpoint (/inventory/rooms/calendar), `token` auth, real credit header");

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
const ari = require2(join(OUT, "lib/channel/beds24-ari-sync.js"));
const { encryptSecret } = require2(join(OUT, "lib/channel/crypto.js"));

// ============================================================
// The Beds24 calendar contract mock
// ============================================================
const ACCESS_TOKEN = "check-ari-drain-access-token";
const PROPERTY = "999002";
const B24_ROOM_1 = "707101";
const B24_ROOM_2 = "707102";

const iso = (d) => d.toISOString().slice(0, 10);
const day = (offset) => iso(new Date(Date.now() + offset * 86_400_000));
const TODAY = day(0);

/** every request the drain issued this run: { path, body, dates } */
let calls = [];
/** how the mock should answer the next calls */
let reply = { mode: "success" };
// beds24-http CATCHES every throw out of fetch and turns it into a
// `network_error`, so an assert inside the mock would be SWALLOWED — and in the
// scenarios that expect a failure it would be invisible. Wire-contract breaches
// are therefore RECORDED and asserted by the caller after every drain.
const violations = [];
const must = (cond, msg) => { if (!cond) violations.push(msg); };
const noViolations = () => {
  assert.equal(violations.length, 0,
    `Beds24 wire-contract violation(s): ${violations.join(" | ")}`);
};

function calendarDatesOf(body) {
  const out = [];
  for (const entry of body) {
    for (const r of entry.calendar) {
      for (let d = r.from; d <= r.to; d = iso(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000))) {
        out.push({ roomId: entry.roomId, date: d, range: r });
      }
    }
  }
  return out;
}

const fakeFetch = async (url, init) => {
  const u = new URL(String(url));
  // routing + auth are contract, not decoration
  must(u.host === "api.beds24.com", `unexpected outbound host: ${u.host}`);
  must(u.pathname === "/v2/inventory/rooms/calendar",
    `the drain called ${u.pathname} — it may only POST /v2/inventory/rooms/calendar (a token mint here would burn credits every drain)`);
  must((init.method ?? "GET") === "POST", `the calendar write is a POST (got ${init.method})`);
  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  must(headers.token === ACCESS_TOKEN,
    "Beds24 v2 takes the 24h ACCESS token in a bare `token` header");
  must(headers.authorization === undefined,
    "an Authorization/Bearer header was sent — that is not the Beds24 v2 scheme");
  must(headers["content-type"] === "application/json", "a JSON body needs a JSON content-type");

  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    must(false, "the request body is not JSON");
    return new Response(JSON.stringify({ success: false }), { status: 400 });
  }
  must(Array.isArray(body) && body.length > 0, "the body is a non-empty array of room entries");
  for (const entry of Array.isArray(body) ? body : []) {
    must(Number.isInteger(entry.roomId) && entry.roomId > 0,
      `roomId must be the NUMERIC Beds24 room id on the wire (got ${JSON.stringify(entry.roomId)})`);
    must(Array.isArray(entry.calendar) && entry.calendar.length > 0, "each entry carries ranges");
    for (const r of entry.calendar ?? []) {
      must(/^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to),
        `a calendar range needs plain YYYY-MM-DD bounds (got ${r.from} → ${r.to})`);
      must(r.from <= r.to, `a range never runs backwards (${r.from} → ${r.to})`);
      must(r.numAvail === 0 || r.numAvail === 1,
        `numAvail is 0 or 1 for a one-room mapping (got ${JSON.stringify(r.numAvail)})`);
      if (r.price1 !== undefined) {
        // MAJOR units with at most 2 decimals — never minor units / cents
        must(Number.isFinite(r.price1) && r.price1 > 0, `price1 must be a positive number (got ${r.price1})`);
        must(Math.round(r.price1 * 100) / 100 === r.price1,
          `price1 must have at most 2 decimals — MAJOR units, never cents (got ${r.price1})`);
      }
    }
  }
  const dates = calendarDatesOf(Array.isArray(body) ? body : []);
  calls.push({ path: u.pathname, body, dates });

  const creditHeaders = {
    "Content-Type": "application/json",
    "X-FiveMinCreditLimit": "5000",
    "X-FiveMinCreditLimit-Remaining": "4900",
    "X-RequestCost": "1",
  };

  if (reply.mode === "network") throw new TypeError("fetch failed");
  if (reply.mode === "rate_limited") {
    return new Response(JSON.stringify({ success: false }), {
      status: 429,
      headers: { ...creditHeaders, "Retry-After": "120" },
    });
  }
  if (reply.mode === "item_failure") {
    // THE TRAP: HTTP 200, per-item success:false. A rejected write.
    return new Response(
      JSON.stringify([
        {
          success: false,
          errors: [
            { action: "process inventory rooms calendar", field: "price1", message: "invalid price" },
          ],
        },
      ]),
      { status: 200, headers: creditHeaders },
    );
  }
  if (reply.mode === "item_failure_bare") {
    // the same trap with NO errors[] to fall back on — the ONLY thing standing
    // between this body and a wrongly-synced range is the success:false rule
    return new Response(JSON.stringify([{ success: false }]), {
      status: 200,
      headers: creditHeaders,
    });
  }

  // the REAL past-date behaviour: Beds24 accepts the request but warns per
  // value for dates before today — nothing is written for them.
  const past = dates.filter((d) => d.date < TODAY);
  if (past.length > 0) {
    return new Response(
      JSON.stringify(
        [...new Set(past.map((p) => p.roomId))].map((roomId) => ({
          success: true,
          modified: {},
          warnings: past
            .filter((p) => p.roomId === roomId)
            .map((p) => ({
              action: "process inventory rooms calendar",
              field: "numAvail",
              message: `date ${p.date} is in the past`,
            })),
          roomId,
        })),
      ),
      { status: 201, headers: creditHeaders },
    );
  }
  if (reply.mode === "warnings") {
    return new Response(
      JSON.stringify(
        body.map((entry) => ({
          success: true,
          modified: { field: "numAvail" },
          roomId: entry.roomId,
          warnings: [
            {
              action: "process inventory rooms calendar",
              field: "minStay",
              message: "SECRET-UPSTREAM-TEXT minStay not applied",
            },
          ],
        })),
      ),
      { status: 201, headers: creditHeaders },
    );
  }
  return new Response(
    JSON.stringify(body.map((entry) => ({ success: true, modified: { field: "price1" }, roomId: entry.roomId }))),
    { status: 201, headers: creditHeaders },
  );
};

// nothing may reach the real network through the global. NOTE: beds24-http
// catches every throw from fetch and turns it into a `network_error`, so a
// thrower here would be SWALLOWED — the violation is counted and asserted
// instead.
let globalFetchCalls = 0;
globalThis.fetch = async () => {
  globalFetchCalls += 1;
  return new Response(JSON.stringify({ success: false }), { status: 500 });
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const slug = `b24-drain-${Date.now()}`;
let tenantId;

const PRICE = 512.5; // major units, 2 decimals — a /100 regression yields 5.125
const MIN_STAY = 2;

try {
  // ============================================================
  // scaffold: tenant, two rooms, exclusive sellable units, ONE designated
  // tenant-level Rate Plan, an ACTIVE outbound beds24 connection with a fresh
  // cached access token (no token mint may happen — minting costs credits).
  // ============================================================
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES ('Beds24 ARI Drain Check', ${slug}, 'Asia/Jerusalem', 'ILS') RETURNING id`;
  tenantId = tenant.id;
  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenantId}, 'Drain Type', 400) RETURNING id`;

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
  const R1 = await mkRoom("D24-1");
  const R2 = await mkRoom("D24-2");

  const [plan] = await sql`
    INSERT INTO guesthub.pricing_plans
      (tenant_id, sellable_unit_id, code, name, plan_kind, is_active, is_archived, is_visible_channels)
    VALUES (${tenantId}, NULL, 'beds24', 'תוכנית ערוץ', 'base', true, false, true) RETURNING id`;
  for (const u of [R1, R2]) {
    await sql`
      INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
      VALUES (${tenantId}, ${plan.id}, ${u.suId}, true)`;
  }
  // an explicit per-date overlay so the pushed price1 is exact, not inferred
  for (let d = -15; d <= 60; d++) {
    for (const u of [R1, R2]) {
      await sql`
        INSERT INTO guesthub.pricing_plan_unit_rates
          (tenant_id, pricing_plan_id, sellable_unit_id, date, price, min_stay_arrival)
        VALUES (${tenantId}, ${plan.id}, ${u.suId}, ${day(d)}, ${PRICE}, ${MIN_STAY})`;
    }
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
    VALUES
      (${tenantId}, ${connId}, ${PROPERTY}, ${B24_ROOM_1}, ${R1.roomId}, ${plan.id}, 'mapped'),
      (${tenantId}, ${connId}, ${PROPERTY}, ${B24_ROOM_2}, ${R2.roomId}, ${plan.id}, 'mapped')`;

  // ---- helpers ----
  /** reload through the REAL loader — the drain reads its breaker state there */
  const loadConn = async () => {
    const conns = await ari.loadDrainableBeds24Connections(sql);
    const c = conns.find((x) => x.id === connId);
    assert.ok(c, "the active, baselined connection is drainable");
    return c;
  };
  const markDirty = async (roomId, from, to, extra = {}) => {
    const [row] = await sql`
      INSERT INTO guesthub.channel_dirty_ranges
        (tenant_id, connection_id, room_id, local_rate_plan_id, kind, date_from, date_to,
         status, attempts, next_attempt_at)
      VALUES (${tenantId}, ${connId}, ${roomId}, ${extra.planId ?? null}, ${extra.kind ?? "availability"},
              ${from}, ${to}, 'pending', ${extra.attempts ?? 0},
              ${extra.nextAttemptAt ?? sql`now()`})
      RETURNING id`;
    return row.id;
  };
  const rangeRow = async (id) => (await sql`
    SELECT status, attempts, last_error_code, next_attempt_at
    FROM guesthub.channel_dirty_ranges WHERE id = ${id}`)[0];
  const lastEvidence = async () => (await sql`
    SELECT scenario_key, outcome, error_code, warnings, context, firing_function
    FROM guesthub.channel_evidence_ledger
    WHERE tenant_id = ${tenantId} ORDER BY created_at DESC, id DESC LIMIT 1`)[0];
  /** breaker reset between scenarios — fixture management, never an assertion */
  const resetBreaker = () => sql`
    UPDATE guesthub.channel_connections
    SET circuit_open_until = NULL, consecutive_failures = 0, last_error = NULL
    WHERE id = ${connId}`;
  const drain = async () => {
    calls = [];
    const s = await ari.drainBeds24AriDirtyRanges(sql, await loadConn(), { fetchImpl: fakeFetch });
    noViolations(); // the mock's breaches would otherwise be swallowed as network_error
    return s;
  };

  // ============================================================
  // 1. a clean drain speaks the real wire contract
  // ============================================================
  reply = { mode: "success" };
  const r1 = await markDirty(R1.roomId, day(10), day(14));
  let summary = await drain();
  assert.equal(summary.claimed, 1, "the pending, due range is claimed");
  assert.equal(summary.synced, 1, `a clean push syncs the range (got ${JSON.stringify(summary)})`);
  assert.ok(calls.length >= 1, "the drain actually issued a calendar POST");
  const sent = calls[0].body;
  assert.equal(sent.length, 1, "one mapped room in this drain → one room entry");
  assert.equal(sent[0].roomId, Number(B24_ROOM_1), "the wire roomId is the mapped Beds24 room id");
  assert.equal(sent[0].calendar.length, 1, "four identical dates compress into ONE range");
  const range = sent[0].calendar[0];
  assert.equal(range.from, day(10), "the range starts on the dirty range's first date");
  assert.equal(range.to, day(13),
    "`to` is INCLUSIVE — the last covered date, never the exclusive bound (that would push an extra night)");
  assert.equal(range.numAvail, 1, "a free, priced, mapped room is available");
  assert.equal(range.price1, PRICE, "price1 is MAJOR currency units (a /100 regression yields 5.125)");
  assert.equal(range.minStay, MIN_STAY, "the projected restriction rides the same range");
  assert.equal((await rangeRow(r1)).status, "synced", "the claimed range completes as synced");
  const [connAfter] = await sql`
    SELECT last_error, consecutive_failures FROM guesthub.channel_connections WHERE id = ${connId}`;
  assert.equal(connAfter.last_error, null, "a clean drain clears last_error");
  let ev = await lastEvidence();
  assert.equal(ev.scenario_key, "incremental_sync");
  assert.equal(ev.firing_function, "drainBeds24AriDirtyRanges");
  assert.equal(ev.outcome, "success", "the evidence ledger records the clean drain");
  assert.equal(ev.context.creditsRemaining, 4900,
    "X-FiveMinCreditLimit-Remaining is carried into the evidence context");
  ok("clean drain: POST /inventory/rooms/calendar, `token` auth, compressed range, inclusive `to`, price1 in major units, synced + evidence");

  // ============================================================
  // 2. THE 200-WITH-ERRORS TRAP — a per-item success:false is a REJECTED write
  // ============================================================
  await resetBreaker();
  reply = { mode: "item_failure" };
  const r2 = await markDirty(R1.roomId, day(20), day(22));
  summary = await drain();
  assert.equal(summary.synced, 0, "a 200 carrying success:false is NEVER a clean sync");
  assert.equal(summary.retried, 1, "the range stays retryable");
  const after2 = await rangeRow(r2);
  assert.equal(after2.status, "pending", "the rejected range is preserved as pending, never dropped");
  assert.equal(after2.attempts, 1, "the attempt is counted");
  assert.equal(after2.last_error_code, "validation", "the rejection is classified as a validation failure");
  assert.ok(after2.next_attempt_at > new Date(), "the retry is pushed out with backoff");
  ev = await lastEvidence();
  assert.equal(ev.outcome, "failed", "the evidence ledger records the rejection");

  // the same trap with a BARE success:false — no errors[] to fall back on.
  // Only the success:false rule itself stands between this body and a range
  // wrongly marked synced (i.e. Beds24 selling a price it never accepted).
  await resetBreaker();
  reply = { mode: "item_failure_bare" };
  const r2b = await markDirty(R1.roomId, day(21), day(23));
  summary = await drain();
  assert.equal(summary.synced, 0,
    "a BARE success:false on a 200 is still a rejected write — never a clean sync");
  const after2b = await rangeRow(r2b);
  assert.equal(after2b.status, "pending", "the bare-rejected range stays retryable");
  assert.equal(after2b.last_error_code, "validation");
  ok("200-with-errors trap: success:false inside a 2xx body — with or without errors[] — keeps every claimed range retryable");
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE id IN (${r2}, ${r2b})`;

  // ============================================================
  // 3. warnings on a 2xx body ⇒ partial, never clean — and no upstream leak
  // ============================================================
  await resetBreaker();
  reply = { mode: "warnings" };
  const r3 = await markDirty(R1.roomId, day(24), day(26));
  summary = await drain();
  assert.equal(summary.synced, 0, "a partial write never marks the range synced");
  const after3 = await rangeRow(r3);
  assert.equal(after3.status, "pending", "the partially-applied range stays retryable");
  assert.equal(after3.last_error_code, "partial_warnings");
  const [warnErr] = await sql`
    SELECT error_message, context FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${tenantId} AND error_code = 'partial_warnings'
    ORDER BY created_at DESC LIMIT 1`;
  assert.ok(warnErr, "the partial write is loudly recorded (partial_warnings)");
  const recorded = JSON.stringify(warnErr) + JSON.stringify(await lastEvidence());
  assert.ok(!recorded.includes("SECRET-UPSTREAM-TEXT"),
    "the upstream warning TEXT never leaves the client — only roomId + field names");
  assert.ok(recorded.includes("minStay"), "the rejected FIELD NAME is what gets recorded");
  ev = await lastEvidence();
  assert.equal(ev.outcome, "partial", "the evidence ledger records a partial, not a success");
  ok("partial write: warnings keep the range retryable, record field names only, never upstream text");
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE id = ${r3}`;

  // ============================================================
  // 4. a 429 opens the breaker for the provider's Retry-After; the next drain
  //    sends NOTHING
  // ============================================================
  await resetBreaker();
  reply = { mode: "rate_limited" };
  const r4 = await markDirty(R1.roomId, day(28), day(30));
  summary = await drain();
  assert.equal(summary.synced, 0, "a 429 syncs nothing");
  assert.equal((await rangeRow(r4)).status, "pending", "the rate-limited range stays retryable");
  const [breaker] = await sql`
    SELECT consecutive_failures, circuit_open_until FROM guesthub.channel_connections WHERE id = ${connId}`;
  assert.equal(breaker.consecutive_failures, 1, "the failure is counted on the connection");
  assert.ok(breaker.circuit_open_until, "the 429 opened the circuit");
  const openForMs = new Date(breaker.circuit_open_until).getTime() - Date.now();
  assert.ok(openForMs > 100_000 && openForMs <= 125_000,
    `the cooldown is the provider's Retry-After (120s), not the base cooldown — got ${Math.round(openForMs / 1000)}s`);
  // second drain with the breaker open: not one request may leave. A FRESH,
  // immediately-due range is added first so the per-range backoff cannot be
  // what keeps the connection quiet — only the breaker can. A thrower would be
  // swallowed by beds24-http's catch, so the calls are COUNTED.
  const r4b = await markDirty(R2.roomId, day(31), day(33));
  calls = [];
  let coolingCalls = 0;
  const blocked = await ari.drainBeds24AriDirtyRanges(sql, await loadConn(), {
    fetchImpl: async () => {
      coolingCalls += 1;
      return new Response(JSON.stringify([{ success: true }]), { status: 201 });
    },
  });
  assert.equal(coolingCalls, 0,
    "a drain issued a request while the circuit was OPEN — the whole point of the cooldown is to stop hammering Beds24");
  assert.equal(blocked.circuitOpen, true, "the open circuit is reported, not silently skipped");
  assert.equal(blocked.claimed, 0, "an open circuit claims nothing — the ranges stay pending");
  assert.equal((await rangeRow(r4)).status, "pending", "the ranges survive the cooldown untouched");
  assert.equal((await rangeRow(r4b)).status, "pending", "…including a range that was due right now");
  assert.equal((await rangeRow(r4b)).attempts, 0, "…and it did not burn an attempt while cooling");
  ok("429: the breaker opens for the provider's Retry-After and the next drain sends zero requests");
  await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE id IN (${r4}, ${r4b})`;

  // ============================================================
  // 5. PAST-DATE CLAMP — a range wholly in the past sends nothing and completes
  // ============================================================
  await resetBreaker();
  reply = { mode: "success" };
  const r5 = await markDirty(R1.roomId, day(-10), day(-5));
  summary = await drain();
  const pastDates = calls.flatMap((c) => c.dates).filter((d) => d.date < TODAY);
  assert.equal(pastDates.length, 0,
    `no date before today may ever leave the process — Beds24 rejects them per value (leaked: ${pastDates.map((d) => d.date).join(", ")})`);
  const after5 = await rangeRow(r5);
  assert.equal(after5.status, "synced",
    "an unsendable past range completes instead of retrying forever (it pinned /rates on 'הסנכרון נכשל')");
  assert.equal(after5.attempts, 0, "it never burned a retry attempt");
  ok("past-date clamp: a wholly-past range sends nothing, completes, and never dead-letters");

  // ============================================================
  // 6. DRAIN SCOPING — only dates a claimed range covers leave the process
  // ============================================================
  await resetBreaker();
  reply = { mode: "success" };
  const r6a = await markDirty(R1.roomId, day(40), day(42));
  const r6b = await markDirty(R2.roomId, day(50), day(52));
  summary = await drain();
  assert.equal(summary.claimed, 2, "both pending ranges are claimed in one drain");
  const windows = {
    [Number(B24_ROOM_1)]: [day(40), day(42)],
    [Number(B24_ROOM_2)]: [day(50), day(52)],
  };
  const allDates = calls.flatMap((c) => c.dates);
  assert.ok(allDates.length > 0, "the scoped drain still sent the claimed dates");
  for (const d of allDates) {
    const w = windows[d.roomId];
    assert.ok(w, `an unclaimed room leaked into the push: ${d.roomId}`);
    assert.ok(d.date >= w[0] && d.date < w[1],
      `date ${d.date} for room ${d.roomId} is OUTSIDE its claimed range [${w[0]}, ${w[1]}) — the drain published state nobody asked it to`);
  }
  assert.equal(allDates.filter((d) => d.roomId === Number(B24_ROOM_1)).length, 2);
  assert.equal(allDates.filter((d) => d.roomId === Number(B24_ROOM_2)).length, 2);
  assert.equal((await rangeRow(r6a)).status, "synced");
  assert.equal((await rangeRow(r6b)).status, "synced");
  ok("drain scoping: exactly the claimed (room, date) cells are published — nothing between the windows");

  // ============================================================
  // 7. bounded retry → dead-letter, never a silent drop
  // ============================================================
  await resetBreaker();
  reply = { mode: "network" };
  const r7 = await markDirty(R1.roomId, day(44), day(46), { attempts: 4 }); // max_attempts = 5
  summary = await drain();
  assert.equal(summary.failed, 1, "the exhausted range is reported as failed");
  const after7 = await rangeRow(r7);
  assert.equal(after7.status, "failed",
    "attempts exhausted → dead-lettered for operator review, never deleted and never left retrying");
  assert.equal(after7.attempts, 5);
  assert.equal(after7.last_error_code, "network_error", "the failure category is preserved");
  // a dead-lettered range is out of the claim set
  await resetBreaker();
  reply = { mode: "success" };
  summary = await drain();
  assert.equal(summary.claimed, 0, "a dead-lettered range is never re-claimed");
  ok("bounded retry: an exhausted range dead-letters with its error code and leaves the claim set");

  // ============================================================
  // 8. a range not yet due is not claimed (the backoff is real)
  // ============================================================
  await resetBreaker();
  reply = { mode: "success" };
  const r8 = await markDirty(R1.roomId, day(56), day(58), {
    nextAttemptAt: sql`now() + interval '1 hour'`,
  });
  summary = await drain();
  assert.equal(summary.claimed, 0, "a range whose backoff has not elapsed is not claimed");
  assert.equal(calls.length, 0, "…and no request is issued for it");
  assert.equal((await rangeRow(r8)).status, "pending", "it stays pending for its due time");
  ok("backoff honoured: a not-yet-due range is left alone until next_attempt_at");

  // ============================================================
  // 9. every request in this run went through the substituted fetch
  // ============================================================
  assert.equal(globalFetchCalls, 0,
    `the drain reached the REAL network ${globalFetchCalls} time(s) — a substituted fetch was bypassed`);
  ok("no request escaped the mock — every call in this run went through the substituted fetch");

  console.log(`\ncheck-beds24-ari-drain: all ${n} assertions passed`);
} finally {
  // scratch-tenant cleanup (dependency order) — testdb only
  if (tenantId) {
    for (const t of [
      "channel_evidence_ledger", "channel_sync_errors", "channel_dirty_ranges",
      "channel_sync_jobs", "channel_beds24_room_mappings", "channel_connections",
      "pricing_plan_unit_rates", "pricing_plan_units", "pricing_plan_rates",
      "pricing_plans", "sellable_unit_rooms", "sellable_units",
      "rooms", "room_types", "tenants",
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
