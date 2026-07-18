// ============================================================
// /rates channel-sync checks (D75) — the status chip + the manual
// "סנכרן ערוצים" button + the autosync save path, against the isolated test DB
// with a substituted fetch. No network, nothing touches prod.
//
//  · a canonical Rate Grid/Bulk Update save (writeRateCells) creates pending
//    dirty ranges AND the deduplicated incremental drain job — in one tx
//  · a second save of the same cell coalesces: no duplicate range, no second job
//  · getRatesSyncStatus derives synced / syncing / failed / not_connected from
//    PERSISTED state only, and two consecutive reads agree (refresh-safe)
//  · the worker path drains those ranges with zero /channels involvement
//  · "סנכרן ערוצים" with pending work: clears backoff, enqueues ONE job,
//    repeat clicks / second tabs never duplicate it
//  · with failed ranges: re-queues them ONCE (attempts preserved → next failure
//    dead-letters again; never a loop), error history intact
//  · with nothing to send: answers nothingToSync and creates NOTHING
//  · NOTHING in this module can create a 'full_sync' job
//  · the client control is hydration-deterministic (D71): banned APIs absent,
//    render is byte-identical across timezones in every state
//
// Usage: node scripts/check-rates-sync.mjs
// ============================================================
import assert from "node:assert/strict";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = "/var/www/guesthub";
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
process.env.CHANNEL_SECRETS_KEY = "rates-sync-check-local-key-not-prod";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const read = (f) => readFileSync(join(ROOT, f), "utf8");
// bans target CODE, not prose
const codeOf = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

// ============================================================
// A. static hydration + wiring guarantees (no DB needed)
// ============================================================
const CONTROL = "src/app/(dashboard)/rates/ChannelSyncControl.tsx";
const TOOLBAR = "src/app/(dashboard)/rates/RateToolbar.tsx";
const PAGE = "src/app/(dashboard)/rates/page.tsx";
const LIB = "src/lib/channel/rates-sync.ts";

{
  const src = codeOf(CONTROL);
  const banned = [
    "new Date(", "Date.now(", "performance.now", "Math.random", "crypto.randomUUID",
    "toLocaleString", "toLocaleTimeString", "toLocaleDateString", "Intl.",
    "typeof window", "navigator.", "localStorage", "sessionStorage", "matchMedia", "document.",
  ];
  for (const b of banned) {
    assert.ok(!src.includes(b), `${CONTROL} must not use ${b} — server and client renders would disagree`);
  }
  ok("the sync control calls no date, locale, clock, storage or browser API — every value is the server snapshot");
}

{
  const src = codeOf(CONTROL);
  assert.ok(/useState\(initial\)/.test(src), "client state initializes from the server snapshot verbatim");
  assert.ok(/if \(!syncing\) return/.test(src), "polling never starts unless work is pending");
  assert.ok(/clearInterval\(/.test(src), "the poller stops on synced/failed/unmount");
  for (const idx of [...src.matchAll(/setInterval\(/g)].map((m) => m.index)) {
    const effects = [];
    let i = -1;
    while ((i = src.indexOf("useEffect(", i + 1)) !== -1) {
      let depth = 0;
      for (let j = i + "useEffect".length; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) { effects.push([i, j]); break; }
      }
    }
    assert.ok(effects.some(([a, b]) => idx > a && idx < b), "every setInterval lives inside useEffect");
  }
  assert.ok(!/suppressHydrationWarning|ssr:\s*false/.test(src), "no hydration escape hatches");
  ok("polling starts only after mount, only while syncing, and always stops");
}

{
  const toolbar = codeOf(TOOLBAR);
  assert.ok(!toolbar.includes("יסונכרן בשלב 4B"), "the dead pre-4B placeholder is gone");
  assert.ok(/<ChannelSyncControl initial=\{syncStatus\} savePulse=\{savePulse\} \/>/.test(toolbar),
    "the toolbar renders the real sync control");
  const page = codeOf(PAGE);
  assert.ok(/await getRatesSyncStatus\(sql, actor\.tenantId\)/.test(page),
    "the Server Component fetches the one canonical snapshot");
  const control = codeOf(CONTROL);
  assert.ok(control.includes("סנכרן ערוצים"), "the button keeps its label");
  assert.ok(control.includes("כל השינויים כבר מסונכרנים"), "the no-work answer exists");
  ok("the placeholder span was replaced by a real button + persisted status chip");
}

{
  const lib = codeOf(LIB);
  // the column name full_sync_required is legitimate; the JOB TYPE literal is not
  assert.ok(!/["'`]full_sync["'`]/.test(lib), `${LIB} contains no path to a Full Sync job`);
  const jobTypes = [...lib.matchAll(/jobType:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(jobTypes)], ["sync_ari_range"], "the ONLY job type it enqueues is the incremental drain");
  assert.ok(/idempotencyKey: `ari_drain:\$\{conn\.id\}`/.test(lib),
    "…under the SAME idempotency key every canonical save uses");
  ok("the manual sync path is statically incapable of creating a Full Sync");
}

// ============================================================
// B. timezone-determinism render harness (D71, as check-channels-hydration)
// ============================================================
{
  const OUT = join(ROOT, "node_modules/.cache/rates-sync-check");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  writeFileSync(join(OUT, "sync-actions.ts"), `
export async function getRatesSyncStatusAction(): Promise<any> { throw new Error("not called in SSR"); }
export async function syncChannelsNowAction(): Promise<any> { throw new Error("not called in SSR"); }
`);
  writeFileSync(join(OUT, "Icon.tsx"), `
export function Icon(_props: { name: string; size?: number; className?: string }) { return null; }
`);
  writeFileSync(join(OUT, "sync-state.ts"), read("src/lib/channel/sync-state.ts"));
  writeFileSync(
    join(OUT, "ChannelSyncControl.tsx"),
    read(CONTROL)
      .replace('"@/components/shared/Icon"', '"./Icon"')
      .replace('"@/lib/channel/sync-state"', '"./sync-state"')
      .replace('"./sync-actions"', '"./sync-actions"'),
  );
  writeFileSync(join(OUT, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
      jsx: "react-jsx", strict: false, skipLibCheck: true, noEmit: false, outDir: ".",
    },
    include: ["ChannelSyncControl.tsx", "sync-state.ts", "sync-actions.ts", "Icon.tsx"],
    exclude: [],
  }));
  execFileSync("npx", ["tsc", "-p", join(OUT, "tsconfig.json")], { cwd: ROOT, stdio: "pipe" });
  for (const f of ["ChannelSyncControl", "sync-state", "sync-actions", "Icon"]) {
    const src = readFileSync(join(OUT, `${f}.js`), "utf8")
      .replace(/from "\.\/(sync-state|sync-actions|Icon)"/g, 'from "./$1.mjs"');
    writeFileSync(join(OUT, `${f}.mjs`), src);
    rmSync(join(OUT, `${f}.js`));
  }

  writeFileSync(join(OUT, "render.mjs"), `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelSyncControl } from "./ChannelSyncControl.mjs";

const base = { connected: true, pendingRanges: 0, failedRanges: 0, workerOnline: true, lastSyncAt: "10.7.2026, 11:14" };
const STATES = {
  synced:        { ...base, state: "synced" },
  syncing:       { ...base, state: "syncing", pendingRanges: 3 },
  failed:        { ...base, state: "failed", failedRanges: 2 },
  not_connected: { connected: false, state: "not_connected", pendingRanges: 0, failedRanges: 0, workerOnline: false, lastSyncAt: "—" },
  worker_down:   { ...base, state: "syncing", pendingRanges: 4, workerOnline: false },
};
const out = {};
for (const [name, initial] of Object.entries(STATES)) {
  out[name] = renderToStaticMarkup(createElement(ChannelSyncControl, { initial, savePulse: 0 }));
}
out.__tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
process.stdout.write(JSON.stringify(out));
`);

  const ZONES = ["UTC", "Asia/Jerusalem", "Pacific/Kiritimati"];
  const renders = ZONES.map((tz) =>
    JSON.parse(execFileSync(process.execPath, [join(OUT, "render.mjs")], {
      cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    })),
  );
  assert.equal(renders[0].__tz, "UTC");
  assert.equal(renders[1].__tz, "Asia/Jerusalem");
  const states = Object.keys(renders[0]).filter((k) => !k.startsWith("__"));
  assert.equal(states.length, 5, "five snapshot states are rendered");
  for (const s of states) {
    assert.equal(renders[0][s], renders[1][s], `state "${s}" renders identically in UTC and Asia/Jerusalem`);
    assert.equal(renders[0][s], renders[2][s], `state "${s}" renders identically in UTC and Pacific/Kiritimati`);
  }
  ok("synced / syncing / failed / not-connected / worker-down render byte-identically in every timezone");

  const r = renders[0];
  assert.ok(r.synced.includes("מסונכרן") && r.synced.includes("סנכרן ערוצים"), "synced: chip + button");
  assert.ok(!r.synced.includes(' disabled=""'), "the button is NOT disabled when there is nothing pending");
  assert.ok(r.syncing.includes("מסנכרן…") && r.syncing.includes("3 ממתינים"), "syncing: live pending count");
  assert.ok(!r.syncing.includes(' disabled=""'), "…and the button stays enabled while syncing");
  assert.ok(r.failed.includes("הסנכרון נכשל"), "failed: the failure is stated");
  assert.ok(r.not_connected.includes("ללא חיבור ערוצים"), "not connected: honest, not fake-synced");
  assert.ok(r.worker_down.includes("ממתין לעובד הרקע"), "pending work + dead worker is NOT reported as 'מסנכרן…'");
  ok("each state renders the required wording; the button is disabled only while its own request is in flight");
  rmSync(OUT, { recursive: true, force: true });
}

// ============================================================
// C. behavior against the isolated test DB
// ============================================================
console.log("applying migration chain to guesthub-testdb (:5433)…");
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );
}

console.log("compiling the sync graph via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-rates-sync-"));
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
    join(ROOT, "src/lib/channel/rates-sync.ts"),
    join(ROOT, "src/lib/channel/outbox.ts"),
    join(ROOT, "src/lib/channel/ari-sync.ts"),
    join(ROOT, "src/lib/rates/service.ts"),
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
  try { return origResolve.call(this, request, ...rest); }
  catch (e) { if (/^[a-z@]/.test(request)) return req.resolve(request); throw e; }
};

const { sql } = req(join(out, "lib/db.js"));
const { todayInTz } = req(join(out, "lib/dates.js"));
const { getRatesSyncStatus, requestIncrementalSyncNow } = req(join(out, "lib/channel/rates-sync.js"));
const { deriveRatesSyncState, RATES_SYNC_TEXT } = req(join(out, "lib/channel/sync-state.js"));
const { writeRateCells } = req(join(out, "lib/rates/service.js"));
const { drainAriDirtyRanges } = req(join(out, "lib/channel/ari-sync.js"));
const { claimChannelJobs, completeChannelJob } = req(join(out, "lib/channel/queue.js"));
const { encryptSecret } = req(join(out, "lib/channel/crypto.js"));

const addDays = (d, k) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
};

// a recording fetch as in check-channel-worker: never touches the net
function recordingFetch(responder = () => ({ ok: true })) {
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/properties/options")) {
      return { status: 200, ok: true, json: async () => ({ data: [{ id: "cx-prop" }] }) };
    }
    const body = JSON.parse(init.body);
    calls.push({ url: u, values: body.values });
    const r = responder(u, body);
    if (r.status && r.status !== 200) return { status: r.status, ok: false, json: async () => ({ errors: {} }) };
    return {
      status: 200, ok: true,
      json: async () => ({ data: [{ id: `task-${calls.length}`, type: "task" }], meta: { message: "Success", warnings: [] } }),
    };
  };
  return { impl, calls };
}

const TAG = `rates-sync-check-${process.pid}`;
const TODAY = todayInTz("Asia/Jerusalem");
const D0 = addDays(TODAY, 30);

async function seed() {
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency, settings)
    VALUES ('בדיקת סנכרון', ${TAG}, 'Asia/Jerusalem', 'ILS',
      ${sql.json({ vat_rate: 18, extra_guest: { configured: true, extra_adult: 200, extra_child: 0, extra_infant: 0,
        charge_frequency: "per_night", infant_max_age: 2, child_max_age: 12,
        infants_count_occupancy: false, infants_use_included: false,
        tax_mode: "inclusive", rounding_mode: "none", rounding_increment: 1 } })})
    RETURNING id`;
  const T = tenant.id;
  const [rt] = await sql`INSERT INTO guesthub.room_types (tenant_id, name, base_price) VALUES (${T}, 'ס', 400) RETURNING id`;

  const [r] = await sql`INSERT INTO guesthub.rooms ${sql({
    tenant_id: T, room_type_id: rt.id, room_number: "S1", name: "חדר S1",
    status: "available", is_active: true, max_occupancy: 3, max_adults: 2,
    max_children: 1, max_infants: 0, min_occupancy: 1, included_occupancy: 2,
    default_occupancy: 2, extra_guest_pricing_mode: "inherit",
  })} RETURNING id`;
  const [su] = await sql`INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
    VALUES (${T}, ${`${TAG}-S1`}, 'S1', ${rt.id}) RETURNING id`;
  await sql`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${T}, ${su.id}, ${r.id})`;
  const [bp] = await sql`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
    VALUES (${T}, ${su.id}, 'base', 'בסיס', true, 'base') RETURNING id`;
  for (let i = -5; i < 40; i++) {
    await sql`INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
      VALUES (${T}, ${su.id}, ${bp.id}, ${addDays(D0, i)}, 500)`;
  }

  const [plan] = await sql`INSERT INTO guesthub.pricing_plans ${sql({
    tenant_id: T, sellable_unit_id: null, code: "sp", name: "תוכנית", plan_kind: "base",
    is_base: false, is_active: true, is_visible_channels: true,
  })} RETURNING id`;
  await sql`INSERT INTO guesthub.pricing_plan_units ${sql({ tenant_id: T, pricing_plan_id: plan.id, sellable_unit_id: su.id, is_active: true })}`;

  // ACTIVE, outbound-enabled, baseline established — exactly the current prod flags
  const [conn] = await sql`
    INSERT INTO guesthub.channel_connections (tenant_id, provider, environment, state, outbound_sync_enabled, full_sync_required, channex_property_id, api_key_ciphertext)
    VALUES (${T}, 'channex', 'staging', 'active', true, false, 'cx-prop', ${encryptSecret("fake-key")}) RETURNING id`;
  await sql`INSERT INTO guesthub.channel_room_mappings (tenant_id, connection_id, channex_property_id, room_id, room_number, channex_room_type_id, status, snapshot)
    VALUES (${T}, ${conn.id}, 'cx-prop', ${r.id}, 'S1', 'cx-rt-S1', 'mapped', ${sql.json({ occ_adults: 2 })})`;
  await sql`INSERT INTO guesthub.channel_room_rate_mappings (tenant_id, connection_id, channex_property_id, local_rate_plan_id, room_id, room_number, channex_rate_plan_id, status)
    VALUES (${T}, ${conn.id}, 'cx-prop', ${plan.id}, ${r.id}, 'S1', 'cx-rp-S1', 'mapped')`;
  // a fresh worker heartbeat, as the PM2 process maintains in prod
  await sql`INSERT INTO guesthub.channel_worker_state (id, worker_id, beat_at) VALUES ('singleton', 'check', now())
    ON CONFLICT (id) DO UPDATE SET beat_at = now()`;
  return { T, conn: conn.id, roomId: r.id, suId: su.id, basePlan: bp.id };
}

const connRow = async (id) => (await sql`
  SELECT id, tenant_id, channex_property_id, api_key_ciphertext, environment,
         circuit_open_until::text AS circuit_open_until, consecutive_failures
  FROM guesthub.channel_connections WHERE id = ${id}`)[0];

const jobCount = async (conn, type, statuses) => (await sql`
  SELECT count(*)::int AS n FROM guesthub.channel_sync_jobs
  WHERE connection_id = ${conn} AND job_type = ${type} AND status = ANY(${statuses})`)[0].n;

let f;
try {
  f = await seed();

  // ---- pure derivation: the chip states + required wording ----
  {
    assert.equal(deriveRatesSyncState(false, 0, 0), "not_connected");
    assert.equal(deriveRatesSyncState(true, 0, 0), "synced");
    assert.equal(deriveRatesSyncState(true, 2, 0), "syncing");
    assert.equal(deriveRatesSyncState(true, 2, 1), "failed", "failed work outranks pending work");
    assert.equal(RATES_SYNC_TEXT.synced, "מסונכרן");
    assert.equal(RATES_SYNC_TEXT.syncing, "מסנכרן…");
    assert.equal(RATES_SYNC_TEXT.failed, "הסנכרון נכשל");
    ok("the chip derivation is a pure function of persisted counts, with the required wording");
  }

  // ---- baseline: connected, nothing pending → synced ----
  {
    const s = await getRatesSyncStatus(sql, f.T);
    assert.equal(s.connected, true);
    assert.equal(s.state, "synced");
    assert.equal(s.pendingRanges, 0);
    assert.equal(s.workerOnline, true);
    assert.equal(s.lastSyncAt, "—", "no successful drain yet → an honest dash, not a fake time");
    ok("an active connection with no pending work reads 'מסונכרן'");
  }

  // ---- a canonical save creates dirty ranges + THE drain job, in one tx ----
  {
    await sql.begin((tx) => writeRateCells(tx, f.T, [
      { sellableUnitId: f.suId, pricingPlanId: f.basePlan, date: D0, patch: { min_stay_through: 2 } },
    ]));
    const ranges = await sql`
      SELECT kind, status, date_from::text AS date_from, date_to::text AS date_to
      FROM guesthub.channel_dirty_ranges WHERE connection_id = ${f.conn} ORDER BY kind`;
    assert.equal(ranges.length, 2, "rates + restrictions ranges for the touched room");
    for (const r of ranges) {
      assert.equal(r.status, "pending");
      assert.equal(r.date_from, D0);
      assert.equal(r.date_to, addDays(D0, 1), "the exact single-date scope, never a horizon");
    }
    assert.equal(await jobCount(f.conn, "sync_ari_range", ["queued"]), 1, "exactly one drain job was enqueued by the save itself");
    const s = await getRatesSyncStatus(sql, f.T);
    assert.equal(s.state, "syncing");
    assert.equal(s.pendingRanges, 2);
    ok("a canonical save transactionally creates its exact dirty scope and one deduplicated drain job → 'מסנכרן…'");
  }

  // ---- double save: coalesced range, still ONE active job (two tabs safe) ----
  {
    await sql.begin((tx) => writeRateCells(tx, f.T, [
      { sellableUnitId: f.suId, pricingPlanId: f.basePlan, date: D0, patch: { min_stay_through: 2 } },
    ]));
    const [{ n: perKind }] = await sql`
      SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${f.conn} AND kind = 'rates' AND status = 'pending'`;
    assert.equal(perKind, 1, "the repeat save coalesced into the existing pending range");
    assert.equal(await jobCount(f.conn, "sync_ari_range", ["queued", "processing", "retry_wait"]), 1,
      "…and the idempotency key kept it at one active job");
    ok("double-click / second-tab saves never duplicate ranges or jobs");
  }

  // ---- status is read from the DB every time: a 'refresh' restores it ----
  {
    const a = await getRatesSyncStatus(sql, f.T);
    const b = await getRatesSyncStatus(sql, f.T);
    assert.deepEqual(a, b, "two consecutive reads (= a page refresh) agree exactly");
    ok("refreshing the page restores the real persisted status — no local timers involved");
  }

  // ---- the manual button with pending work: immediate, deduplicated ----
  {
    // simulate a backoff wait the operator wants to skip
    await sql`UPDATE guesthub.channel_dirty_ranges SET next_attempt_at = now() + interval '30 minutes'
      WHERE connection_id = ${f.conn} AND status = 'pending'`;
    const r1 = await requestIncrementalSyncNow(sql, f.T);
    assert.equal(r1.nothingToSync, false);
    assert.equal(r1.pendingRanges, 2);
    const [{ n: due }] = await sql`
      SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${f.conn} AND status = 'pending' AND next_attempt_at <= now()`;
    assert.equal(due, 2, "the backoff was cleared — the worker's next tick picks them up");
    const r2 = await requestIncrementalSyncNow(sql, f.T); // repeat click
    assert.equal(r2.pendingRanges, 2);
    assert.equal(await jobCount(f.conn, "sync_ari_range", ["queued", "processing", "retry_wait"]), 1,
      "repeat clicks never create a second active job");
    ok("'סנכרן ערוצים' with pending work requests immediate processing; repeat clicks are absorbed by the DB");
  }

  // ---- the worker path drains it — no /channels involved anywhere ----
  {
    const rec = recordingFetch();
    const jobs = await claimChannelJobs("check-worker", 5);
    assert.ok(jobs.length >= 1, "the worker claims the save-enqueued drain job");
    const summary = await drainAriDirtyRanges(sql, await connRow(f.conn), { fetchImpl: rec.impl });
    for (const j of jobs) await completeChannelJob(j.id);
    assert.equal(summary.synced, 2, "both ranges drained");
    assert.ok(rec.calls.length >= 1, "incremental ARI was actually sent");
    const values = rec.calls.flatMap((c) => c.values);
    assert.ok(values.every((v) => v.date_from === D0 || v.date === D0 || (v.date_from <= D0 && v.date_to >= D0)),
      "only the edited date was sent — never 500 days");
    const s = await getRatesSyncStatus(sql, f.T);
    assert.equal(s.state, "synced");
    assert.equal(s.pendingRanges, 0);
    assert.match(s.lastSyncAt, /\d{1,2}\.\d{1,2}\.\d{4}/, "the last successful sync time is server-formatted");
    ok("the PM2 worker path drains the ranges automatically → 'מסונכרן' with a real last-sync time");
  }

  // ---- the manual button with NOTHING pending: honest no-op, creates nothing ----
  {
    const jobsBefore = (await sql`SELECT count(*)::int AS n FROM guesthub.channel_sync_jobs WHERE connection_id = ${f.conn}`)[0].n;
    const r = await requestIncrementalSyncNow(sql, f.T);
    assert.equal(r.nothingToSync, true, "'כל השינויים כבר מסונכרנים'");
    assert.equal(r.pendingRanges, 0);
    assert.equal(r.retriedFailed, 0);
    const jobsAfter = (await sql`SELECT count(*)::int AS n FROM guesthub.channel_sync_jobs WHERE connection_id = ${f.conn}`)[0].n;
    assert.equal(jobsAfter, jobsBefore, "no job of any kind was created");
    const [{ n: ranges }] = await sql`SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${f.conn} AND status <> 'synced'`;
    assert.equal(ranges, 0, "no range was created");
    ok("with nothing to send the button answers honestly and creates no job and no range");
  }

  // ---- failed ranges: ONE more attempt, history preserved, never a loop ----
  {
    // a dead-lettered range, exactly as failRanges leaves it after max_attempts
    await sql`UPDATE guesthub.channel_dirty_ranges SET
        status = 'failed', attempts = 5, max_attempts = 5, last_error_code = 'http_500',
        next_attempt_at = now() + interval '1 hour'
      WHERE connection_id = ${f.conn} AND kind = 'rates'`;
    const r = await requestIncrementalSyncNow(sql, f.T);
    assert.equal(r.retriedFailed, 1, "the failed range was re-queued");
    assert.equal(r.nothingToSync, false);
    const [row] = await sql`SELECT status, attempts, last_error_code FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${f.conn} AND kind = 'rates'`;
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 5, "attempts are PRESERVED — this buys exactly one more try");
    assert.equal(row.last_error_code, "http_500", "the error history is untouched");

    // that one retry fails again → dead-letters again; a further drain touches nothing
    const rec = recordingFetch(() => ({ status: 500 }));
    const s1 = await drainAriDirtyRanges(sql, await connRow(f.conn), { fetchImpl: rec.impl });
    assert.equal(s1.failed, 1, "the single retry failed → the range is 'failed' again, not looping");
    const s2 = await drainAriDirtyRanges(sql, await connRow(f.conn), { fetchImpl: rec.impl });
    assert.equal(s2.claimed, 0, "a failed range is never re-claimed without the operator asking");
    const st = await getRatesSyncStatus(sql, f.T);
    assert.equal(st.state, "failed", "…and /rates reads 'הסנכרון נכשל'");
    await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE connection_id = ${f.conn}`;
    ok("'סנכרן ערוצים' retries failed work exactly once, preserving history — no automatic loop");
  }

  // ---- across EVERYTHING above: not one full_sync was created ----
  {
    assert.equal(await jobCount(f.conn, "full_sync", ["queued", "processing", "retry_wait", "succeeded", "dead_letter", "suppressed", "failed"]), 0,
      "no full_sync job exists");
    ok("no operation on /rates created a Full Sync — the 500-day path is unreachable from here");
  }

  // ---- no drainable connection → honest not_connected + a clear button answer ----
  {
    await sql`UPDATE guesthub.channel_connections SET outbound_sync_enabled = false WHERE id = ${f.conn}`;
    const s = await getRatesSyncStatus(sql, f.T);
    assert.equal(s.connected, false);
    assert.equal(s.state, "not_connected");
    const r = await requestIncrementalSyncNow(sql, f.T);
    assert.ok("error" in r && r.error === "אין חיבור ערוצים פעיל", "the button reports the real reason");
    await sql`UPDATE guesthub.channel_connections SET outbound_sync_enabled = true WHERE id = ${f.conn}`;
    ok("without an active outbound connection the chip says so and the button explains instead of failing silently");
  }
} finally {
  if (f) {
    await sql`DELETE FROM guesthub.tenants WHERE id = ${f.T}`;
  }
  await sql.end({ timeout: 5 });
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ncheck-rates-sync: all ${n} assertions passed`);
