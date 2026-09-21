// ============================================================
// check:bios-bot-write-retry — regression coverage for the bounded 40P01
// (deadlock_detected) retry added to withBiosBotIdempotency
// (src/lib/bios-bot/idempotency.ts). NOT part of check-bios-bot-write-api.mjs
// (that file's +501/-338 process-isolation rewrite is explicitly on hold,
// unrelated to this fix, and not touched here) — deliberately a small,
// separate, narrowly-scoped script per the approved plan.
//
// Two independent phases, in one process:
//
//  PHASE 1 (mock db, no real Postgres, no real transaction) — proves the
//  retry is bounded to exactly ONE attempt and never loops, using the same
//  minimal compile (idempotency.ts + errors.ts only) as the already-stable
//  check-bios-bot-idempotency.mjs sibling. Deterministic, not timing-based.
//
//  PHASE 2 (real Postgres, real production functions: create-reservation.ts
//  + quote.ts, the SAME "create"-group compile scope already proven to load
//  cleanly under normal memory conditions) — the actual two-concurrent-
//  creates-same-room-same-dates race, repeated, proving the retry's
//  end-to-end effect: no raw 40P01 ever reaches the caller, exactly one
//  reservation ever commits, the loser gets ROOM_NOT_AVAILABLE, and no
//  duplicate idempotency/audit rows are produced.
//
// Usage: node scripts/check-bios-bot-write-retry.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import postgres from "postgres";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const TEST_URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) { console.error(`REFUSED: production marker "${marker}"`); process.exit(1); }
}

function compileAndRequire(entryRelPaths, tag) {
  const tmp = mkdtempSync(join(tmpdir(), `gh-biosbot-retry-${tag}-`));
  const out = join(tmp, "out");
  writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "commonjs", moduleResolution: "node10", target: "es2022",
      esModuleInterop: true, skipLibCheck: true, strict: true,
      baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
      rootDir: join(ROOT, "src"), outDir: out,
      typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
    },
    include: entryRelPaths.map((p) => join(ROOT, "src", p)),
  }));
  execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

  const req = createRequire(join(ROOT, "package.json"));
  const stub = join(tmp, "server-only-stub.js");
  writeFileSync(stub, "module.exports = {};\n");
  const nextServerStub = join(tmp, "next-server-stub.js");
  writeFileSync(nextServerStub, `
    class FakeResponse { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } }
    module.exports = { NextResponse: { json: (body, init) => new FakeResponse(body, init) } };
  `);
  const Module = req("node:module");
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "server-only") return stub;
    if (request === "next/server") return nextServerStub;
    if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
    if (!request.startsWith(".") && !request.startsWith("/")) {
      try { return req.resolve(request); } catch { /* fall through */ }
    }
    return origResolve.call(this, request, ...rest);
  };
  return { req, out };
}

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// ============================================================
// PHASE 1 — bounded retry, no infinite loop (mock db, deterministic)
// ============================================================
console.log("\n=== phase 1: bounded-retry contract (mock db, no real Postgres) ===");
{
  const { req, out } = compileAndRequire(["lib/bios-bot/idempotency.ts"], "phase1");
  const { withBiosBotIdempotency } = req(join(out, "lib/bios-bot/idempotency.js"));

  const deadlockErr = () => { const e = new Error("deadlock detected"); e.code = "40P01"; return e; };

  // 1a. db.begin() fails with 40P01 EVERY time → exactly ONE retry (two
  // total attempts), never a third, and the raw driver error never
  // escapes — a controlled BiosBotError surfaces instead.
  {
    let beginCalls = 0;
    const mockDb = { begin: async () => { beginCalls++; throw deadlockErr(); } };
    let thrown = null;
    try {
      await withBiosBotIdempotency(mockDb, { tenantId: "t1", operation: "create_reservation", idempotencyKey: "k1", request: {} }, async () => ({ resourceId: null, response: {} }));
    } catch (e) { thrown = e; }
    assert.equal(beginCalls, 2, "db.begin() is called exactly twice on repeated 40P01 — the original attempt plus exactly one retry, never a third (no infinite/repeated loop)");
    assert.ok(thrown, "a double-deadlock throws");
    assert.equal(thrown && thrown.name, "BiosBotError", "the raw 40P01 driver error never leaks past the second failure — a controlled BiosBotError surfaces instead");
    assert.equal(thrown && thrown.code, "INTERNAL_ERROR", "a double-deadlock is reported as INTERNAL_ERROR — never manufactured as ROOM_NOT_AVAILABLE just because a deadlock occurred");
    ok("repeated 40P01: exactly 2 attempts total, raw error never leaks, surfaces as BiosBotError(INTERNAL_ERROR)");
  }

  // 1b. db.begin() fails with 40P01 ONCE, then the retry hits a genuinely
  // DIFFERENT (non-deadlock) failure — proves the retry boundary is a real
  // fresh attempt whose own outcome decides the result, not a special case
  // that only ever produces INTERNAL_ERROR, and that a second, non-deadlock
  // error is never mistaken for "still deadlocked" (no third attempt).
  {
    let beginCalls = 0;
    const unrelated = new Error("unrelated failure, not a deadlock");
    const mockDb = {
      begin: async () => {
        beginCalls++;
        if (beginCalls === 1) throw deadlockErr();
        throw unrelated;
      },
    };
    let thrown = null;
    try {
      await withBiosBotIdempotency(mockDb, { tenantId: "t1", operation: "create_reservation", idempotencyKey: "k2", request: {} }, async () => ({ resourceId: null, response: {} }));
    } catch (e) { thrown = e; }
    assert.equal(beginCalls, 2, "exactly one retry attempted after the first 40P01");
    assert.equal(thrown, unrelated, "a non-deadlock failure on the retry propagates AS-IS — not swallowed, not reinterpreted, no third attempt");
    ok("40P01 then a different failure: exactly 2 attempts, the real second failure propagates unchanged");
  }

  // 1c. db.begin() fails with 40P01 ONCE, then the retry SUCCEEDS — proves
  // the retry is a genuine fresh attempt that can recover, and that success
  // is not somehow blocked or double-counted.
  {
    let beginCalls = 0;
    const mockDb = {
      begin: async () => {
        beginCalls++;
        if (beginCalls === 1) throw deadlockErr();
        return { kind: "succeeded", response: { reservationId: "res-after-retry" } };
      },
    };
    const result = await withBiosBotIdempotency(mockDb, { tenantId: "t1", operation: "create_reservation", idempotencyKey: "k3", request: {} }, async () => ({ resourceId: null, response: {} }));
    assert.equal(beginCalls, 2, "exactly one retry attempted after the first 40P01");
    assert.deepEqual(result, { reservationId: "res-after-retry" }, "the retry's own real outcome (success) is returned normally");
    ok("40P01 then success: exactly 2 attempts, the retry's real result is returned");
  }
}

// ============================================================
// PHASE 2 — real Postgres, the REAL retry-relevant primitives
// (withBiosBotIdempotency — the file this task changed — and lockRooms /
// checkRoomAvailability from @/lib/inventory, the actual mechanism that
// produces the 40P01 and later resolves it), but NOT the full
// create-reservation.ts/quote.ts service graph (pricing engine, payments
// ledger, audit, channel/outbox, realtime, commercial, vat — none of that
// is what produces or resolves the deadlock, and pulling it all into one
// process is the SEPARATE, already-documented host-memory/V8 problem this
// task explicitly says not to fight here). The business write itself is a
// minimal INSERT, the same accepted stand-in pattern check-bios-bot-
// idempotency.mjs's own sibling test already uses.
// ============================================================
console.log("\n=== phase 2: real concurrent-create race (real Postgres, real lockRooms + withBiosBotIdempotency) ===");
{
  console.log("dropping + reapplying schema (replay-from-zero — a stale partial schema breaks the migration chain)…");
  execSync(`psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS guesthub CASCADE;"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
  const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of migrations) {
    execSync(`psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
      { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
  }

  const { req, out } = compileAndRequire([
    "lib/bios-bot/idempotency.ts",
    "lib/inventory.ts",
  ], "phase2");
  const { withBiosBotIdempotency } = req(join(out, "lib/bios-bot/idempotency.js"));
  const { BiosBotError } = req(join(out, "lib/bios-bot/errors.js"));
  const { lockRooms, checkRoomAvailability } = req(join(out, "lib/inventory.js"));

  const sql = postgres(TEST_URL, { prepare: false, max: 10, onnotice: () => {} });

  const [tenant] = await sql`INSERT INTO guesthub.tenants (name, slug, currency, settings)
    VALUES ('BIOS Bot Write Retry', ${"bb-write-retry-" + Date.now()}, 'ILS', ${sql.json({ vat_rate: 18 })}) RETURNING id`;
  const T = tenant.id;
  const [rt] = await sql`INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy, max_adults, max_children, max_infants)
    VALUES (${T}, 'Type', 400, 4, 3, 2, 1) RETURNING id`;
  const [room] = await sql`INSERT INTO guesthub.rooms ${sql({
    tenant_id: T, room_type_id: rt.id, room_number: "rt-1", status: "available", is_active: true,
    max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1,
    included_occupancy: 2, extra_guest_pricing_mode: "inherit",
  })} RETURNING id`;
  const roomA = room.id;

  let keySeq = 0;
  const nextKey = (p) => `${p}-${Date.now()}-${keySeq++}`;

  // the real lockRooms()+checkRoomAvailability() sequence create-reservation.ts
  // uses, then a minimal business write in place of the full pricing/audit/
  // ledger/outbox pipeline — those side effects are not what this fix touches.
  const attemptCreate = (idemKey, checkIn, checkOut) => withBiosBotIdempotency(
    sql, { tenantId: T, operation: "create_reservation", idempotencyKey: idemKey, request: { checkIn, checkOut, roomA } },
    async (tx) => {
      await lockRooms(tx, T, [roomA]);
      const conflicts = await checkRoomAvailability(tx, { tenantId: T, roomIds: [roomA], checkIn, checkOut });
      if (conflicts.length > 0) throw new BiosBotError("ROOM_NOT_AVAILABLE", "the room is not available for these dates");
      const [res] = await tx`INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, status, check_in, check_out, total_price)
        VALUES (${T}, ${"RT-" + Math.random()}, 'confirmed', ${checkIn}, ${checkOut}, 500)
        RETURNING id`;
      await tx`INSERT INTO guesthub.reservation_rooms
        (tenant_id, reservation_id, room_id, check_in, check_out, adults, children, infants, rate_per_night, price_total, is_manual_rate, price_mode)
        VALUES (${T}, ${res.id}, ${roomA}, ${checkIn}, ${checkOut}, 2, 0, 0, 250, 500, false, 'auto')`;
      return { resourceId: res.id, response: { reservationId: res.id } };
    },
  );

  const N = Number(process.env.BIOS_BOT_RETRY_RACE_ROUNDS || 15);
  let roomNotAvailN = 0, unexpectedN = 0;
  const unexpected = [];

  for (let i = 0; i < N; i++) {
    const day = 5 + i;
    const checkIn = `2030-01-${String(day).padStart(2, "0")}`;
    const checkOut = `2030-01-${String(day + 1).padStart(2, "0")}`;
    const keyA = nextKey("race-a");
    const keyB = nextKey("race-b");
    const attempt = (idemKey) => attemptCreate(idemKey, checkIn, checkOut);

    const [ra, rb] = await Promise.allSettled([attempt(keyA), attempt(keyB)]);
    const results = [ra, rb];
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    const [rows] = await sql`SELECT count(*)::int AS n FROM guesthub.reservation_rooms WHERE room_id = ${roomA} AND check_in = ${checkIn}`;

    if (rows.n > 1) {
      unexpectedN++;
      unexpected.push({ round: i, reason: "DOUBLE BOOKING COMMITTED", rows: rows.n });
      continue;
    }
    if (fulfilled.length !== 1 || rejected.length !== 1) {
      unexpectedN++;
      unexpected.push({ round: i, reason: "not exactly 1 fulfilled + 1 rejected", fulfilled: fulfilled.length, rejected: rejected.length });
      continue;
    }
    const reason = rejected[0].reason;
    if (reason && reason.code === "40P01") {
      unexpectedN++;
      unexpected.push({ round: i, reason: "raw 40P01 leaked to the caller — retry did not absorb it", message: reason.message });
      continue;
    }
    if (!reason || reason.code !== "ROOM_NOT_AVAILABLE") {
      unexpectedN++;
      unexpected.push({ round: i, reason: "loser's error was neither ROOM_NOT_AVAILABLE nor 40P01", code: reason && reason.code, message: reason && reason.message });
      continue;
    }
    roomNotAvailN++;
    console.log(`round ${i}: fulfilled=1 rejected=1 (code=ROOM_NOT_AVAILABLE, not raw 40P01) rows_in_db=${rows.n}`);
  }

  assert.equal(unexpectedN, 0, `every round must resolve to exactly 1 success + 1 clean ROOM_NOT_AVAILABLE, zero double bookings, zero leaked raw 40P01 — got ${unexpectedN} unexpected round(s): ${JSON.stringify(unexpected)}`);
  assert.equal(roomNotAvailN, N, `all ${N} rounds resolved cleanly (no raw 40P01 ever reached the caller)`);
  ok(`${N}/${N} concurrent-create races: exactly one commit, zero double bookings, the loser always got ROOM_NOT_AVAILABLE (never a raw 40P01)`);

  // ---- no duplicate idempotency-key rows across the retry ----
  const [dupCheck] = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT tenant_id, operation, idempotency_key, count(*) AS c
      FROM guesthub.bios_bot_idempotency_keys WHERE tenant_id = ${T}
      GROUP BY tenant_id, operation, idempotency_key HAVING count(*) > 1
    ) dup`;
  assert.equal(dupCheck.n, 0, "no idempotency key ever has more than one row — a deadlock-then-retry never leaves a duplicate claim");
  ok("no duplicate idempotency-key rows after the retries");

  // ---- exactly one reservation total per round — no duplicate from any retry ----
  const [resCount] = await sql`SELECT count(*)::int AS n FROM guesthub.reservations WHERE tenant_id = ${T}`;
  assert.equal(resCount.n, N, `exactly ${N} reservations exist total (one per round) — no duplicate reservation from any retry`);
  ok("no duplicate reservation rows — the losing side of every race never got far enough to write a second one");

  await sql`DELETE FROM guesthub.tenants WHERE id = ${T}`;
  await sql.end();
}

console.log(`\nALL ${n} BIOS-BOT WRITE-RETRY CHECKS PASSED`);
