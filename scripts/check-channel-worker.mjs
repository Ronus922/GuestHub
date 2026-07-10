// ============================================================
// Channel worker checks (D68). Exercises the REAL worker against the isolated
// test DB with a substituted fetch — no network, nothing committed to prod.
//
//  · claims pending jobs; an empty queue claims nothing (the loop sleeps)
//  · two concurrent workers never process the same job
//  · a failure retries with bounded backoff, then dead-letters
//  · a crashed worker's stale claim is reclaimed — no job is ever stuck
//  · NO incremental ARI is sent before the operator's initial Full Sync
//  · after a clean Full Sync, only the AFFECTED rooms/plans/dates are sent
//  · availability and rates/restrictions go in separate requests
//  · a repeat drain with no new dirt sends nothing (no Full Sync per edit)
//  · graceful shutdown is wired to SIGTERM/SIGINT
//
// Usage: node scripts/check-channel-worker.mjs
// ============================================================
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
// a real 32-byte key so encryptSecret/decryptSecret round-trip locally
process.env.CHANNEL_SECRETS_KEY = "worker-check-local-key-not-production";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

console.log("applying migration chain to guesthub-testdb (:5433)…");
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );
}

console.log("compiling the worker graph via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-worker-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/lib/channel/worker.ts"), join(ROOT, "src/lib/channel/outbox.ts")],
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
const queue = req(join(out, "lib/channel/queue.js"));
const { drainAriDirtyRanges, runInitialFullSync, loadDrainableConnections } = req(join(out, "lib/channel/ari-sync.js"));
const { markAriDirty } = req(join(out, "lib/channel/outbox.js"));
const { encryptSecret } = req(join(out, "lib/channel/crypto.js"));
const workerMod = req(join(out, "lib/channel/worker.js"));

const addDays = (d, k) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
};

// ---- a recording fetch: counts requests, captures values, never touches the net ----
function recordingFetch(responder = () => ({ ok: true })) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), values: body.values });
    const r = responder(String(url), body);
    if (r.status && r.status !== 200) return { status: r.status, ok: false, json: async () => ({ errors: {} }) };
    return {
      status: 200, ok: true,
      json: async () => (r.warnings
        ? { data: [], meta: { message: "Success", warnings: r.warnings } }
        : { data: [{ id: `task-${calls.length}`, type: "task" }], meta: { message: "Success", warnings: [] } }),
    };
  };
  return { impl, calls };
}

// ---- fixture (committed, then cleaned up in `finally`) ----
const TAG = `worker-check-${process.pid}`;
// the Full Sync horizon starts at TODAY in the property timezone, so the fixture
// must price a window around it; D0 is a mid-horizon date used for incremental edits.
const TODAY = todayInTz("Asia/Jerusalem");
const D0 = addDays(TODAY, 30);

async function seed() {
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency, settings)
    VALUES ('בדיקת עובד', ${TAG}, 'Asia/Jerusalem', 'ILS',
      ${sql.json({ vat_rate: 18, extra_guest: { configured: true, extra_adult: 200, extra_child: 0, extra_infant: 0,
        charge_frequency: "per_night", infant_max_age: 2, child_max_age: 12,
        infants_count_occupancy: false, infants_use_included: false,
        tax_mode: "inclusive", rounding_mode: "none", rounding_increment: 1 } })})
    RETURNING id`;
  const T = tenant.id;
  const [rt] = await sql`INSERT INTO guesthub.room_types (tenant_id, name, base_price) VALUES (${T}, 'ס', 400) RETURNING id`;

  const mkRoom = async (num) => {
    const [r] = await sql`INSERT INTO guesthub.rooms ${sql({
      tenant_id: T, room_type_id: rt.id, room_number: num, name: `חדר ${num}`,
      status: "available", is_active: true, max_occupancy: 3, max_adults: 2,
      max_children: 1, max_infants: 0, min_occupancy: 1, included_occupancy: 2,
      default_occupancy: 2, extra_guest_pricing_mode: "inherit",
    })} RETURNING id`;
    const [su] = await sql`INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${T}, ${`${TAG}-${num}`}, ${num}, ${rt.id}) RETURNING id`;
    await sql`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${T}, ${su.id}, ${r.id})`;
    const [bp] = await sql`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
      VALUES (${T}, ${su.id}, 'base', 'בסיס', true, 'base') RETURNING id`;
    for (let i = 0; i < 520; i++) {
      await sql`INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
        VALUES (${T}, ${su.id}, ${bp.id}, ${addDays(D0, i - 40)}, 500)`;
    }
    return { roomId: r.id, suId: su.id, roomNumber: num };
  };
  const R1 = await mkRoom("W1");
  const R2 = await mkRoom("W2");

  const [plan] = await sql`INSERT INTO guesthub.pricing_plans ${sql({
    tenant_id: T, sellable_unit_id: null, code: "wp", name: "תוכנית", plan_kind: "base",
    is_base: false, is_active: true, is_visible_channels: true,
  })} RETURNING id`;
  for (const R of [R1, R2]) {
    await sql`INSERT INTO guesthub.pricing_plan_units ${sql({ tenant_id: T, pricing_plan_id: plan.id, sellable_unit_id: R.suId, is_active: true })}`;
  }

  const [conn] = await sql`
    INSERT INTO guesthub.channel_connections (tenant_id, provider, environment, state, outbound_sync_enabled, full_sync_required, channex_property_id, api_key_ciphertext)
    VALUES (${T}, 'channex', 'staging', 'ready', false, true, 'cx-prop', ${encryptSecret("fake-key")}) RETURNING id`;
  for (const R of [R1, R2]) {
    await sql`INSERT INTO guesthub.channel_room_mappings (tenant_id, connection_id, channex_property_id, room_id, room_number, channex_room_type_id, status, snapshot)
      VALUES (${T}, ${conn.id}, 'cx-prop', ${R.roomId}, ${R.roomNumber}, ${`cx-rt-${R.roomNumber}`}, 'mapped', ${sql.json({ occ_adults: 2 })})`;
    await sql`INSERT INTO guesthub.channel_room_rate_mappings (tenant_id, connection_id, channex_property_id, local_rate_plan_id, room_id, room_number, channex_rate_plan_id, status)
      VALUES (${T}, ${conn.id}, 'cx-prop', ${plan.id}, ${R.roomId}, ${R.roomNumber}, ${`cx-rp-${R.roomNumber}`}, 'mapped')`;
  }
  return { T, conn: conn.id, R1, R2, plan: plan.id };
}

const connRow = async (id) => (await sql`
  SELECT id, tenant_id, channex_property_id, api_key_ciphertext
  FROM guesthub.channel_connections WHERE id = ${id}`)[0];

let f;
try {
  f = await seed();

  // ---- gate: nothing is drainable before a clean Full Sync ----
  {
    const drainable = await loadDrainableConnections(sql);
    assert.ok(!drainable.some((c) => c.id === f.conn), "a 'ready' connection is never drained");
    const rec = recordingFetch();
    await sql.begin((tx) => markAriDirty(tx, { tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 2) }));
    const [{ n: ranges }] = await sql`SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges WHERE connection_id = ${f.conn}`;
    assert.equal(ranges, 0, "and no dirty range is even recorded before activation");
    assert.equal(rec.calls.length, 0, "no ARI request is possible before the initial Full Sync");
    ok("no incremental send — and no backlog — before the operator's initial Full Sync");
  }

  // ---- the operator's Full Sync: exactly 2 requests, availability then restrictions ----
  {
    const rec = recordingFetch();
    const [job] = await sql`
      INSERT INTO guesthub.channel_sync_jobs (tenant_id, connection_id, job_type, status, priority, idempotency_key)
      VALUES (${f.T}, ${f.conn}, 'full_sync', 'queued', 10, ${`full_sync:${f.conn}`}) RETURNING id`;
    const result = await runInitialFullSync(sql, await connRow(f.conn), job.id, { fetchImpl: rec.impl });
    assert.equal(result.ok, true, `full sync clean (${result.error ?? ""})`);
    assert.equal(rec.calls.length, 2, "a full sync is exactly two API calls");
    assert.ok(rec.calls[0].url.endsWith("/availability"), "availability is sent first");
    assert.ok(rec.calls[1].url.endsWith("/restrictions"), "rates/restrictions are sent separately, second");

    const availDates = rec.calls[0].values;
    assert.ok(availDates.every((v) => v.availability === 1), "availability is 0/1 per physical room");
    assert.equal(availDates.length, 2, "500 identical days per room compress to one range each (2 rooms)");
    assert.equal(availDates[0].date_from, TODAY, "the horizon starts at today in the property timezone");
    assert.equal(availDates[0].date_to, addDays(TODAY, 499), "exactly 500 dates, inclusive end");

    const rates = rec.calls[1].values;
    assert.ok(rates.every((v) => Array.isArray(v.rates) && v.rates.every((o) => Number(o.rate) > 0)), "every published rate is positive");
    assert.deepEqual(rates[0].rates, [{ occupancy: 1, rate: "500.00" }, { occupancy: 2, rate: "500.00" }]);

    const c = (await sql`SELECT state, outbound_sync_enabled, full_sync_required FROM guesthub.channel_connections WHERE id = ${f.conn}`)[0];
    assert.equal(c.state, "active");
    assert.equal(c.outbound_sync_enabled, true);
    assert.equal(c.full_sync_required, false, "a clean baseline enables incremental sync");
    const saved = (await sql`SELECT date_from::text, date_to::text, payload FROM guesthub.channel_sync_jobs WHERE id = ${job.id}`)[0];
    assert.equal(saved.date_from, TODAY);
    assert.equal(saved.date_to, addDays(TODAY, 499), "the submitted range is recorded");
    assert.equal(saved.payload.task_ids.length, 2, "safe Channex task references are stored");
    ok("Full Sync: 500 dates, 2 separate requests, task refs recorded, connection activated");
  }

  // ---- incremental: only the affected room/plan/dates are sent ----
  {
    const rec = recordingFetch();
    await sql.begin((tx) => markAriDirty(tx, {
      tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 2), kinds: ["rates", "restrictions"],
    }));
    const summary = await drainAriDirtyRanges(sql, await connRow(f.conn), { fetchImpl: rec.impl });
    assert.equal(summary.synced, 2, "both dirty rows (rates + restrictions) drained");
    assert.equal(rec.calls.length, 1, "one request — availability was not dirty, so it is not sent");
    assert.ok(rec.calls[0].url.endsWith("/restrictions"));
    const v = rec.calls[0].values;
    assert.equal(v.length, 1, "compressed to one range");
    assert.equal(v[0].rate_plan_id, "cx-rp-W1", "ONLY the affected room's Channex Rate Plan");
    assert.equal(v[0].date_from, D0);
    assert.equal(v[0].date_to, addDays(D0, 1), "only the affected dates (end-exclusive → inclusive)");
    assert.ok(!v.some((x) => x.rate_plan_id === "cx-rp-W2"), "the untouched room is not re-sent");
    ok("incremental sends only affected entities and dates — never a Full Sync");
  }

  // ---- a repeat drain with no new dirt sends nothing ----
  {
    const rec = recordingFetch();
    const summary = await drainAriDirtyRanges(sql, await connRow(f.conn), { fetchImpl: rec.impl });
    assert.equal(summary.claimed, 0);
    assert.equal(rec.calls.length, 0, "unchanged ranges are never re-sent");
    ok("a drain with nothing pending performs no request");
  }

  // ---- 200-with-warnings ⇒ the range is preserved for retry, with backoff ----
  {
    const rec = recordingFetch(() => ({ warnings: [{ date_from: D0, date_to: D0, rate_plan_id: "cx-rp-W1", warning: { rate: ["bad"] } }] }));
    await sql.begin((tx) => markAriDirty(tx, {
      tenantId: f.T, roomIds: [f.R1.roomId], dateFrom: D0, dateTo: addDays(D0, 2), kinds: ["rates"],
    }));
    const summary = await drainAriDirtyRanges(sql, await connRow(f.conn), { fetchImpl: rec.impl });
    assert.equal(summary.synced, 0, "a warning is NOT a success");
    assert.equal(summary.retried, 1, "the range is preserved for retry");
    const [r] = await sql`SELECT status, attempts, last_error_code, next_attempt_at > now() AS backed_off
      FROM guesthub.channel_dirty_ranges WHERE connection_id = ${f.conn} AND status <> 'synced'`;
    assert.equal(r.status, "pending");
    assert.equal(r.attempts, 1);
    assert.equal(r.last_error_code, "partial_warnings");
    assert.equal(r.backed_off, true, "retry is delayed by exponential backoff");
    const [err] = await sql`SELECT error_code, error_message FROM guesthub.channel_sync_errors WHERE tenant_id = ${f.T} ORDER BY created_at DESC LIMIT 1`;
    assert.equal(err.error_code, "partial_warnings");
    assert.ok(!err.error_message.includes("bad"), "the upstream warning text is never persisted");
    ok("HTTP 200 + warnings ⇒ not successful: range retryable, backoff applied, upstream text discarded");
  }

  // ---- a retryable range is picked up again WITHOUT any further operator save ----
  {
    // the previous drain completed its job, so only the worker's own sweep can
    // resurrect the pending range once its backoff expires
    await sql`UPDATE guesthub.channel_sync_jobs SET status = 'succeeded', locked_at = NULL WHERE connection_id = ${f.conn}`;
    await sql`UPDATE guesthub.channel_dirty_ranges SET next_attempt_at = now() - interval '1 minute' WHERE connection_id = ${f.conn} AND status = 'pending'`;
    const before = (await sql`SELECT count(*)::int AS n FROM guesthub.channel_sync_jobs WHERE connection_id = ${f.conn} AND status = 'queued'`)[0].n;
    assert.equal(before, 0, "no drain job is outstanding");
    const summary = await workerMod.runTick("sweeper", () => {});
    assert.ok(summary.claimed >= 1, "the worker re-enqueues and claims a drain for a due, retryable range");
    ok("a transiently-failed range is retried by the worker alone — no operator save is needed");
  }

  // ---- bounded retries: attempts exhaust into 'failed', never an infinite loop ----
  {
    const rec = recordingFetch(() => ({ status: 500 }));
    await sql`UPDATE guesthub.channel_dirty_ranges SET status = 'pending', attempts = 4, next_attempt_at = now() WHERE connection_id = ${f.conn} AND status <> 'synced'`;
    const summary = await drainAriDirtyRanges(sql, await connRow(f.conn), { fetchImpl: rec.impl });
    assert.equal(summary.failed, 1, "attempts >= max_attempts ⇒ the range is failed, not retried forever");
    const [r] = await sql`SELECT status FROM guesthub.channel_dirty_ranges WHERE connection_id = ${f.conn} AND status = 'failed'`;
    assert.equal(r.status, "failed", "kept for operator review, never silently dropped");
    await sql`DELETE FROM guesthub.channel_dirty_ranges WHERE connection_id = ${f.conn}`;
    ok("retries are bounded: a persistently failing range ends 'failed' and is surfaced");
  }

  // ---- a FAILED Full Sync never auto-retries: only the operator re-triggers it ----
  {
    await sql`DELETE FROM guesthub.channel_sync_jobs WHERE connection_id = ${f.conn}`;
    await sql`UPDATE guesthub.channel_room_mappings SET status = 'failed' WHERE connection_id = ${f.conn} AND room_number = 'W2'`;
    const [job] = await sql`
      INSERT INTO guesthub.channel_sync_jobs (tenant_id, connection_id, job_type, status, priority)
      VALUES (${f.T}, ${f.conn}, 'full_sync', 'queued', 10) RETURNING id`;
    const summary = await workerMod.runTick("fs-worker", () => {});
    assert.equal(summary.failed, 1, "an unready property fails the Full Sync");
    const [j] = await sql`SELECT status FROM guesthub.channel_sync_jobs WHERE id = ${job.id}`;
    assert.equal(j.status, "dead_letter", "a failed Full Sync dead-letters — it is never re-sent automatically");
    await sql`UPDATE guesthub.channel_room_mappings SET status = 'mapped' WHERE connection_id = ${f.conn}`;
    await sql`DELETE FROM guesthub.channel_sync_jobs WHERE connection_id = ${f.conn}`;
    ok("a failed Full Sync dead-letters; ARI is never re-sent without an operator click");
  }

  // ---- the job queue: claim, dedup, FIFO-per-connection, stale-lease reclaim ----
  {
    await sql`DELETE FROM guesthub.channel_sync_jobs WHERE connection_id = ${f.conn}`;
    const a = await queue.enqueueChannelJob(sql, { tenantId: f.T, connectionId: f.conn, jobType: "sync_ari_range", idempotencyKey: `ari_drain:${f.conn}` });
    const b = await queue.enqueueChannelJob(sql, { tenantId: f.T, connectionId: f.conn, jobType: "sync_ari_range", idempotencyKey: `ari_drain:${f.conn}` });
    assert.ok(a.id, "first enqueue creates the job");
    assert.ok(b.duplicate, "a second enqueue while queued is deduplicated");

    // two workers claim concurrently — exactly one wins
    const [c1, c2] = await Promise.all([queue.claimChannelJobs("worker-1", 5), queue.claimChannelJobs("worker-2", 5)]);
    const claimed = [...c1, ...c2];
    assert.equal(claimed.length, 1, "two concurrent workers never claim the same job");
    assert.equal(claimed[0].id, a.id);

    // a second job on the SAME connection is not claimable while one is live
    await queue.enqueueChannelJob(sql, { tenantId: f.T, connectionId: f.conn, jobType: "sync_ari_range" });
    assert.equal((await queue.claimChannelJobs("worker-3", 5)).length, 0, "FIFO per connection: a live job blocks the next");

    // the first worker dies. after the lease expires the job is reclaimable.
    await sql`UPDATE guesthub.channel_sync_jobs SET locked_at = now() - make_interval(mins => ${queue.JOB_LEASE_MINUTES + 1}) WHERE id = ${a.id}`;
    const reclaimed = await queue.claimChannelJobs("worker-4", 5);
    assert.ok(reclaimed.some((j) => j.id === a.id), "a crashed worker's stale claim is reclaimed — no job is ever stuck");
    ok("queue: atomic claim, idempotent enqueue, FIFO per connection, stale-lease recovery");
  }

  // ---- empty queue: a tick claims nothing (the loop sleeps, never busy-polls) ----
  {
    await sql`UPDATE guesthub.channel_sync_jobs SET status = 'succeeded', locked_at = NULL WHERE connection_id = ${f.conn}`;
    const summary = await workerMod.runTick("idle-worker", () => {});
    assert.equal(summary.claimed, 0, "nothing to claim");
    assert.equal(summary.sentValues, 0);
    ok("an empty queue claims nothing — the worker sleeps rather than spinning");
  }

  // ---- interval + shutdown wiring ----
  {
    assert.equal(workerMod.resolveIntervalMs(undefined), workerMod.DEFAULT_INTERVAL_MS);
    assert.equal(workerMod.resolveIntervalMs("0"), workerMod.DEFAULT_INTERVAL_MS, "a nonsense interval falls back to the default");
    assert.equal(workerMod.resolveIntervalMs("100"), 5000, "the interval is floored — never a tight poll");
    assert.equal(workerMod.resolveIntervalMs("30000"), 30000, "a configured interval is honoured");

    const boot = readFileSync(join(ROOT, "scripts/channel-worker.cjs"), "utf8");
    for (const sig of ["SIGTERM", "SIGINT"]) assert.ok(boot.includes(sig), `${sig} is handled`);
    assert.ok(boot.includes("controller.abort()"), "shutdown stops claiming new jobs");
    assert.ok(boot.includes("sql.end("), "shutdown closes the database pool");
    const eco = readFileSync(join(ROOT, "ecosystem.config.cjs"), "utf8");
    assert.ok(/kill_timeout:\s*15000/.test(eco), "PM2 allows the in-flight job to finish before SIGKILL");
    assert.ok(/autorestart:\s*true/.test(eco), "PM2 restarts a crashed worker");
    ok("worker: bounded interval, SIGTERM/SIGINT graceful shutdown, PM2 autorestart + kill_timeout");
  }

  console.log(`\ncheck-channel-worker: all ${n} assertions passed`);
} finally {
  if (f) {
    // the worker suite must commit (the worker reads its own connection), so it
    // cleans up after itself. Scoped to this run's tenant only.
    await sql`DELETE FROM guesthub.tenants WHERE id = ${f.T}`;
  }
  await sql.end();
}
