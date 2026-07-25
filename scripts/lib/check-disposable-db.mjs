// Shared disposable-database resolver for DB-backed check:* guards.
//
// WHY THIS EXISTS (measured on origin/main @ 8494385, 2026-07-25).
// Four guards opened `postgres://…@localhost:5433/postgres` — the SHARED test
// database — and immediately queried `guesthub.tenants`. They never built the
// schema. Run after a guard that happens to replay the migration chain they
// pass; run first, or after `DROP SCHEMA guesthub CASCADE`, they die with
//   PostgresError: relation "guesthub.tenants" does not exist
// before the first assertion. Their green was a property of the run ORDER, not
// of the code under test — which makes it worth nothing. Three more guards
// (`check:reservation-concurrency`, `check:payment-refund-void`,
// `check:background-job-recovery`) refused to run at all, exit 2, because no
// one had ever exported CHECK_CONCURRENCY_DB_URL.
//
// The fix is the pattern PR #114 proved for check:beds24-payload-integrity: a
// guard OWNS its database. This helper generalises it — each guard names a
// dedicated database on the ISOLATED test server, the helper creates it when
// absent and replays db/migrations into it when the schema is absent. Replay
// runs over the postgres.js client in simple-query mode, so it works against
// any reachable disposable server and does not depend on `docker exec` or on
// which role happens to own the schema.
//
// SAFETY. Fail-closed against production: any production marker in the DSN, or
// a loopback host on :5432 (the shared production/Supavisor port), aborts.
// Credentials are never printed — the redacted target is host:port/database.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

/** Substrings that mean "this is production". Fail closed on any of them. */
export const PRODUCTION_MARKERS = ["bios-vps", "guesthub.bios.co.il", "db.bios.co.il"];

/** The isolated test server. Container `guesthub-testdb`, host port 5433. */
const TEST_SERVER = "postgres://supabase_admin:guesthub_test_local@localhost:5433";

/** host:port/database — never the credentials. */
export function redactDsn(dsn) {
  try {
    const u = new URL(dsn);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable DSN>";
  }
}

/**
 * Abort the process unless `dsn` is unmistakably a disposable, non-production
 * database. Returns the DSN so it can be used inline.
 */
export function assertDisposable(dsn, label) {
  for (const marker of PRODUCTION_MARKERS) {
    if (dsn.includes(marker)) {
      console.error(`REFUSED (${label}): DSN contains production marker "${marker}"`);
      process.exit(1);
    }
  }
  let u;
  try {
    u = new URL(dsn);
  } catch {
    console.error(`REFUSED (${label}): DSN is not a URL`);
    process.exit(1);
  }
  const port = u.port || "5432";
  if (["localhost", "127.0.0.1", "::1"].includes(u.hostname) && port === "5432") {
    console.error(`REFUSED (${label}): refusing loopback :5432 — that is the shared production pooler`);
    process.exit(1);
  }
  if (u.pathname === "/postgres" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    console.error(`REFUSED (${label}): refusing the maintenance database on a remote host`);
    process.exit(1);
  }
  return dsn;
}

/**
 * Resolve the DSN for a guard's own disposable database.
 *
 * Precedence: the first non-empty environment variable named in `envVars`,
 * else the dedicated database `dbName` on the isolated test server.
 *
 * A guard that names its own database can never be poisoned — or rescued — by
 * whatever another guard did to the shared one.
 */
export function disposableDsn({ dbName, envVars = [], label = dbName }) {
  for (const name of envVars) {
    const v = process.env[name];
    if (v && v.trim()) return assertDisposable(v.trim(), `${label} via ${name}`);
  }
  return assertDisposable(`${TEST_SERVER}/${dbName}`, label);
}

/** CREATE DATABASE when it is absent. No-op when it already exists. */
async function ensureDatabase(dsn, label) {
  const u = new URL(dsn);
  const dbName = decodeURIComponent(u.pathname.slice(1));
  if (!dbName) throw new Error(`${label}: DSN carries no database name`);
  const maintenance = new URL(dsn);
  maintenance.pathname = "/postgres";
  const admin = postgres(maintenance.toString(), { prepare: false, max: 1, onnotice: () => {} });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (rows.length > 0) return false;
    await admin.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * The central predicate of this module: is the `guesthub` schema present and
 * complete enough to run a guard against? A partially-built schema is treated
 * as absent, because a guard that half-runs is worse than one that does not.
 */
export function schemaIsUsable(tableCount, minTables) {
  return tableCount >= minTables;
}

/**
 * Ensure `dsn` points at a database that exists and carries a fully replayed
 * `guesthub` schema. Idempotent; cheap when the schema is already there.
 *
 * @returns {Promise<{dsn:string, created:boolean, replayed:boolean, tables:number}>}
 */
export async function ensureDisposableSchema({ dsn, root = process.cwd(), label = "check", minTables = 40 }) {
  assertDisposable(dsn, label);
  const created = await ensureDatabase(dsn, label);
  const sql = postgres(dsn, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const count = async () => {
      const [{ c }] = await sql`
        SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'guesthub'`;
      return c;
    };
    let tables = await count();
    let replayed = false;
    if (!schemaIsUsable(tables, minTables)) {
      const dir = join(root, "db", "migrations");
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      for (const f of files) {
        await sql.unsafe(readFileSync(join(dir, f), "utf8")).simple();
      }
      replayed = true;
      tables = await count();
      if (!schemaIsUsable(tables, minTables)) {
        throw new Error(
          `${label}: replayed ${files.length} migrations into ${redactDsn(dsn)} and the guesthub schema still has only ${tables} tables`,
        );
      }
    }
    console.log(
      `${label}: disposable DB ${redactDsn(dsn)} — ${created ? "created" : "existing"}, ` +
        `${replayed ? "migrations replayed" : "schema present"}, ${tables} tables`,
    );
    return { dsn, created, replayed, tables };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
