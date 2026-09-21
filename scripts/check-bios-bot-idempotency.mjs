// ============================================================
// check:bios-bot-idempotency — Phase 5 §11 (migration 092,
// src/lib/bios-bot/idempotency.ts).
//
// withBiosBotIdempotency() manages its OWN top-level transaction (it must —
// that is how the claim/business-write/finalize atomicity works), so unlike
// the other check:* scripts this one does NOT wrap everything in one
// rolled-back transaction. Instead it uses a single, uniquely-named test
// tenant and explicitly DELETEs it (cascade) at the end — same end state
// ("test DB untouched"), different mechanism, because the function under
// test is specifically about real, separate commits.
//
// Usage: node scripts/check-bios-bot-idempotency.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const TEST_URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) { console.error(`REFUSED: production marker "${marker}"`); process.exit(1); }
}

console.log("applying migration chain to the test DB…");
const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  execSync(`psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
}

console.log("compiling src/lib/bios-bot/idempotency.ts via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-biosbot-idem-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/lib/bios-bot/idempotency.ts")],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const nextServerStub = join(tmp, "next-server-stub.js");
writeFileSync(nextServerStub, `
  class FakeResponse { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } }
  module.exports = { NextResponse: { json: (body, init) => new FakeResponse(body, init) } };
`);
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request === "next/server") return nextServerStub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const { withBiosBotIdempotency, hashBiosBotRequest } = req(join(out, "lib/bios-bot/idempotency.js"));
const { BiosBotError } = req(join(out, "lib/bios-bot/errors.js"));

const postgres = req("postgres");
// max > 1: the concurrency test needs two GENUINELY overlapping transactions
// on separate connections, not serialized through one.
const sql = postgres(TEST_URL, { prepare: false, max: 5, onnotice: () => {} });

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

const [tenant] = await sql`INSERT INTO guesthub.tenants (name, slug) VALUES ('BIOS Bot Idempotency', ${"bb-idem-" + Date.now()}) RETURNING id`;
const T = tenant.id;

// A minimal "business operation": inserts one row into reservations (the
// real table Phase 5 create_reservation will eventually write to) and
// returns its id — a faithful stand-in for a real write's shape
// ({ resourceId, response }).
let executionCount = 0;
const makeReservation = (label) => async (tx) => {
  executionCount++;
  const [r] = await tx`INSERT INTO guesthub.reservations
    (tenant_id, reservation_number, status, check_in, check_out, total_price)
    VALUES (${T}, ${"IDEM-" + label + "-" + Math.random()}, 'confirmed', '2027-06-01', '2027-06-02', 500)
    RETURNING id`;
  return { resourceId: r.id, response: { reservationId: r.id, label } };
};

const failingOp = async () => {
  executionCount++;
  throw new BiosBotError("ROOM_NOT_AVAILABLE", "the room is not available for these dates");
};

const crashingOp = async () => {
  executionCount++;
  throw new Error("unexpected defect, not a BiosBotError");
};

// ============================================================
// 1. same key + same request → the SAME result, run() executes ONCE
// ============================================================
{
  executionCount = 0;
  const req1 = { checkIn: "2027-06-01", checkOut: "2027-06-02", roomId: "r1" };
  const first = await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-A", request: req1 }, makeReservation("A1"));
  const second = await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-A", request: req1 }, makeReservation("A2"));
  assert.deepEqual(first, second, "the replayed result is byte-identical to the original");
  assert.equal(executionCount, 1, "the business operation ran exactly once, not twice");
  ok("same key + same request: original result replayed, business logic runs once");
}

// ============================================================
// 2. same key + DIFFERENT request → IDEMPOTENCY_CONFLICT, no re-execution
// ============================================================
{
  executionCount = 0;
  const reqDifferent = { checkIn: "2027-06-01", checkOut: "2027-06-03", roomId: "r1" }; // different checkOut
  let threw = null;
  try {
    await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-A", request: reqDifferent }, makeReservation("A3"));
  } catch (e) { threw = e; }
  assert.ok(threw, "a different request with the same key throws");
  assert.equal(threw.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(executionCount, 0, "the business operation never ran for the conflicting request");
  ok("same key + different request: IDEMPOTENCY_CONFLICT, business logic never runs");
}

// ============================================================
// 3. field order in the request must not produce a false conflict
// ============================================================
{
  const a = { checkIn: "2027-07-01", checkOut: "2027-07-02", roomId: "r9" };
  const b = { roomId: "r9", checkOut: "2027-07-02", checkIn: "2027-07-01" }; // same fields, different order
  assert.equal(hashBiosBotRequest(a), hashBiosBotRequest(b), "field order does not change the request hash");
  ok("hashBiosBotRequest: key order is irrelevant (deterministic, key-sorted hashing)");
}

// ============================================================
// 4. a legitimate business FAILURE is recorded and replayed identically
// ============================================================
{
  executionCount = 0;
  const reqFail = { roomId: "sold-out" };
  let first = null;
  try { await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-fail", request: reqFail }, failingOp); }
  catch (e) { first = e; }
  assert.ok(first, "the first attempt fails");
  assert.equal(first.code, "ROOM_NOT_AVAILABLE");
  assert.equal(executionCount, 1);

  let second = null;
  try { await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-fail", request: reqFail }, failingOp); }
  catch (e) { second = e; }
  assert.ok(second, "the replay also throws");
  assert.equal(second.code, "ROOM_NOT_AVAILABLE");
  assert.equal(second.message, first.message);
  assert.equal(executionCount, 1, "the failing operation was NOT re-executed on replay — the cached failure was returned");
  ok("same key + same request, previous attempt FAILED: the same failure replays, business logic runs once");
}

// ============================================================
// 5. an unexpected (non-BiosBotError) exception leaves NO trace — safe to retry
// ============================================================
{
  executionCount = 0;
  let threw = null;
  try { await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-crash", request: { x: 1 } }, crashingOp); }
  catch (e) { threw = e; }
  assert.ok(threw, "the unexpected exception propagates");
  assert.equal(threw.message, "unexpected defect, not a BiosBotError");

  const [row] = await sql`SELECT id FROM guesthub.bios_bot_idempotency_keys WHERE tenant_id=${T} AND operation='create_reservation' AND idempotency_key='key-crash'`;
  assert.equal(row, undefined, "no idempotency row was left behind — the whole transaction rolled back, claim included");

  executionCount = 0;
  const retried = await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-crash", request: { x: 1 } }, makeReservation("retry-after-crash"));
  assert.equal(executionCount, 1, "a retry after an unexpected crash runs the business logic fresh — it is not treated as a duplicate");
  assert.ok(retried.reservationId);
  ok("an unexpected exception leaves no idempotency record; a retry with the same key runs fresh and can succeed");
}

// ============================================================
// 6. concurrency: two GENUINELY parallel requests, same key — exactly one execution
// ============================================================
{
  executionCount = 0;
  const reqConcurrent = { roomId: "concurrent-room", checkIn: "2027-09-01", checkOut: "2027-09-02" };
  const [a, b] = await Promise.all([
    withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-concurrent", request: reqConcurrent }, makeReservation("C-first")),
    withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: "key-concurrent", request: reqConcurrent }, makeReservation("C-second")),
  ]);
  assert.deepEqual(a, b, "both concurrent callers receive the identical result");
  assert.equal(executionCount, 1, "the business operation executed exactly once despite two truly concurrent callers");
  const rows = await sql`SELECT count(*)::int AS n FROM guesthub.reservations WHERE tenant_id=${T} AND reservation_number LIKE 'IDEM-C-%'`;
  assert.equal(rows[0].n, 1, "exactly one reservation row was created, not two");
  ok("concurrent same-key requests: exactly one execution, both callers get the same result, no duplicate row");
}

// ============================================================
// 7. DB-level: the unique constraint is real (not just application discipline)
// ============================================================
{
  let threw = null;
  try {
    await sql`INSERT INTO guesthub.bios_bot_idempotency_keys (tenant_id, operation, idempotency_key, request_hash, status, completed_at)
      VALUES (${T}, 'dup_test', 'same-key', 'hash1', 'succeeded', now())`;
    await sql`INSERT INTO guesthub.bios_bot_idempotency_keys (tenant_id, operation, idempotency_key, request_hash, status, completed_at)
      VALUES (${T}, 'dup_test', 'same-key', 'hash2', 'succeeded', now())`;
  } catch (e) { threw = e; }
  assert.ok(threw, "a second row with the same (tenant, operation, key) is rejected");
  assert.equal(threw.code, "23505", "rejected by the UNIQUE constraint, a real DB-level guarantee");
  ok("DB-level: UNIQUE(tenant_id, operation, idempotency_key) rejects a duplicate, not just application code");
}

await sql`DELETE FROM guesthub.tenants WHERE id = ${T}`; // cascades: idempotency keys + reservations
await sql.end();
console.log(`\nALL ${n} BIOS-BOT IDEMPOTENCY CHECKS PASSED`);
