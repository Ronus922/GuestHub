// ============================================================
// STAGING fixture harness for the four Beds24 health guards.
//
// WHY. The guards used to observe PRODUCTION (`node --env-file=.env.local`,
// reading DATABASE_URL). That is forbidden for an automated check, and it also
// made them unrunnable anywhere else: in any worktree the process died with
// `node: .env.local: not found` (exit 9) BEFORE the first assertion, i.e. red
// in every state, healthy or broken. Red-in-every-state carries exactly as
// little signal as green-in-every-state.
//
// WHAT THIS DOES INSTEAD. Each guard opens ONE transaction on STAGING, seeds a
// scratch tenant + Beds24 connection into it, reads the state BACK out of the
// database, evaluates the rules from ./beds24-health-rules.mjs against the
// read-back values, and then ALWAYS rolls back.
//
// SAFETY PROPERTIES, in order of importance:
//   · The target is resolved by ./check-db-target.mjs, which consults
//     CHECK_DB_URL || STAGING_DATABASE_URL and DELIBERATELY IGNORES
//     DATABASE_URL. A stray --env-file=.env.local can no longer aim these at
//     production.
//   · Every write happens inside a transaction that is unconditionally rolled
//     back — including on success. Nothing is ever committed.
//   · Nothing is ever DELETEd. The fixture only INSERTs, and the rollback
//     undoes those inserts; no pre-existing row is read for modification.
//   · assertNoNetRows() re-counts the four tables after the rollback and fails
//     the guard if a single row leaked. A fixture that escapes its transaction
//     is a defect, not a detail.
//   · No secret value is ever read, printed or compared. `api_key_ciphertext`
//     is seeded with the literal placeholder below and the rules only ever
//     test it for PRESENCE.
// ============================================================
import { execSync } from "node:child_process";
import Module from "node:module";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Not a secret and not a credential: a fixed non-value whose only job is to be
// NOT NULL so the "a refresh token is configured" rule has something to see.
const PLACEHOLDER_CIPHERTEXT = "fixture::not-a-secret::presence-only";

export const FIXTURE_TABLES = [
  "channel_connections",
  "channel_sync_jobs",
  "channel_booking_revisions",
  "channel_dirty_ranges",
];

// ---------------------------------------------------------------
// transaction discipline
// ---------------------------------------------------------------

const ROLLBACK = Symbol("beds24-fixture-rollback");

/**
 * Run `fn(tx)` inside a transaction that is ALWAYS rolled back, and return
 * whatever `fn` returned. The rollback is forced by throwing a private
 * sentinel: there is no code path — success, assertion failure or crash —
 * that reaches a COMMIT.
 */
export async function withRollback(sql, fn) {
  let payload;
  let inner = null;
  try {
    await sql.begin(async (tx) => {
      try {
        payload = await fn(tx);
      } catch (e) {
        inner = e;
      }
      const stop = new Error("fixture rollback");
      stop.__sentinel = ROLLBACK;
      throw stop;
    });
  } catch (e) {
    if (e?.__sentinel !== ROLLBACK) throw e;
  }
  if (inner) throw inner;
  return payload;
}

/** Row counts for the fixture tables — taken before and after, and compared. */
export async function countFixtureTables(sql) {
  const out = {};
  for (const t of FIXTURE_TABLES) {
    const [r] = await sql.unsafe(`SELECT count(*)::int AS c FROM guesthub.${t}`);
    out[t] = r.c;
  }
  return out;
}

/** Fail loudly if the fixture leaked a single row past its rollback. */
export function assertNoNetRows(before, after) {
  const leaked = FIXTURE_TABLES.filter((t) => before[t] !== after[t])
    .map((t) => `${t}: ${before[t]} → ${after[t]}`);
  if (leaked.length > 0) {
    throw new Error(`FIXTURE LEAKED PAST ITS ROLLBACK — ${leaked.join(", ")}`);
  }
  return `no net rows written (${FIXTURE_TABLES.map((t) => `${t}=${after[t]}`).join(", ")})`;
}

// ---------------------------------------------------------------
// seeding
// ---------------------------------------------------------------

/**
 * Seed a scratch tenant, one room, one Beds24 connection and one mapped room
 * mapping. Everything is parameterised so the same helper builds both the
 * satisfying and the violating fixture — the two arms differ ONLY in the
 * column values, never in the shape.
 */
export async function seedConnection(tx, spec = {}) {
  const {
    provider = "beds24",
    environment = "production",
    state = "active",
    inbound = true,
    outbound = true,
    refreshToken = true,
    circuitOpenUntilSql = null, // e.g. "now() + interval '10 minutes'"
    consecutiveFailures = 0,
    isActiveProvider = true,
    fullSyncRequired = false,
    mapped = true,
  } = spec;

  const [tenant] = await tx`
    INSERT INTO guesthub.tenants (name, slug)
    VALUES ('beds24 guard fixture', ${`b24guard-${randomUUID()}`})
    RETURNING id`;
  const [room] = await tx`
    INSERT INTO guesthub.rooms (tenant_id, room_number, name)
    VALUES (${tenant.id}, ${`B24G-${randomUUID().slice(0, 8)}`}, 'fixture room')
    RETURNING id`;
  const [conn] = await tx`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, inbound_sync_enabled, outbound_sync_enabled,
       full_sync_required, api_key_ciphertext, consecutive_failures, is_active_provider,
       circuit_open_until)
    VALUES
      (${tenant.id}, ${provider}, ${environment}, ${state}, ${inbound}, ${outbound},
       ${fullSyncRequired}, ${refreshToken ? PLACEHOLDER_CIPHERTEXT : null},
       ${consecutiveFailures}, ${isActiveProvider},
       ${circuitOpenUntilSql ? tx.unsafe(circuitOpenUntilSql) : null})
    RETURNING id`;
  if (mapped) {
    await tx`
      INSERT INTO guesthub.channel_beds24_room_mappings
        (tenant_id, connection_id, room_id, beds24_property_id, beds24_room_id, status)
      VALUES (${tenant.id}, ${conn.id}, ${room.id}, 'fixture-prop', ${`fixture-room-${randomUUID().slice(0, 8)}`}, 'mapped')`;
  }
  return { tenantId: tenant.id, roomId: room.id, connectionId: conn.id };
}

/** Insert a finished job. `finishedAgoSql` is a SQL interval expression. */
export async function seedJob(tx, ids, { jobType, status, finishedAgoSql = "interval '1 hour'" }) {
  await tx`
    INSERT INTO guesthub.channel_sync_jobs
      (tenant_id, connection_id, job_type, status, started_at, finished_at)
    VALUES (${ids.tenantId}, ${ids.connectionId}, ${jobType}, ${status},
            now() - ${tx.unsafe(finishedAgoSql)}, now() - ${tx.unsafe(finishedAgoSql)})`;
}

/** Insert a booking revision at a chosen age and import/ack state. */
export async function seedRevision(tx, ids, { importStatus = "imported", ackStatus = "acknowledged", createdAgoSql = "interval '10 minutes'" }) {
  await tx`
    INSERT INTO guesthub.channel_booking_revisions
      (tenant_id, connection_id, provider_booking_id, provider_revision_id,
       revision_kind, import_status, ack_status, created_at)
    VALUES (${ids.tenantId}, ${ids.connectionId}, ${`bk-${randomUUID().slice(0, 8)}`},
            ${`rev-${randomUUID().slice(0, 8)}`}, 'new', ${importStatus}, ${ackStatus},
            now() - ${tx.unsafe(createdAgoSql)})`;
}

/** Insert a dirty ARI range at a chosen age and status. */
export async function seedDirtyRange(tx, ids, { status = "pending", createdAgoSql = "interval '10 minutes'" }) {
  await tx`
    INSERT INTO guesthub.channel_dirty_ranges
      (tenant_id, connection_id, room_id, kind, date_from, date_to, status, created_at)
    VALUES (${ids.tenantId}, ${ids.connectionId}, ${ids.roomId}, 'availability',
            current_date, current_date + 1, ${status}, now() - ${tx.unsafe(createdAgoSql)})`;
}

// ---------------------------------------------------------------
// read-back queries — the guards assert on THESE values, never on the values
// they seeded. A rule that passes on the seed but not on the read-back is a
// rule that does not describe the database.
// ---------------------------------------------------------------

export async function readActiveConnections(tx, tenantId) {
  return tx`
    SELECT provider, environment, state, inbound_sync_enabled, outbound_sync_enabled,
           (api_key_ciphertext IS NOT NULL) AS has_refresh_token,
           circuit_open_until, consecutive_failures
    FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND state = 'active'`;
}

export async function readJobHistogram(tx, tenantId, windowSql = "interval '24 hours'") {
  return tx`
    SELECT j.job_type, j.status, count(*)::int AS c
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE j.tenant_id = ${tenantId} AND cc.provider = 'beds24'
      AND j.finished_at >= now() - ${tx.unsafe(windowSql)}
    GROUP BY j.job_type, j.status`;
}

export async function readForeignJobsSinceCutover(tx, tenantId, cutoverIso) {
  const [r] = await tx`
    SELECT count(*)::int AS c
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE j.tenant_id = ${tenantId} AND cc.provider <> 'beds24'
      AND j.finished_at >= ${cutoverIso}`;
  return r.c;
}

export async function readLastSucceededPull(tx, tenantId) {
  const [r] = await tx`
    SELECT max(j.finished_at) AS last
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE j.tenant_id = ${tenantId} AND cc.provider = 'beds24'
      AND j.job_type = 'pull_booking_revisions' AND j.status = 'succeeded'`;
  return r.last;
}

export async function readStuckRevisions(tx, tenantId, graceHours) {
  const [r] = await tx`
    SELECT count(*)::int AS c FROM guesthub.channel_booking_revisions
    WHERE tenant_id = ${tenantId} AND import_status <> 'imported'
      AND created_at < now() - make_interval(hours => ${graceHours})`;
  return r.c;
}

export async function readUnacknowledgedRevisions(tx, tenantId, graceHours) {
  const [r] = await tx`
    SELECT count(*)::int AS c FROM guesthub.channel_booking_revisions
    WHERE tenant_id = ${tenantId} AND import_status = 'imported'
      AND ack_status IS DISTINCT FROM 'acknowledged'
      AND created_at < now() - make_interval(hours => ${graceHours})`;
  return r.c;
}

export async function readStaleDirtyRanges(tx, tenantId, graceHours) {
  const [r] = await tx`
    SELECT count(*)::int AS c
    FROM guesthub.channel_dirty_ranges dr
    JOIN guesthub.channel_connections cc ON cc.id = dr.connection_id
    WHERE dr.tenant_id = ${tenantId} AND cc.provider = 'beds24' AND cc.state = 'active'
      AND dr.status <> 'synced'
      AND dr.created_at < now() - make_interval(hours => ${graceHours})`;
  return r.c;
}

export async function readDirtiedAndPushed(tx, tenantId) {
  const [dirtied] = await tx`
    SELECT count(*)::int AS c FROM guesthub.channel_dirty_ranges dr
    JOIN guesthub.channel_connections cc ON cc.id = dr.connection_id
    WHERE dr.tenant_id = ${tenantId} AND cc.provider = 'beds24'
      AND dr.created_at >= now() - interval '24 hours'`;
  const [pushed] = await tx`
    SELECT count(*)::int AS c FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE j.tenant_id = ${tenantId} AND cc.provider = 'beds24'
      AND j.job_type IN ('sync_ari_range', 'full_sync') AND j.status = 'succeeded'
      AND j.finished_at >= now() - interval '24 hours'`;
  return { dirtied: dirtied.c, pushed: pushed.c };
}

// ---------------------------------------------------------------
// the REAL application modules
//
// This is what binds the guards to src/. Before TARGET 2.7 the four scripts
// imported nothing but `postgres` and `node:assert/strict`, so neutering any
// application predicate left their stdout byte-identical. Compiling the worker
// graph (~4s) and calling the shipped functions means a semantic neutering of
// circuit-breaker.ts / outbox.ts / revisions.ts / beds24-ari-sync.ts now turns
// the corresponding guard RED.
// ---------------------------------------------------------------

let cachedModules = null;

export function loadWorkerModules(dbUrl) {
  if (cachedModules) return cachedModules;
  // The compiled graph's @/lib/db builds its client from DATABASE_URL at import
  // time. Point it at the SAME staging DSN the guard resolved, so even the
  // module-level handle can never reach production.
  process.env.DATABASE_URL = dbUrl;
  process.env.CHANNEL_SECRETS_KEY ||= "beds24-health-guard-fixture-key-not-a-secret";
  execSync("pnpm exec tsc -p tsconfig.worker.json", { stdio: "inherit", cwd: REPO_ROOT });

  const OUT = join(REPO_ROOT, "dist", "worker");
  const STUB = join(REPO_ROOT, "scripts", "server-only-stub.cjs");
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "server-only") return STUB;
    if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
    return origResolve.call(this, request, ...rest);
  };
  const req = createRequire(import.meta.url);
  cachedModules = {
    circuitBreaker: req(join(OUT, "lib/channel/circuit-breaker.js")),
    ariSync: req(join(OUT, "lib/channel/beds24-ari-sync.js")),
    outbox: req(join(OUT, "lib/channel/outbox.js")),
    revisions: req(join(OUT, "lib/channel/revisions.js")),
    queue: req(join(OUT, "lib/channel/queue.js")),
  };
  return cachedModules;
}
