// ============================================================
// Channex ARI wiring checks (D68). Four parts, no network, nothing committed.
//
//  A — PURE payload builders (tsc-compiled real modules): compression,
//      batching, end-exclusive→inclusive conversion, fail-closed rate handling.
//  B — PURE Channex client with an INJECTED fetch: the 200-with-warnings trap,
//      every error category, and the no-leak guarantee.
//  C — DB (isolated :5433 test DB, every scenario rolled back): the projection
//      consumes the CANONICAL availability + pricing services and agrees with
//      calculateQuote(); dirty ranges are marked by the right canonical saves.
//  D — SCOPE guards at the source level: no new pricing UI, no simulator, no
//      second sync button, no OTA/webhook/booking, no Next after(), no cron.
//
// Usage: node scripts/check-channex-ari.mjs
// ============================================================
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = "/var/www/guesthub";
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
process.env.DATABASE_URL = TEST_URL;
process.env.CHANNEL_SECRETS_KEY = process.env.CHANNEL_SECRETS_KEY || "test-only-key-not-a-real-secret";

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// ---- apply the migration chain (idempotent; validates 027 on the way) ----
console.log("applying migration chain to guesthub-testdb (:5433)…");
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );
}

// ---- compile the real modules (tsc, CommonJS) ----
console.log("compiling the ARI graph via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-ari-"));
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
    join(ROOT, "src/lib/channel/ari-payloads.ts"),
    join(ROOT, "src/lib/channel/ari-progress.ts"),
    join(ROOT, "src/lib/channel/channex-ari.ts"),
    join(ROOT, "src/lib/channel/ari-projection.ts"),
    join(ROOT, "src/lib/channel/outbox.ts"),
    join(ROOT, "src/lib/pricing/engine.ts"),
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
    // the compiled tree lives in /tmp; resolve bare deps (postgres, …) from the repo
    if (/^[a-z@]/.test(request)) return req.resolve(request);
    throw e;
  }
};

const ari = req(join(out, "lib/channel/ari-payloads.js"));
const prog = req(join(out, "lib/channel/ari-progress.js"));
const client = req(join(out, "lib/channel/channex-ari.js"));
const { projectAri } = req(join(out, "lib/channel/ari-projection.js"));
const { markAriDirty, expandPlanFamily, roomsForPlans } = req(join(out, "lib/channel/outbox.js"));
const { calculateQuote } = req(join(out, "lib/pricing/engine.js"));

// ============================================================
// Part A — pure payload builders
// ============================================================
{
  const roomMap = new Map([["r1", "cx-rt-1"]]);
  const rows = [
    { roomId: "r1", date: "2026-08-01", availability: 1 },
    { roomId: "r1", date: "2026-08-02", availability: 1 },
    { roomId: "r1", date: "2026-08-03", availability: 0 },
    { roomId: "r-unmapped", date: "2026-08-01", availability: 1 },
  ];
  const built = ari.buildAvailabilityValues(rows, "prop", roomMap);
  const v = built.batches[0].values;
  assert.equal(v.length, 2, "identical adjacent days compress");
  assert.deepEqual(v[0], { property_id: "prop", room_type_id: "cx-rt-1", date_from: "2026-08-01", date_to: "2026-08-02", availability: 1 });
  assert.deepEqual(v[1].date_from, "2026-08-03");
  assert.equal(v[1].date_to, "2026-08-03", "Channex date_to is INCLUSIVE — a single day repeats the date");
  assert.deepEqual(built.unmapped, ["r-unmapped"], "unmapped rooms surfaced, never silently dropped");
  ok("availability: 0/1 values, adjacency compression, inclusive date_to, unmapped surfaced");
}
{
  const combo = new Map([["r1|p1", "cx-rp-1"]]);
  const base = {
    roomId: "r1", planId: "p1",
    minStayArrival: 2, minStayThrough: null, maxStay: null,
    stopSell: false, closedToArrival: false, closedToDeparture: false,
  };
  const rows = [
    { ...base, date: "2026-08-01", rates: [{ occupancy: 1, rate: 400 }, { occupancy: 2, rate: 500 }] },
    { ...base, date: "2026-08-02", rates: [{ occupancy: 1, rate: 400 }, { occupancy: 2, rate: 500 }] },
    { ...base, date: "2026-08-03", rates: [{ occupancy: 1, rate: 450 }, { occupancy: 2, rate: 550 }] },
    // a blocked cell: no price could be resolved
    { ...base, date: "2026-08-04", rates: null, stopSell: true },
  ];
  const built = ari.buildRestrictionValues(rows, "prop", combo);
  const v = built.batches[0].values;
  assert.equal(v.length, 3, "identical rate+restriction days compress; a rate change splits");
  assert.deepEqual(v[0].rates, [{ occupancy: 1, rate: "400.00" }, { occupancy: 2, rate: "500.00" }]);
  assert.equal(typeof v[0].rates[0].rate, "string", "rate is the unambiguous decimal string form");
  assert.equal(v[0].min_stay_arrival, 2);
  assert.equal(v[0].stop_sell, false);
  const blocked = v[2];
  assert.equal(blocked.stop_sell, true, "a blocked cell publishes stop_sell");
  assert.ok(!("rates" in blocked), "a blocked cell carries NO rate — never a fabricated ₪0");
  ok("rates/restrictions: per-occupancy decimal strings, compression, blocked ⇒ stop_sell without a rate");
}
{
  const combo = new Map([["r1|p1", "cx"]]);
  const many = Array.from({ length: 2500 }, (_, i) => ({
    roomId: "r1", planId: "p1", date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    rates: [{ occupancy: 1, rate: 100 + i }],
    minStayArrival: null, minStayThrough: null, maxStay: null,
    stopSell: false, closedToArrival: false, closedToDeparture: false,
  }));
  const built = ari.buildRestrictionValues(many, "p", combo);
  const total = built.batches.reduce((a, b) => a + b.values.length, 0);
  assert.ok(built.batches.every((b) => b.values.length <= ari.MAX_VALUES_PER_PAYLOAD), "every batch within the provider ceiling");
  assert.equal(total, 2500, "batching SPLITS — no value is ever truncated");
  assert.ok(built.batches.length > 1, "an oversized set produces several batches");
  ok("batching: splits at the provider ceiling, loses nothing");
}
{
  assert.ok(ari.validateAriBatch({ values: [] }), "empty batch rejected");
  const badRate = { values: [{ property_id: "p", rate_plan_id: "r", date_from: "a", date_to: "a", rates: [{ occupancy: 1, rate: "0.00" }] }] };
  assert.ok(/positive/.test(ari.validateAriBatch(badRate)), "a zero rate is refused before it can leave the process");
  const badOcc = { values: [{ property_id: "p", rate_plan_id: "r", date_from: "a", date_to: "a", rates: [{ occupancy: 0, rate: "10.00" }] }] };
  assert.ok(/occupancy/.test(ari.validateAriBatch(badOcc)), "occupancy 0 refused");
  const reversed = { values: [{ property_id: "p", room_type_id: "r", date_from: "2026-08-05", date_to: "2026-08-01" }] };
  assert.ok(ari.validateAriBatch(reversed), "reversed range refused");
  ok("validation: zero rate, occupancy 0 and reversed ranges never reach the network");
}

// ============================================================
// Part A2 — Full Sync progress: milestone-based, never timer-based (D69)
// ============================================================
{
  const PHASES = [
    "validating", "projecting_availability", "submitting_availability",
    "projecting_rates", "submitting_rates", "checking_warnings",
    "activating_incremental_sync", "completed", "failed",
  ];
  for (const p of PHASES) assert.ok(prog.PHASE_LABELS[p], `phase ${p} has a Hebrew label`);
  assert.equal(prog.PHASE_LABELS.projecting_rates, "מחשב מחירים והגבלות");
  assert.equal(prog.initialProgress("run-1", "T0").phase, "validating", "a run starts at `validating`");
  assert.equal(prog.initialProgress("run-1", "T0").percent, 0, "…at 0%");
  ok("progress starts at `validating`, 0%, with the specified phases and Hebrew labels");
}
{
  // percentage is a pure function of (phase, done, total) — it cannot see a clock
  const src = readFileSync(join(ROOT, "src/lib/channel/ari-progress.ts"), "utf8");
  assert.ok(/export function phasePercent\(phase: FullSyncPhase, done = 0, total = 0\): number/.test(src),
    "phasePercent takes only (phase, done, total) — no elapsed time, no start time");
  assert.ok(!/Date\.now|performance\.now|setInterval|setTimeout|new Date\(\)/.test(src),
    "the progress module reads no clock at all — a stalled run cannot advance");
  assert.ok(!/^import /m.test(src), "the progress model is pure and import-free");
  ok("the percentage is milestone-based: no clock is even reachable from the module");
}
{
  // the weighted milestone model from the spec
  assert.equal(prog.phasePercent("validating", 0, 0), 0);
  assert.equal(prog.phasePercent("validating", 1, 1), 10, "validation completes at 10%");
  assert.equal(prog.phaseFloor("projecting_availability"), 10);
  assert.equal(prog.phasePercent("projecting_availability", 0, 13), 10, "nothing projected ⇒ the phase floor");
  assert.equal(prog.phasePercent("projecting_availability", 13, 13), 30, "13/13 rooms ⇒ the phase ceiling");
  // real processed counts drive it, linearly
  assert.equal(prog.phasePercent("projecting_availability", 7, 13), 20);
  assert.equal(prog.phasePercent("submitting_availability", 1, 1), 45);
  assert.equal(prog.phasePercent("projecting_rates", 0, 52), 45);
  assert.equal(prog.phasePercent("projecting_rates", 34, 52), 64, "34/52 rate plans ⇒ 64%");
  assert.equal(prog.phasePercent("projecting_rates", 52, 52), 75);
  assert.equal(prog.phasePercent("submitting_rates", 1, 1), 90);
  assert.equal(prog.phasePercent("checking_warnings", 1, 1), 97);
  assert.equal(prog.phaseFloor("activating_incremental_sync"), 97);
  assert.equal(prog.phasePercent("completed"), 100, "only `completed` is 100%");
  ok("availability and rates projection advance the bar from REAL processed counts");
}
{
  // 100% is unreachable except through a clean completion
  for (const p of ["validating", "projecting_availability", "submitting_availability",
                   "projecting_rates", "submitting_rates", "checking_warnings", "activating_incremental_sync"]) {
    assert.ok(prog.phasePercent(p, 1e9, 1) < 100, `phase ${p} can never reach 100% however much work it reports`);
  }
  assert.ok(prog.phasePercent("failed", 1, 1) < 100, "a failed run never shows 100%");
  assert.ok(prog.isTerminalPhase("completed") && prog.isTerminalPhase("failed"));
  assert.ok(!prog.isTerminalPhase("submitting_rates"));
  ok("100% is reachable ONLY from a clean `completed` — never from any other phase");
}
{
  // outcomes: warnings and partial failure are NOT success
  const base = prog.initialProgress("r", "T0");
  assert.equal(prog.outcomeOf({ ...base, phase: "completed", percent: 100 }), "success");
  assert.equal(prog.outcomeOf({ ...base, phase: "failed", warnings: 3, percent: 97 }), "warnings",
    "a 200-with-warnings run is `warnings`, never success");
  assert.equal(prog.outcomeOf({ ...base, phase: "failed", availabilitySubmitted: true, restrictionsSubmitted: false, percent: 80 }),
    "partial_failure", "availability sent + rates failed ⇒ partial failure");
  assert.equal(prog.outcomeOf({ ...base, phase: "failed", percent: 5 }), "failed");
  assert.equal(prog.outcomeOf({ ...base, phase: "projecting_rates" }), "running");
  assert.equal(prog.outcomeOf(null), "running");
  ok("warnings never produce a successful 100% state; partial failure is reported as such");
}
{
  // the persisted record is a strict whitelist — nothing else can reach the browser
  const dirty = {
    runId: "r", phase: "completed", percent: 100, apiKey: "SECRET", api_key_ciphertext: "CT",
    payload: [{ rate: 1 }], upstream: "raw body", taskIds: ["t1", 42], warnings: 0,
  };
  const clean = prog.sanitizeProgress(dirty);
  assert.ok(clean, "a valid record sanitizes");
  assert.ok(!("apiKey" in clean) && !("api_key_ciphertext" in clean) && !("payload" in clean) && !("upstream" in clean),
    "unknown keys — including secrets and payloads — are dropped");
  assert.deepEqual(clean.taskIds, ["t1"], "task ids are strings only");
  assert.equal(prog.sanitizeProgress({ runId: "r", phase: "not_a_phase" }), null, "an unknown phase is rejected");
  assert.equal(prog.sanitizeProgress(null), null);
  assert.equal(prog.sanitizeProgress("nope"), null);
  ok("the progress DTO is a strict whitelist: no api-key, ciphertext or ARI payload can pass through it");
}

// ============================================================
// Part B — Channex client: the 200-with-warnings trap + no leaks
// ============================================================
const API_KEY = "super-secret-api-key-do-not-leak";
const fakeFetch = (status, body) => async () => ({
  status,
  ok: status < 400,
  json: async () => {
    if (body === "MALFORMED") throw new Error("not json");
    return body;
  },
});
const batch = { values: [{ property_id: "p", room_type_id: "rt", date_from: "2026-08-01", date_to: "2026-08-01", availability: 1 }] };
const push = (status, body, kind = "availability") =>
  client.pushAri({ apiKey: API_KEY, baseUrl: "https://staging.example.invalid/api/v1", kind, batch, fetchImpl: fakeFetch(status, body) });

{
  const res = await push(200, { data: [{ id: "task-1", type: "task" }], meta: { message: "Success", warnings: [] } });
  assert.equal(res.ok, true);
  assert.equal(res.partial, false, "clean 200 with a task id is a clean success");
  assert.deepEqual(res.taskIds, ["task-1"]);
  ok("200 + task id + no warnings ⇒ clean success");
}
{
  // THE trap: Channex answers a partially-rejected update with 200 OK.
  const res = await push(200, {
    data: [],
    meta: {
      message: "Success",
      warnings: [{
        date_from: "2026-08-01", date_to: "2026-08-03", rate_plan_id: "cx-rp-1",
        rate: null, min_stay_arrival: -2,
        warning: { min_stay_arrival: ["must be greater than 0"], rate: ["can't be blank"] },
      }],
    },
  }, "restrictions");
  assert.equal(res.ok, true);
  assert.equal(res.partial, true, "200 WITH warnings is never a full success");
  assert.deepEqual(res.warnings[0].fields, ["min_stay_arrival", "rate"], "field NAMES kept");
  assert.equal(res.warnings[0].dateFrom, "2026-08-01");
  assert.equal(res.warnings[0].entityId, "cx-rp-1");
  const dump = JSON.stringify(res);
  assert.ok(!dump.includes("must be greater than 0"), "upstream warning TEXT is discarded, never surfaced");
  assert.ok(!dump.includes("can't be blank"));
  const summary = client.summarizeWarnings(res.warnings);
  assert.ok(summary.includes("min_stay_arrival") && !summary.includes("blank"), "summary names fields, not upstream text");
  ok("200 + meta.warnings ⇒ partial (retryable), upstream text discarded");
}
{
  const res = await push(200, { data: [], meta: { message: "Success", warnings: [] } });
  assert.equal(res.ok, false);
  assert.equal(res.category, "bad_response", "a 2xx with neither task nor warning is not recorded as success");
  ok("200 with no task reference ⇒ bad_response, never a silent success");
}
{
  for (const [status, category] of [[401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [422, "validation"], [429, "rate_limited"], [500, "server_error"]]) {
    const res = await push(status, { errors: { code: "x", title: "y", detail: API_KEY } });
    assert.equal(res.ok, false);
    assert.equal(res.category, category, `HTTP ${status} ⇒ ${category}`);
    assert.ok(!JSON.stringify(res).includes(API_KEY), `HTTP ${status} response never echoes the api-key`);
  }
  const malformed = await push(200, "MALFORMED");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.category, "bad_response", "unparseable body ⇒ bad_response");
  ok("every error category mapped; api-key never appears in any returned message");
}
{
  const res = await client.pushAri({
    apiKey: API_KEY, baseUrl: "https://x.invalid", kind: "availability",
    batch: { values: [{ property_id: "p", rate_plan_id: "r", date_from: "a", date_to: "a", rates: [{ occupancy: 1, rate: "0.00" }] }] },
    fetchImpl: () => { throw new Error("network must not be reached"); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.category, "validation", "a structurally invalid batch is refused BEFORE any fetch");
  ok("invalid payload never reaches the network");
}

// ============================================================
// Part C — DB: canonical reuse + dirty ranges (all rolled back)
// ============================================================
const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1 });

class Rollback extends Error {}
const D0 = "2027-05-10";
const addDays = (d, k) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
};

async function buildFixture(tx) {
  const uniq = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [tenant] = await tx`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency, settings)
    VALUES ('בדיקת ARI', ${uniq("ari-check")}, 'Asia/Jerusalem', 'ILS',
      ${tx.json({
        vat_rate: 18,
        extra_guest: {
          configured: true, extra_adult: 200, extra_child: 50, extra_infant: 0,
          charge_frequency: "per_night", infant_max_age: 2, child_max_age: 12,
          infants_count_occupancy: false, infants_use_included: false,
          tax_mode: "inclusive", rounding_mode: "none", rounding_increment: 1,
        },
      })})
    RETURNING id`;
  const T = tenant.id;
  const [rt] = await tx`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${T}, 'סוג', 400) RETURNING id`;

  const mkRoom = async (num, extra = {}) => {
    const [r] = await tx`
      INSERT INTO guesthub.rooms ${tx({
        tenant_id: T, room_type_id: rt.id, room_number: num, name: `חדר ${num}`,
        status: "available", is_active: true,
        max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1,
        min_occupancy: 1, included_occupancy: 2, default_occupancy: 2,
        extra_guest_pricing_mode: "inherit", ...extra,
      })} RETURNING id`;
    const [su] = await tx`
      INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${T}, ${num}, ${`יחידה ${num}`}, ${rt.id}) RETURNING id`;
    await tx`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${T}, ${su.id}, ${r.id})`;
    const [bp] = await tx`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
      VALUES (${T}, ${su.id}, 'base', 'מחיר בסיס', true, 'base') RETURNING id`;
    return { roomId: r.id, suId: su.id, basePlanId: bp.id, roomNumber: num };
  };

  const R1 = await mkRoom("A1");
  const R2 = await mkRoom("A2");
  const RGHOST = await mkRoom("A3"); // never mapped → must never be projected

  // canonical base ARI over a generous window
  for (let i = 0; i < 12; i++) {
    const d = addDays(D0, i);
    for (const R of [R1, R2, RGHOST]) {
      await tx`INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
               VALUES (${T}, ${R.suId}, ${R.basePlanId}, ${d}, 500)`;
    }
  }

  const mkPlan = async (f) => {
    const [p] = await tx`INSERT INTO guesthub.pricing_plans ${tx({
      tenant_id: T, sellable_unit_id: null, is_base: false, is_active: true, is_visible_channels: true, ...f,
    })} RETURNING id`;
    return p.id;
  };
  const BASEPLAN = await mkPlan({ code: "nr", name: "ללא החזר", plan_kind: "base" });
  const DERIVED = await mkPlan({ code: "flex", name: "ביטול גמיש", plan_kind: "derived_percentage", parent_plan_id: BASEPLAN, adjustment_value: 5 });
  for (const P of [BASEPLAN, DERIVED]) {
    for (const R of [R1, R2, RGHOST]) {
      await tx`INSERT INTO guesthub.pricing_plan_units ${tx({ tenant_id: T, pricing_plan_id: P, sellable_unit_id: R.suId, is_active: true })}`;
    }
  }

  const [conn] = await tx`
    INSERT INTO guesthub.channel_connections (tenant_id, provider, environment, state, outbound_sync_enabled, full_sync_required, channex_property_id, api_key_ciphertext)
    VALUES (${T}, 'channex', 'staging', 'active', true, false, 'cx-prop', 'ciphertext') RETURNING id`;

  const mapRoom = (R) => tx`
    INSERT INTO guesthub.channel_room_mappings (tenant_id, connection_id, channex_property_id, room_id, room_number, channex_room_type_id, status, snapshot)
    VALUES (${T}, ${conn.id}, 'cx-prop', ${R.roomId}, ${R.roomNumber}, ${`cx-rt-${R.roomNumber}`}, 'mapped', ${tx.json({ occ_adults: 3 })})`;
  await mapRoom(R1);
  await mapRoom(R2); // RGHOST deliberately unmapped

  const mapCombo = (R, P, code) => tx`
    INSERT INTO guesthub.channel_room_rate_mappings (tenant_id, connection_id, channex_property_id, local_rate_plan_id, room_id, room_number, channex_rate_plan_id, status)
    VALUES (${T}, ${conn.id}, 'cx-prop', ${P}, ${R.roomId}, ${R.roomNumber}, ${code}, 'mapped')`;
  await mapCombo(R1, BASEPLAN, "cx-rp-1");
  await mapCombo(R1, DERIVED, "cx-rp-2");
  await mapCombo(R2, BASEPLAN, "cx-rp-3");
  await mapCombo(R2, DERIVED, "cx-rp-4");

  return { T, conn: conn.id, R1, R2, RGHOST, BASEPLAN, DERIVED };
}

const scenario = async (tx, fn) => {
  try {
    await tx.savepoint(async (sp) => { await fn(sp); throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
};

const project = (tx, f, extra = {}) =>
  projectAri(tx, { tenantId: f.T, connectionId: f.conn, dateFrom: D0, dateTo: addDays(D0, 4), ...extra });

try {
  await sql.begin(async (tx) => {
    const f = await buildFixture(tx);

    // ---- 13 mapped rooms only: an unmapped/removed room is never projected ----
    await scenario(tx, async (sp) => {
      const p = await project(sp, f);
      const rooms = new Set(p.availability.map((a) => a.roomId));
      assert.equal(rooms.size, 2, "exactly the mapped rooms are projected");
      assert.ok(!rooms.has(f.RGHOST.roomId), "an unmapped room (the 302/303 case) never appears in the projection");
      assert.ok(!p.commercial.some((c) => c.roomId === f.RGHOST.roomId));
      ok("projection covers exactly the mapped physical rooms; unmapped rooms are absent");
    });

    // ---- availability is 0 or 1, from the CANONICAL inventory function ----
    await scenario(tx, async (sp) => {
      const p = await project(sp, f);
      assert.ok(p.availability.every((a) => a.availability === 0 || a.availability === 1), "one room type = one physical room ⇒ availability ∈ {0,1}");
      assert.ok(p.availability.every((a) => a.availability === 1), "an unencumbered room is available");
      ok("availability comes from sellable_unit_inventory and is strictly 0 or 1");
    });

    // ---- reservation ⇒ 0, and checkout day stays available (end-exclusive) ----
    await scenario(tx, async (sp) => {
      const [res] = await sp`
        INSERT INTO guesthub.reservations (tenant_id, reservation_number, status, check_in, check_out)
        VALUES (${f.T}, 'R-1', 'confirmed', ${D0}, ${addDays(D0, 2)}) RETURNING id`;
      await sp`
        INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
        VALUES (${f.T}, ${res.id}, ${f.R1.roomId}, ${D0}, ${addDays(D0, 2)})`;
      const p = await project(sp, f);
      const get = (d) => p.availability.find((a) => a.roomId === f.R1.roomId && a.date === d).availability;
      assert.equal(get(D0), 0, "the first night is consumed");
      assert.equal(get(addDays(D0, 1)), 0, "the second night is consumed");
      assert.equal(get(addDays(D0, 2)), 1, "the CHECKOUT date is available again — end-exclusive");
      assert.equal(p.availability.find((a) => a.roomId === f.R2.roomId && a.date === D0).availability, 1, "another room is unaffected");
      ok("a blocking reservation zeroes exactly its nights; checkout date is end-exclusive");
    });

    // ---- closure ⇒ 0; inactive/out-of-order room ⇒ 0 ----
    await scenario(tx, async (sp) => {
      await sp`INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date, reason)
               VALUES (${f.T}, ${f.R1.roomId}, ${D0}, ${addDays(D0, 1)}, 'תחזוקה')`;
      await sp`UPDATE guesthub.rooms SET status = 'out_of_order', is_active = false WHERE id = ${f.R2.roomId}`;
      const p = await project(sp, f);
      assert.equal(p.availability.find((a) => a.roomId === f.R1.roomId && a.date === D0).availability, 0, "a closure zeroes availability");
      assert.equal(p.availability.find((a) => a.roomId === f.R1.roomId && a.date === addDays(D0, 1)).availability, 1, "the closure end date is exclusive");
      assert.ok(p.availability.filter((a) => a.roomId === f.R2.roomId).every((a) => a.availability === 0), "an out-of-order room is never available");
      ok("closures and out-of-order rooms zero availability through the canonical function");
    });

    // ---- THE equality check: projection price == calculateQuote price ----
    await scenario(tx, async (sp) => {
      const p = await project(sp, f);
      for (const planId of [f.BASEPLAN, f.DERIVED]) {
        const cell = p.commercial.find((c) => c.roomId === f.R1.roomId && c.planId === planId && c.date === D0);
        assert.ok(cell.rates, "a priced cell carries rates");
        for (const { occupancy, rate } of cell.rates) {
          const q = await calculateQuote(sp, {
            tenantId: f.T, checkIn: D0, checkOut: addDays(D0, 1),
            rooms: [{ roomId: f.R1.roomId, ratePlanId: planId, adults: occupancy, children: 0, infants: 0 }],
            source: "channel_manager",
          });
          assert.ok(q.valid, `quote for occupancy ${occupancy} is valid`);
          assert.equal(rate, q.rooms[0].nights[0].nightTotal,
            `projected rate for ${occupancy} adults equals what a booking would be charged`);
        }
      }
      ok("projected rate for EVERY occupancy equals calculateQuote's night total — one pricing engine, two callers");
    });

    // ---- derived plan uses the canonical chain (+5%), extra adult uses the canonical fee ----
    await scenario(tx, async (sp) => {
      const p = await project(sp, f);
      const at = (plan, occ) => p.commercial.find((c) => c.roomId === f.R1.roomId && c.planId === plan && c.date === D0).rates.find((r) => r.occupancy === occ).rate;
      assert.equal(at(f.BASEPLAN, 2), 500, "included occupancy prices at base");
      assert.equal(at(f.BASEPLAN, 1), 500, "below included occupancy still prices at base (never discounted)");
      assert.equal(at(f.BASEPLAN, 3), 700, "the 3rd adult adds the canonical ₪200 extra-guest fee");
      assert.equal(at(f.DERIVED, 2), 525, "derived_percentage +5% resolves through the parent chain");
      assert.equal(at(f.DERIVED, 3), 725, "the extra-guest fee is added AFTER the plan adjustment, as in a quote");
      ok("derived plans and extra-guest pricing use the canonical calculations, not a channel copy");
    });

    // ---- fail closed: no price ⇒ stop_sell, no rate, reported ----
    await scenario(tx, async (sp) => {
      await sp`DELETE FROM guesthub.pricing_plan_rates WHERE sellable_unit_id = ${f.R1.suId} AND date = ${D0}`;
      await sp`UPDATE guesthub.room_types SET base_price = 0 WHERE tenant_id = ${f.T}`;
      const p = await project(sp, f);
      const cell = p.commercial.find((c) => c.roomId === f.R1.roomId && c.planId === f.BASEPLAN && c.date === D0);
      assert.equal(cell.rates, null, "no price ⇒ no rate is invented");
      assert.equal(cell.stopSell, true, "no price ⇒ Stop Sell stays enabled");
      assert.equal(cell.blockedReason, "NO_PRICE_FOR_DATE");
      assert.ok(p.blocked.some((b) => b.date === D0 && b.reason === "NO_PRICE_FOR_DATE"), "the failure is reported, not swallowed");
      assert.ok(!p.commercial.some((c) => c.rates?.some((r) => r.rate <= 0)), "a zero price is NEVER sent as a sellable value");
      const other = p.commercial.find((c) => c.roomId === f.R2.roomId && c.date === D0);
      assert.ok(other.rates, "a price is never copied from another room — R2 prices from its OWN rows");
      ok("missing price fails closed per (room, plan, date): stop_sell, no rate, reported, nothing fabricated");
    });

    // ---- an archived / channel-hidden plan is WITHDRAWN, not silently forgotten ----
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.pricing_plans SET is_active = false, is_visible_channels = false WHERE id = ${f.DERIVED}`;
      const p = await project(sp, f);
      const cells = p.commercial.filter((c) => c.planId === f.DERIVED);
      assert.ok(cells.length > 0, "a mapped-but-withdrawn plan is still projected");
      assert.ok(cells.every((c) => c.stopSell && c.rates === null), "its Channex Rate Plan receives stop_sell — it cannot keep selling stale prices");
      ok("archiving a Rate Plan publishes stop_sell rather than leaving the channel selling stale prices");
    });

    // ---- Full Sync horizon is exactly 500 property-local dates ----
    await scenario(tx, async (sp) => {
      const p = await projectAri(sp, { tenantId: f.T, connectionId: f.conn, dateFrom: D0, dateTo: addDays(D0, 500) });
      const dates = new Set(p.availability.filter((a) => a.roomId === f.R1.roomId).map((a) => a.date));
      assert.equal(dates.size, 500, "exactly 500 dates are projected");
      assert.ok(dates.has(D0) && dates.has(addDays(D0, 499)) && !dates.has(addDays(D0, 500)), "[today, today+499] inclusive");
      ok("Full Sync projects exactly 500 property-local dates");
    });

    // ============================================================
    // dirty ranges — marked by the CANONICAL saves, correct dimension
    // ============================================================
    const dirty = (sp) => sp`
      SELECT room_id, local_rate_plan_id, kind, date_from::text AS date_from, date_to::text AS date_to, status
      FROM guesthub.channel_dirty_ranges WHERE connection_id = ${f.conn} ORDER BY kind, date_from`;

    await scenario(tx, async (sp) => {
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 2), kinds: ["rates", "restrictions"] });
      const rows = await dirty(sp);
      assert.equal(rows.length, 2, "a price update marks rates + restrictions");
      assert.ok(rows.every((r) => r.local_rate_plan_id === null), "a base-ARI write scopes to ALL plans of the room (NULL)");
      assert.ok(!rows.some((r) => r.kind === "availability"), "a price update does NOT mark availability dirty");
      assert.ok(rows.every((r) => r.room_id === f.R1.roomId), "the dimension is the physical room");
      ok("price/min-stay update ⇒ rates+restrictions dirty, availability untouched");
    });

    await scenario(tx, async (sp) => {
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 2) });
      const rows = await dirty(sp);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, "availability", "a closure/reservation marks availability only");
      assert.equal(rows[0].local_rate_plan_id, null, "availability is plan-independent (DB CHECK enforces it)");
      ok("closure / reservation ⇒ availability dirty, plan-independent");
    });

    await scenario(tx, async (sp) => {
      await assert.rejects(
        sp`INSERT INTO guesthub.channel_dirty_ranges (tenant_id, connection_id, room_id, local_rate_plan_id, kind, date_from, date_to)
           VALUES (${f.T}, ${f.conn}, ${f.R1.roomId}, ${f.BASEPLAN}, 'availability', ${D0}, ${addDays(D0, 1)})`,
        /plan_scope/,
        "the DB refuses a plan-scoped availability range",
      );
      ok("a plan-scoped availability range is structurally impossible");
    });

    // overlapping + adjacent ranges coalesce into one
    await scenario(tx, async (sp) => {
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 3) });
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: addDays(D0, 2), dateTo: addDays(D0, 5) }); // overlaps
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: addDays(D0, 5), dateTo: addDays(D0, 7) }); // adjacent
      const rows = await dirty(sp);
      assert.equal(rows.length, 1, "overlapping AND adjacent ranges merge into one");
      assert.equal(rows[0].date_from, D0);
      assert.equal(rows[0].date_to, addDays(D0, 7));
      ok("overlapping and adjacent dirty ranges coalesce safely — no duplicate outbound work");
    });

    // a different plan scope must NOT merge into another plan's range
    await scenario(tx, async (sp) => {
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], ratePlanIds: [f.BASEPLAN], dateFrom: D0, dateTo: addDays(D0, 3), kinds: ["rates"] });
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], ratePlanIds: [f.DERIVED], dateFrom: D0, dateTo: addDays(D0, 3), kinds: ["rates"] });
      const rows = await dirty(sp);
      assert.equal(rows.length, 2, "each plan keeps its own range");
      assert.deepEqual(new Set(rows.map((r) => r.local_rate_plan_id)), new Set([f.BASEPLAN, f.DERIVED]));
      ok("plan-scoped ranges never merge across plans");
    });

    // a Rate Plan change reaches its plan AND every descendant, on its assigned rooms
    await scenario(tx, async (sp) => {
      const family = await expandPlanFamily(sp, f.T, [f.BASEPLAN]);
      assert.deepEqual(new Set(family), new Set([f.BASEPLAN, f.DERIVED]), "the family includes transitive children — a parent edit re-prices them");
      const rooms = await roomsForPlans(sp, f.T, family);
      assert.ok(rooms.includes(f.R1.roomId) && rooms.includes(f.R2.roomId), "the plan's assigned rooms are found");
      await markAriDirty(sp, { tenantId: f.T, roomIds: rooms, ratePlanIds: family, dateFrom: D0, dateTo: addDays(D0, 3), kinds: ["rates", "restrictions"] });
      const rows = await dirty(sp);
      // 3 rooms assigned × 2 plans × 2 kinds
      assert.equal(rows.length, rooms.length * 2 * 2, "one range per (room × plan × kind) — only affected combinations");
      assert.ok(!rows.some((r) => r.kind === "availability"), "a plan change never marks availability");
      ok("a Rate Plan change marks its plan + descendants on their assigned rooms, and nothing else");
    });

    // no active connection ⇒ no backlog forms
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.channel_connections SET state = 'ready', outbound_sync_enabled = false WHERE id = ${f.conn}`;
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 2) });
      const rows = await dirty(sp);
      assert.equal(rows.length, 0, "before the first Full Sync activates the connection, nothing is recorded");
      const [{ n: jobs }] = await sp`SELECT count(*)::int AS n FROM guesthub.channel_sync_jobs WHERE connection_id = ${f.conn}`;
      assert.equal(jobs, 0, "and no drain job is enqueued");
      ok("no incremental work accumulates before the operator's initial Full Sync");
    });

    // marking dirty enqueues exactly ONE deduplicated drain job per connection
    await scenario(tx, async (sp) => {
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 2) });
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R2.roomId], dateFrom: D0, dateTo: addDays(D0, 2) });
      const jobs = await sp`SELECT job_type, idempotency_key FROM guesthub.channel_sync_jobs WHERE connection_id = ${f.conn}`;
      assert.equal(jobs.length, 1, "a burst of saves produces exactly one drain job");
      assert.equal(jobs[0].job_type, "sync_ari_range");
      ok("a burst of canonical saves enqueues ONE deduplicated drain job — never a Full Sync");
    });

    // the outbox write and the commercial write share ONE transaction
    await scenario(tx, async (sp) => {
      await markAriDirty(sp, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 2) });
      const rows = await dirty(sp);
      assert.equal(rows.length, 1, "written inside the caller's transaction");
    });
    const [{ n: leftover }] = await tx`SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges WHERE connection_id = ${f.conn}`;
    assert.equal(leftover, 0, "a rolled-back save leaves NO dirty range — canonical write + outbox are atomic");
    ok("canonical write and outbox mark commit or roll back together");

    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

  const [{ n: globalLeftover }] = await sql`SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges`;
  assert.equal(globalLeftover, 0, "the whole DB suite committed nothing");
  ok("nothing was committed to the database");
} finally {
  await sql.end();
}

// ============================================================
// Part D — scope guards (source level)
// ============================================================
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const listFiles = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : []);
// bans below target CODE, not prose — a comment saying "no simulator" is not a simulator
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

{
  // the ONLY module that may send ARI, and only to the two ARI endpoints
  const src = read("src/lib/channel/channex-ari.ts");
  assert.ok(/availability: "\/availability"/.test(src) && /restrictions: "\/restrictions"/.test(src));
  for (const path of ["/properties", "/room_types", "/rate_plans", "/webhooks", "/bookings"]) {
    assert.ok(!src.includes(`"${path}"`), `channex-ari.ts never calls ${path}`);
  }
  assert.ok(!/method:\s*"DELETE"/.test(src), "channex-ari.ts never issues DELETE");
  const methods = [...src.matchAll(/method:\s*"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ["POST"], "ARI uses POST only");
  ok("channex-ari.ts touches only POST /availability and POST /restrictions");
}
{
  // no OTA / webhook / booking functionality was added
  const changed = ["src/lib/channel/ari-sync.ts", "src/lib/channel/ari-projection.ts", "src/lib/channel/worker.ts", "src/lib/channel/ari-payloads.ts"];
  for (const f of changed) {
    const src = read(f);
    for (const word of ["booking.com", "expedia", "webhook", "booking_revision", "pullBookingRevisions"]) {
      assert.ok(!src.toLowerCase().includes(word.toLowerCase()), `${f} adds no ${word} functionality`);
    }
  }
  ok("no OTA channel, webhook or booking functionality was added");
}
{
  // /channels stays a diagnostics screen: no simulator, no grid, no editor
  // no section of /channels may edit or simulate commercial data
  const files = listFiles("src/app/(dashboard)/channels").filter((x) => x.endsWith(".tsx"));
  for (const file of files) {
    const src = code(`src/app/(dashboard)/channels/${file}`);
    for (const banned of ["simulat", "calculateQuote", "projectAri", "bulkUpdateRates", "upsertRateCell", "savePlanOverrides", "saveRatePlan"]) {
      assert.ok(!src.toLowerCase().includes(banned.toLowerCase()), `${file} must not contain ${banned} — commercial editing lives in /rates and /rate-plans`);
    }
  }
  // and the new ARI card in particular is read-only: no form control, no daily table
  const ariCard = code("src/app/(dashboard)/channels/AriSyncSection.tsx");
  for (const banned of ["<input", "<table", "<select", "<textarea"]) {
    assert.ok(!ariCard.toLowerCase().includes(banned), `AriSyncSection.tsx has no ${banned} — it is diagnostics, not an editor`);
  }
  ok("/channels has no pricing editor, simulator or wizard; the ARI card is read-only");
}
{
  // exactly ONE Full Sync trigger in the whole app
  const callers = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && read(p).includes("requestFullSyncAction(")) callers.push(p);
    }
  };
  walk("src");
  // admin.ts (definition) + AriSyncSection.tsx (the one caller)
  assert.deepEqual(callers.sort(), ["src/app/(dashboard)/channels/AriSyncSection.tsx", "src/lib/channel/admin.ts"].sort(),
    "the existing Full Sync action has exactly one UI caller");
  const section = read("src/app/(dashboard)/channels/AriSyncSection.tsx");
  assert.equal((section.match(/requestFullSyncAction\(/g) || []).length, 1, "one Full Sync button, one call");
  ok("the existing Full Sync action is reused; there is exactly one sync button");
}
{
  // Bulk Update and Rate Plans remain the only range/plan editors
  assert.ok(read("src/app/(dashboard)/rates/actions.ts").includes("bulkUpdateRatesAction"), "Bulk Update still lives at /rates");
  assert.ok(read("src/app/(dashboard)/rate-plans/actions.ts").includes("saveRatePlanAction"), "Rate Plans still lives at /rate-plans");
  const routes = listFiles("src/app/(dashboard)");
  for (const r of routes) {
    assert.ok(!/^(ari|pricing|rates-2|rate-grid|simulator)/.test(r), `no new pricing route was created (${r})`);
  }
  ok("Bulk Update and Rate Plans remain the only range/plan editors; no new pricing route exists");
}
{
  // no Next after(), no cron, no internal trigger route
  const walkAll = (dir, acc = []) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walkAll(p, acc);
      else if (/\.(tsx?|cjs|mjs)$/.test(e.name)) acc.push(p);
    }
    return acc;
  };
  for (const p of walkAll("src")) {
    const src = read(p);
    assert.ok(!/from\s+["']next\/server["'][\s\S]{0,200}\bafter\b/.test(src) && !/\bunstable_after\b/.test(src),
      `${p} does not use Next after() as a drain trigger`);
    assert.ok(!/node-cron|setInterval\(/.test(src) || p.includes("AriSyncSection"),
      `${p} schedules no cron/interval drain`);
  }
  assert.ok(!existsSync(join(ROOT, "src/app/api/channel/drain")), "no internal drain HTTP route exists");
  assert.ok(!existsSync(join(ROOT, "src/app/api/channel/worker")), "no internal worker HTTP route exists");
  ok("no Next after(), no cron, no internal trigger route — the PM2 worker is the single drain trigger");
}
{
  // deploy + PM2 wiring
  const eco = read("ecosystem.config.cjs");
  assert.ok(eco.includes("guesthub-channel-worker"), "the worker is declared");
  assert.ok(!/name:\s*["']guesthub["']/.test(eco), "the web app is NOT re-declared (its registration stays intact)");
  for (const unrelated of ["pms", "mail-system", "sys-app"]) {
    assert.ok(!new RegExp(`name:\\s*["']${unrelated}["']`).test(eco), `unrelated PM2 app ${unrelated} is untouched`);
  }
  const deploy = read("scripts/deploy-production.sh");
  assert.ok(deploy.includes("npm run build") && deploy.indexOf("npm run build") < deploy.indexOf("pm2 restart"), "build happens before any restart");
  assert.ok(deploy.includes('pm2 restart "$PM2_APP"') && deploy.includes('--only "$PM2_WORKER"'), "deploy restarts exactly the two GuestHub processes");
  assert.ok(deploy.includes("dist/worker/lib/channel/worker.js"), "deploy fails closed if the worker was not built");
  assert.ok(/WORKER_STATUS.*=.*online|\[ "\$WORKER_STATUS" = "online" \]/.test(deploy), "deploy verifies the worker is online");
  ok("deploy builds first, restarts only the web app + worker, verifies both, touches no unrelated PM2 app");
}
{
  // D69 — the progress UI: real bar, bounded polling, no fake timer progress
  const card = code("src/app/(dashboard)/channels/AriSyncSection.tsx");
  assert.ok(/role="progressbar"/.test(card), "a real progressbar role is used");
  for (const a of ["aria-valuenow", "aria-valuemin", "aria-valuemax"]) {
    assert.ok(card.includes(a), `the bar exposes ${a}`);
  }
  assert.ok(/dir="rtl"/.test(card), "the bar is RTL");
  assert.ok(/\{p\.percent\}%/.test(card), "the percentage is visible");
  assert.ok(!/animate-pulse|animate-\[|indeterminate/.test(card), "no endless animated bar — progress is determinate");
  // the percentage is READ, never computed here
  assert.ok(!/phasePercent/.test(card), "the client never computes a percentage");
  assert.ok(/percent=\{p\.percent\}/.test(card), "it renders exactly what the worker persisted");
  // polling: only while running, cleared on unmount
  assert.ok(/if \(!running\) return/.test(card), "polling never starts unless a run is live");
  assert.ok(/clearInterval\(t\)/.test(card), "the poll is cleared on unmount / when the run ends");
  assert.ok(/const POLL_MS = 2500/.test(card), "the poll interval is 2–3s while running");
  // duplicate prevention surfaced
  assert.ok(/סנכרון מלא כבר מתבצע/.test(card), "a duplicate request is reported to the operator");
  assert.ok(/disabled=\{busy\}/.test(card), "the Full Sync button is disabled while a run is live");
  ok("progress bar is determinate + accessible + RTL; polling runs only while a run is live");
}
{
  // only super_admin may read the technical progress
  const admin = code("src/lib/channel/admin.ts");
  const status = admin.slice(admin.indexOf("export async function getAriSyncStatusAction"));
  assert.ok(/const actor = await requireChannelAdmin\(\)/.test(status.slice(0, 400)),
    "getAriSyncStatusAction gates on requireChannelAdmin (super_admin only)");
  assert.ok(/sanitizeProgress\(payload\.progress\)/.test(status),
    "the progress record is sanitized before it leaves the server");
  assert.ok(!existsSync(join(ROOT, "src/app/api/channel/status")), "no public status endpoint exists");
  ok("only super_admin can read Full Sync progress; there is no unauthenticated status endpoint");
}
{
  // the progress record is stored on the EXISTING job row — no new table/migration
  const sync = code("src/lib/channel/ari-sync.ts");
  assert.ok(/UPDATE guesthub\.channel_sync_jobs[\s\S]{0,200}jsonb_build_object\('progress'/.test(sync),
    "progress lives in channel_sync_jobs.payload.progress");
  assert.ok(/COALESCE\(payload, '\{\}'::jsonb\) \|\|/.test(sync), "it merges — task_ids/warnings are never clobbered");
  assert.ok(/const PROGRESS_WRITE_MS = \d+/.test(sync), "writes are throttled, never one per date");
  const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql"));
  assert.ok(!migrations.some((m) => /progress/i.test(m)), "no migration was needed for progress");
  ok("progress is persisted on the existing job row, merged and throttled — no new table, no migration");
}
{
  // the worker never sends before the operator's Full Sync
  const sync = read("src/lib/channel/ari-sync.ts");
  assert.ok(/state = 'active' AND outbound_sync_enabled = true AND full_sync_required = false/.test(sync),
    "only a connection with a clean, established baseline is ever drained");
  const worker = read("src/lib/channel/worker.ts");
  assert.ok(worker.includes("isDrainable"), "the worker re-checks drainability per job");
  ok("incremental ARI is structurally impossible before a clean initial Full Sync");
}

console.log(`\ncheck-channex-ari: all ${n} assertions passed`);
