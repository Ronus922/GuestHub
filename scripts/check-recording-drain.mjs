// Phase 4A — RecordingChannelManagerProvider + drainDirtyRanges checks (no
// Channex, no real client, NO network — the provider is a purely in-memory
// double). Proves the outbox lifecycle drains correctly over existing
// primitives:
//   (a) markAriDirty COALESCES overlapping/adjacent ranges,
//   (b) BOTH disjoint ranges get synced — none dropped as skipped_stale
//       (the ascending-revision drain fixes the coarse-watermark hazard),
//   (c) a second drain with no new dirt records ZERO new provider calls,
//   (d) an older-revision range can NOT overwrite a newer applied revision,
//   (e) the recorded availability batch = the PHYSICAL projection, and the
//       restriction batch includes min_stay_through (the outbound fix),
//   (f) ZERO network — the provider is in-memory (no fetch/HTTP in the module).
// Usage: node --env-file=.env.test scripts/check-recording-drain.mjs
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import assert from "node:assert/strict";

// ---------- compile the channel modules (drain/outbox/provider chain) ----------
// server-only + @/lib/dates force a real tsconfig (rootDir=src, paths). The
// compiled server modules `require("server-only")`, which throws in plain Node;
// we drop an empty stub into the temp node_modules so requiring them is safe.
const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), "rec-drain-"));
const files = ["payloads", "ranges", "provider", "sync-step", "drain", "outbox"].map((f) =>
  join(root, "src/lib/channel", `${f}.ts`),
);
const cfg = {
  compilerOptions: {
    outDir: out,
    rootDir: join(root, "src"),
    module: "commonjs",
    target: "es2022",
    moduleResolution: "node10",
    skipLibCheck: true,
    esModuleInterop: true,
    strict: true,
    baseUrl: root,
    paths: { "@/*": ["src/*"] },
    types: [],
  },
  files,
};
const cfgPath = join(out, "tsconfig.drain.json");
writeFileSync(cfgPath, JSON.stringify(cfg));
execSync(`pnpm exec tsc -p ${cfgPath}`, { stdio: "inherit" });
mkdirSync(join(out, "node_modules/server-only"), { recursive: true });
writeFileSync(
  join(out, "node_modules/server-only/package.json"),
  JSON.stringify({ name: "server-only", version: "0.0.0", main: "index.js" }),
);
writeFileSync(join(out, "node_modules/server-only/index.js"), "module.exports = {};\n");

const require = createRequire(import.meta.url);
const chDir = join(out, "lib/channel");
const { RecordingChannelManagerProvider } = require(join(chDir, "provider.js"));
const { markAriDirty } = require(join(chDir, "outbox.js"));
const { drainDirtyRanges } = require(join(chDir, "drain.js"));

const nextDay = (d) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};
const availVals = (prov) =>
  prov.getRecordedCalls().filter((c) => c.method === "pushAvailability").flatMap((c) => c.batch.flatMap((b) => b.values));
const restrVals = (prov) =>
  prov.getRecordedCalls().filter((c) => c.method === "pushRestrictions").flatMap((c) => c.batch.flatMap((b) => b.values));

const sql = postgres(process.env.DATABASE_URL, { prepare: true, max: 1 });

// ranges: A+B overlap → coalesced [Aug1,Aug8); C, D disjoint.
const A = ["2026-08-01", "2026-08-05"];
const B = ["2026-08-04", "2026-08-08"];
const C = ["2026-09-01", "2026-09-05"];
const D = ["2026-10-01", "2026-10-05"];

try {
  const [{ id: tenantId }] = await sql`SELECT id FROM guesthub.tenants LIMIT 1`;

  await sql.begin(async (tx) => {
    const [t] = await tx`
      SELECT su.id AS su_id, su.room_type_id, bp.id AS plan_id, sur.room_id
      FROM guesthub.sellable_units su
      JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
      JOIN guesthub.rooms r ON r.id = sur.room_id AND r.status = 'available' AND r.is_active
      JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
      WHERE su.tenant_id = ${tenantId} AND su.room_type_id IS NOT NULL AND NOT su.is_pooled
      LIMIT 1`;
    assert.ok(t, "a one-room SU with a room_type + base plan exists in the seed");
    const rt = t.room_type_id;

    // isolate the room type to this single active SU → availability is deterministic
    await tx`
      UPDATE guesthub.sellable_units SET is_active = false
      WHERE tenant_id = ${tenantId} AND room_type_id = ${rt} AND id <> ${t.su_id}`;

    // active, outbound-enabled connection + room-type / rate-plan mappings
    const [conn] = await tx`
      INSERT INTO guesthub.channel_connections
        (tenant_id, provider, environment, state, outbound_sync_enabled, channex_property_id)
      VALUES (${tenantId}, 'channex', 'staging', 'active', true, 'PROP-DRAIN') RETURNING id`;
    await tx`
      INSERT INTO guesthub.channel_room_type_mappings
        (tenant_id, connection_id, room_type_id, channex_room_type_id, is_active, status)
      VALUES (${tenantId}, ${conn.id}, ${rt}, 'CHX-RT', true, 'mapped')`;
    await tx`
      INSERT INTO guesthub.channel_rate_plan_mappings
        (tenant_id, connection_id, room_type_id, local_plan_code, channex_rate_plan_id, currency, is_active, status)
      VALUES (${tenantId}, ${conn.id}, ${rt}, 'default', 'CHX-RP', 'ILS', true, 'mapped')`;

    // commercial rows across the Aug range carrying min_stay_through
    await tx`
      INSERT INTO guesthub.pricing_plan_rates
        (tenant_id, sellable_unit_id, pricing_plan_id, date, price, min_stay_through)
      SELECT ${tenantId}, ${t.su_id}, ${t.plan_id}, d::date, 1000, 3
      FROM generate_series(${A[0]}::date, (${B[1]}::date - 1), interval '1 day') d
      ON CONFLICT (pricing_plan_id, date) DO UPDATE SET price = 1000, min_stay_through = 3`;

    // ---- mark BOTH overlapping AND two disjoint ranges dirty (avail + restr) ----
    const KINDS = ["availability", "restrictions"];
    for (const [from, to] of [A, B, C, D]) {
      await markAriDirty(tx, { tenantId, roomTypeIds: [rt], dateFrom: from, dateTo: to, kinds: KINDS });
    }

    // ---- (a) coalescing: A+B collapsed into ONE [Aug1,Aug8) row per kind ----
    const pendAvail = await tx`
      SELECT date_from::text AS date_from, date_to::text AS date_to
      FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${conn.id} AND room_type_id = ${rt} AND kind = 'availability' AND status = 'pending'
      ORDER BY date_from`;
    assert.equal(pendAvail.length, 3, "(a) coalescing: Aug(A∪B) + Sep + Oct = 3 pending availability ranges (A,B merged)");
    assert.deepEqual(
      [pendAvail[0].date_from, pendAvail[0].date_to],
      ["2026-08-01", "2026-08-08"],
      "(a) the overlapping A,B ranges coalesced into one [Aug1,Aug8) range",
    );

    // ---- drain with the in-memory recording provider ----
    const prov = new RecordingChannelManagerProvider();
    assert.equal(prov.kind, "record", "provider is the in-memory recording double");
    const s1 = await drainDirtyRanges(tx, { tenantId, connectionId: conn.id, provider: prov });

    // 3 availability ranges + 3 restriction ranges = 6 pushed, 0 stale
    assert.deepEqual(s1, { processed: 6, synced: 6, skipped: 0 }, "first drain pushes all 6 ranges, none stale");
    const [{ n: leftover1 }] = await tx`
      SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${conn.id} AND status = 'pending'`;
    assert.equal(leftover1, 0, "the outbox drains: no pending ranges remain");

    // ---- (b) BOTH disjoint ranges (Sep, Oct) were synced — none dropped ----
    const avail = availVals(prov);
    const restr = restrVals(prov);
    assert.equal(prov.getRecordedCalls().filter((c) => c.method === "pushAvailability").length, 3, "3 availability pushes (Aug, Sep, Oct)");
    assert.equal(prov.getRecordedCalls().filter((c) => c.method === "pushRestrictions").length, 3, "3 restriction pushes (Aug, Sep, Oct)");
    assert.ok(avail.some((v) => v.date_from.startsWith("2026-09")), "(b) disjoint Sep range was synced (not dropped as stale)");
    assert.ok(avail.some((v) => v.date_from.startsWith("2026-10")), "(b) disjoint Oct range was synced (not dropped as stale)");

    // ---- (e) recorded availability = PHYSICAL projection; restriction has min_stay_through ----
    for (const v of avail) {
      const [{ avail: physical }] = await tx`
        SELECT COALESCE(SUM(i.availability), 0)::int AS avail
        FROM guesthub.sellable_unit_inventory(${tenantId}, ${v.date_from}, ${nextDay(v.date_from)}) i
        JOIN guesthub.sellable_units su ON su.id = i.sellable_unit_id AND su.is_active
        WHERE su.room_type_id = ${rt} AND i.day = ${v.date_from}`;
      assert.equal(v.availability, physical, `(e) recorded availability ${v.date_from} equals the physical inventory projection`);
    }
    assert.ok(
      restr.some((v) => v.min_stay_through === 3),
      "(e) restriction batch includes min_stay_through (the outbound fix)",
    );
    assert.ok(avail.every((v) => v.property_id === "PROP-DRAIN" && v.room_type_id === "CHX-RT"), "availability at ROOM-TYPE level via the DB mapping");
    assert.ok(restr.every((v) => v.rate_plan_id === "CHX-RP"), "restrictions at RATE-PLAN level via the DB mapping");

    // ---- (c) a second drain with no new dirt records ZERO new provider calls ----
    const before = prov.getRecordedCalls().length;
    const s2 = await drainDirtyRanges(tx, { tenantId, connectionId: conn.id, provider: prov });
    assert.deepEqual(s2, { processed: 0, synced: 0, skipped: 0 }, "second drain has nothing to do (idempotent / fully drained)");
    assert.equal(prov.getRecordedCalls().length, before, "(c) second drain records ZERO new provider calls");

    // ---- (d) an older-revision range can NOT overwrite a newer applied revision ----
    const wmBefore = Number((await tx`
      SELECT applied_revision FROM guesthub.channel_sync_state
      WHERE connection_id = ${conn.id} AND room_type_id = ${rt} AND kind = 'availability'`)[0].applied_revision);
    // inject a range with an explicitly STALE (revision 1) mark, below the watermark
    await tx`
      INSERT INTO guesthub.channel_dirty_ranges
        (tenant_id, connection_id, room_type_id, kind, date_from, date_to, revision)
      VALUES (${tenantId}, ${conn.id}, ${rt}, 'availability', '2026-11-01', '2026-11-05', 1)`;
    const before2 = prov.getRecordedCalls().length;
    const s3 = await drainDirtyRanges(tx, { tenantId, connectionId: conn.id, provider: prov });
    assert.deepEqual(s3, { processed: 1, synced: 0, skipped: 1 }, "the stale range is skipped, never synced");
    assert.equal(prov.getRecordedCalls().length, before2, "(d) the stale range triggers NO provider push");
    const wmAfter = Number((await tx`
      SELECT applied_revision FROM guesthub.channel_sync_state
      WHERE connection_id = ${conn.id} AND room_type_id = ${rt} AND kind = 'availability'`)[0].applied_revision);
    assert.equal(wmAfter, wmBefore, "(d) the watermark did NOT move backward — older revision can't overwrite newer");

    throw new Error("ROLLBACK");
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });

  // ---- (f) ZERO network — the provider module contains no HTTP client ----
  const provSrc = readFileSync("src/lib/channel/provider.ts", "utf8");
  assert.ok(
    !/\bfetch\s*\(|XMLHttpRequest|require\(['"]https?|from ['"]https?|axios|node-fetch|undici/.test(provSrc),
    "(f) provider.ts contains no fetch/HTTP client — an accidental network call is structurally impossible",
  );

  console.log("check-recording-drain: all assertions passed");
} finally {
  await sql.end();
}
