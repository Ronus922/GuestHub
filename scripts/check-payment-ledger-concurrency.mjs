#!/usr/bin/env node
// ============================================================================
// check:payment-ledger-concurrency  (B5.1 — proven bug, docs/NIGHT_AUDIT.md §3)
//
// The canonical payment ledger (src/lib/payments/ledger.ts + mutations.ts) is
// correct when money moves one write at a time and CORRUPTS when two writes for
// the SAME reservation overlap:
//
//   * over-refund race — recordRefund() reads "net captured" with a plain
//     SELECT, so two concurrent ₪60 refunds against a ₪100 capture BOTH pass the
//     "you cannot refund more than was collected" guard: the ledger itself ends
//     at −20. Money that was never collected is refunded.
//   * lost update — recomputePaymentAggregates() computes paid from the
//     statement snapshot. Under READ COMMITTED the blocked writer's UPDATE ...
//     FROM (aggregate) re-checks the target row but NOT the aggregate subquery,
//     so a concurrent capture is silently dropped from reservations.paid_amount:
//     the ledger says 220, the cached paid_amount says 170.
//
// This guard runs REAL PARALLEL TRANSACTIONS (two independent connections, both
// holding their transaction open across the other's read) against the REAL
// compiled modules — never a mirror of the SQL, never a sequential simulation.
// Every assertion is BEHAVIOURAL: values read back from the database after the
// transactions have committed. The one structural assertion is labelled
// CONTRACT and says so when it fails.
//
// ---------------------------------------------------------------------------
// WHERE IT RUNS — a DISPOSABLE database, never production, never :5432
//
//   node scripts/check-payment-ledger-concurrency.mjs
//
// With no configuration at all the guard PROVISIONS its own disposable database
// on the staging server: it reads STAGING_ADMIN_URL from .env.staging (gitignored,
// 127.0.0.1:5434), creates database `gh_payment_race` if absent, and replays
// db/migrations/*.sql into it. Nothing else on the box is touched; the whole
// database is throwaway (`DROP DATABASE gh_payment_race;` any time).
// Override with CHECK_CONCURRENCY_DB_URL=<dsn of any disposable DB> — the same
// variable check:payment-refund-void and check:reservation-concurrency want.
// The guard refuses port 5432, refuses production host markers, and refuses to
// run inside a database that is not disposable (guesthub / guesthub_staging /
// postgres).
// ============================================================================
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DISPOSABLE_DB = "gh_payment_race";
const HOLD_MS = 1200; // each worker holds its transaction open this long

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m, d) => { fail++; console.log(`  ✗ ${m}${d ? " — " + d : ""}`); };
const die = (m) => { console.error(m); process.exit(2); };

// ---------------------------------------------------------------- DB resolution
function readEnvFile(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function assertDisposable(url) {
  let u;
  try { u = new URL(url); } catch { die("CHECK_CONCURRENCY_DB_URL is not a URL"); }
  for (const marker of ["bios-vps", "guesthub.bios.co.il", "db.bios.co.il"]) {
    if (url.includes(marker)) die(`REFUSED: production marker "${marker}" in the DSN`);
  }
  if ((u.port || "5432") === "5432") die("REFUSED: port 5432 is the shared production server");
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (["guesthub", "guesthub_staging", "postgres", "template1"].includes(db)) {
    die(`REFUSED: "${db}" is not a disposable database — use a throwaway DB (e.g. ${DISPOSABLE_DB})`);
  }
  return u;
}

function psql(url, args) {
  return execFileSync("psql", [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
}

function provision() {
  const env = readEnvFile(join(ROOT, ".env.staging"));
  const admin = env.STAGING_ADMIN_URL;
  if (!admin) {
    die(
      "no CHECK_CONCURRENCY_DB_URL and no STAGING_ADMIN_URL in .env.staging.\n" +
      "Either export CHECK_CONCURRENCY_DB_URL=<dsn of a disposable DB>, or copy\n" +
      "/var/www/guesthub/.env.staging into this worktree (it is gitignored and\n" +
      "points at 127.0.0.1:5434).",
    );
  }
  const target = admin.replace(/\/[^/?]*(\?.*)?$/, `/${DISPOSABLE_DB}$1`);
  assertDisposable(target);
  const exists = psql(admin, ["-tAc", `SELECT 1 FROM pg_database WHERE datname='${DISPOSABLE_DB}'`]).trim();
  if (exists !== "1") {
    console.log(`provisioning disposable database ${DISPOSABLE_DB} on the staging server…`);
    psql(admin, ["-c", `CREATE DATABASE ${DISPOSABLE_DB}`]);
  }
  const hasSchema = psql(target, [
    "-tAc",
    "SELECT 1 FROM information_schema.tables WHERE table_schema='guesthub' AND table_name='payments'",
  ]).trim();
  if (hasSchema !== "1") {
    console.log("replaying db/migrations/*.sql into the disposable database…");
    for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
      psql(target, ["-f", join(ROOT, "db/migrations", f)]);
    }
  }
  return target;
}

const URL_ = process.env.CHECK_CONCURRENCY_DB_URL
  ? (assertDisposable(process.env.CHECK_CONCURRENCY_DB_URL), process.env.CHECK_CONCURRENCY_DB_URL)
  : provision();
console.log(`disposable DB: ${URL_.replace(/\/\/[^@]*@/, "//***:***@")}`);

// -------------------------------------------------- compile the REAL modules
// The guard must exercise src/lib/payments, not a copy of its SQL: a guard that
// re-implements the statements it is guarding cannot see a regression in them.
const tmp = mkdtempSync(join(tmpdir(), "gh-ledger-race-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/lib/payments/ledger.ts"), join(ROOT, "src/lib/payments/mutations.ts")],
}));
execFileSync("npx", ["tsc", "--project", join(tmp, "tsconfig.json")], { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const { recomputePaymentAggregates } = req(join(out, "lib/payments/ledger.js"));
const { recordRefund, voidPayment } = req(join(out, "lib/payments/mutations.js"));

// ------------------------------------------------------------------ fixtures
const postgres = req("postgres");
const opts = { prepare: false, max: 1, connection: { statement_timeout: 60000, lock_timeout: 40000 } };
const admin = postgres(URL_, opts);
const c1 = postgres(URL_, opts);
const c2 = postgres(URL_, opts);

const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const money = (n) => Math.round(Number(n) * 100) / 100;

let T;
const mkRes = async (total) =>
  (await admin`
    INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status, total_price)
    VALUES (${T}, ${uniq("PLC")}, '2027-04-01', '2027-04-04', 'confirmed', ${total})
    RETURNING id`)[0].id;

const capture = async (R, amount) => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO guesthub.payments (tenant_id, reservation_id, amount, status, paid_at)
             VALUES (${T}, ${R}, ${amount}, 'paid', now())`;
    await recomputePaymentAggregates(tx, T, R);
  });
};

/** ledger truth (the authoritative SUM) + the cached aggregates on the reservation */
const state = async (R) => {
  const [l] = await admin`
    SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::float8 AS ledger,
           count(*)::int AS rows
      FROM guesthub.payments WHERE reservation_id = ${R} AND tenant_id = ${T}`;
  const [r] = await admin`
    SELECT paid_amount::float8 AS paid, balance::float8 AS balance, total_price::float8 AS total
      FROM guesthub.reservations WHERE id = ${R} AND tenant_id = ${T}`;
  return { ledger: money(l.ledger), rows: l.rows, paid: money(r.paid), balance: money(r.balance), total: money(r.total) };
};

/**
 * Run `body` inside a real transaction on `client` and HOLD that transaction
 * open for HOLD_MS afterwards, so the sibling worker's reads happen while this
 * one is still uncommitted. Returns the wall-clock window so the guard can
 * prove the two transactions genuinely overlapped.
 */
async function heldTx(client, body) {
  const started = Date.now();
  try {
    const value = await client.begin(async (tx) => {
      const v = await body(tx);
      await tx`SELECT pg_sleep(${HOLD_MS / 1000})`;
      return v;
    });
    return { status: "fulfilled", value, started, ended: Date.now() };
  } catch (e) {
    return { status: "rejected", reason: e, started, ended: Date.now() };
  }
}

const overlapped = (a, b) => a.started < b.ended && b.started < a.ended;

// --------------------------------------------------------------------- run
try {
  [{ id: T }] = await admin`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('ledger-race', ${uniq("ledger-race")}) RETURNING id`;

  // =====================================================================
  // A. CONCURRENT OVER-REFUND (behavioural)
  //    capture 100, then two parallel refunds of 60 each. Correct: exactly one
  //    commits, the other fails closed. Broken: both commit, ledger = -20.
  // =====================================================================
  {
    const R = await mkRes(300);
    await capture(R, 100);
    const before = await state(R);
    console.log(`\nA. concurrent over-refund — captured 100, two parallel refunds of 60`);
    console.log(`   before: ledger=${before.ledger} paid_amount=${before.paid} balance=${before.balance}`);

    const refund = (tx, key) => recordRefund(tx, {
      tenantId: T, reservationId: R, amount: 60, method: "refund",
      reference: key, notes: null, idempotencyKey: `refund:${key}`,
    });
    const [w1, w2] = await Promise.all([
      heldTx(c1, (tx) => refund(tx, "race-a-1")),
      heldTx(c2, (tx) => refund(tx, "race-a-2")),
    ]);

    if (!overlapped(w1, w2)) {
      bad("A: the two transactions did NOT overlap in time — this run proved nothing",
        `w1=[${w1.started}..${w1.ended}] w2=[${w2.started}..${w2.ended}]`);
    } else {
      ok(`A: the two refund transactions genuinely overlapped (${Math.min(w1.ended, w2.ended) - Math.max(w1.started, w2.started)}ms of shared wall clock)`);
    }
    const committed = [w1, w2].filter((w) => w.status === "fulfilled" && w.value).length;
    const after = await state(R);
    console.log(`   after : ledger=${after.ledger} paid_amount=${after.paid} balance=${after.balance} (${committed}/2 refunds committed)`);
    for (const [i, w] of [w1, w2].entries()) {
      if (w.status === "rejected") console.log(`   worker ${i + 1} rejected: ${w.reason?.message}`);
    }

    if (after.ledger < -1e-9) {
      bad("A: BEHAVIOUR — the LEDGER went negative: more money was refunded than was ever captured",
        `SUM(amount) FILTER (status='paid') = ${after.ledger}`);
    } else ok("A: the ledger never goes negative under concurrent refunds");

    if (committed !== 1) {
      bad("A: BEHAVIOUR — both concurrent refunds of 60 were accepted against a capture of 100",
        `${committed} of 2 committed; exactly 1 may`);
    } else ok("A: exactly one of the two concurrent refunds committed, the other failed closed");

    if (Math.abs(after.ledger - 40) > 1e-9) {
      bad("A: BEHAVIOUR — wrong net captured after the race", `ledger=${after.ledger}, expected 40`);
    } else ok("A: net captured = 40 (100 − 60)");

    if (Math.abs(after.paid - after.ledger) > 1e-9) {
      bad("A: BEHAVIOUR — reservations.paid_amount drifted from the ledger",
        `paid_amount=${after.paid} vs ledger=${after.ledger}`);
    } else ok("A: paid_amount still equals the ledger");

    if (Math.abs(after.balance - (after.total - after.ledger)) > 1e-9) {
      bad("A: BEHAVIOUR — balance is not total_price − ledger",
        `balance=${after.balance}, total=${after.total}, ledger=${after.ledger}`);
    } else ok("A: balance = total_price − ledger");
  }

  // =====================================================================
  // B. CONCURRENT CAPTURES — lost update on the derived cache (behavioural)
  //    capture 100, then two parallel captures (50 and 70) each followed by the
  //    real recomputePaymentAggregates. Ledger truth is 220; the buggy recompute
  //    leaves paid_amount at 170 because the aggregate subquery is not
  //    re-evaluated after the blocking writer commits.
  // =====================================================================
  {
    const R = await mkRes(500);
    await capture(R, 100);
    console.log(`\nB. concurrent captures — 100 already captured, two parallel captures of 50 and 70`);

    const cap = (tx, amount, key) => (async () => {
      await tx`INSERT INTO guesthub.payments (tenant_id, reservation_id, amount, status, paid_at, idempotency_key)
               VALUES (${T}, ${R}, ${amount}, 'paid', now(), ${key})`;
      return recomputePaymentAggregates(tx, T, R);
    })();
    const [w1, w2] = await Promise.all([
      heldTx(c1, (tx) => cap(tx, 50, "race-b-1")),
      heldTx(c2, (tx) => cap(tx, 70, "race-b-2")),
    ]);
    for (const [i, w] of [w1, w2].entries()) {
      if (w.status === "rejected") console.log(`   worker ${i + 1} rejected: ${w.reason?.message}`);
    }
    if (!overlapped(w1, w2)) {
      bad("B: the two transactions did NOT overlap in time — this run proved nothing",
        `w1=[${w1.started}..${w1.ended}] w2=[${w2.started}..${w2.ended}]`);
    } else {
      ok(`B: the two capture transactions genuinely overlapped (${Math.min(w1.ended, w2.ended) - Math.max(w1.started, w2.started)}ms of shared wall clock)`);
    }

    const after = await state(R);
    console.log(`   after : ledger=${after.ledger} paid_amount=${after.paid} balance=${after.balance} (${after.rows} ledger rows)`);
    if (Math.abs(after.ledger - 220) > 1e-9) {
      bad("B: BEHAVIOUR — the ledger itself is wrong", `ledger=${after.ledger}, expected 220`);
    } else ok("B: the ledger holds all three captures (220)");

    if (Math.abs(after.paid - after.ledger) > 1e-9) {
      bad("B: BEHAVIOUR — LOST UPDATE: reservations.paid_amount dropped a concurrent capture",
        `paid_amount=${after.paid} vs ledger=${after.ledger} (difference ${money(after.ledger - after.paid)})`);
    } else ok("B: paid_amount equals the ledger after two concurrent captures");

    if (Math.abs(after.balance - (after.total - after.ledger)) > 1e-9) {
      bad("B: BEHAVIOUR — balance is not total_price − ledger",
        `balance=${after.balance}, total=${after.total}, ledger=${after.ledger}`);
    } else ok("B: balance = total_price − ledger");
  }

  // =====================================================================
  // C. CONCURRENT REFUND + VOID on the same reservation (behavioural)
  //    two captures of 100; one is voided while a refund of 100 runs in
  //    parallel. Whatever the winner, the invariants must hold: ledger >= 0
  //    and paid_amount == ledger.
  // =====================================================================
  {
    const R = await mkRes(400);
    const [p1] = await admin`INSERT INTO guesthub.payments (tenant_id, reservation_id, amount, status, paid_at)
                             VALUES (${T}, ${R}, 100, 'paid', now()) RETURNING id`;
    await capture(R, 100);
    console.log(`\nC. concurrent refund(100) + void(one 100 capture) — 200 captured`);

    const [w1, w2] = await Promise.all([
      heldTx(c1, (tx) => recordRefund(tx, {
        tenantId: T, reservationId: R, amount: 100, method: "refund",
        reference: "race-c", notes: null, idempotencyKey: "refund:race-c",
      })),
      heldTx(c2, (tx) => voidPayment(tx, T, p1.id)),
    ]);
    for (const [i, w] of [w1, w2].entries()) {
      if (w.status === "rejected") console.log(`   worker ${i + 1} rejected: ${w.reason?.message}`);
    }
    if (!overlapped(w1, w2)) {
      bad("C: the two transactions did NOT overlap in time — this run proved nothing");
    } else ok("C: refund and void genuinely overlapped");

    const after = await state(R);
    console.log(`   after : ledger=${after.ledger} paid_amount=${after.paid} balance=${after.balance}`);
    if (after.ledger < -1e-9) {
      bad("C: BEHAVIOUR — the ledger went negative", `ledger=${after.ledger}`);
    } else ok("C: the ledger never goes negative under a concurrent refund+void");
    if (Math.abs(after.paid - after.ledger) > 1e-9) {
      bad("C: BEHAVIOUR — paid_amount drifted from the ledger",
        `paid_amount=${after.paid} vs ledger=${after.ledger}`);
    } else ok("C: paid_amount equals the ledger");
  }

  // =====================================================================
  // D. two DIFFERENT reservations refunded in parallel (behavioural)
  //    the serialization must be per reservation: unrelated money keeps moving.
  // =====================================================================
  {
    const R1 = await mkRes(200), R2 = await mkRes(200);
    await capture(R1, 100); await capture(R2, 100);
    console.log(`\nD. parallel refunds on two DIFFERENT reservations — both must succeed`);
    const [w1, w2] = await Promise.all([
      heldTx(c1, (tx) => recordRefund(tx, { tenantId: T, reservationId: R1, amount: 60, method: "refund", reference: "race-d-1", notes: null, idempotencyKey: "refund:race-d-1" })),
      heldTx(c2, (tx) => recordRefund(tx, { tenantId: T, reservationId: R2, amount: 60, method: "refund", reference: "race-d-2", notes: null, idempotencyKey: "refund:race-d-2" })),
    ]);
    const s1 = await state(R1), s2 = await state(R2);
    console.log(`   after : R1 ledger=${s1.ledger} paid=${s1.paid} · R2 ledger=${s2.ledger} paid=${s2.paid}`);
    if (w1.status === "fulfilled" && w2.status === "fulfilled" &&
        Math.abs(s1.ledger - 40) < 1e-9 && Math.abs(s2.ledger - 40) < 1e-9 &&
        Math.abs(s1.paid - 40) < 1e-9 && Math.abs(s2.paid - 40) < 1e-9) {
      ok("D: refunds on different reservations do not block or corrupt each other");
    } else {
      bad("D: BEHAVIOUR — a refund on one reservation broke a parallel refund on another",
        `w1=${w1.status} w2=${w2.status} R1=${JSON.stringify(s1)} R2=${JSON.stringify(s2)}`);
    }
  }

  // =====================================================================
  // E. sequential regressions (behavioural) — the single-writer model in
  //    mutations.ts must keep working exactly as documented.
  // =====================================================================
  {
    const R = await mkRes(300);
    await capture(R, 200);
    await admin.begin(async (tx) => recordRefund(tx, {
      tenantId: T, reservationId: R, amount: 50, method: "refund",
      reference: "seq-1", notes: null, idempotencyKey: "refund:seq-1",
    }));
    let s = await state(R);
    (Math.abs(s.ledger - 150) < 1e-9 && Math.abs(s.paid - 150) < 1e-9 && Math.abs(s.balance - 150) < 1e-9)
      ? ok("E: sequential refund 50 of 200 → ledger=150 paid=150 balance=150")
      : bad("E: BEHAVIOUR — sequential refund wrong", JSON.stringify(s));

    const dup = await admin.begin(async (tx) => recordRefund(tx, {
      tenantId: T, reservationId: R, amount: 50, method: "refund",
      reference: "seq-1", notes: null, idempotencyKey: "refund:seq-1",
    }));
    s = await state(R);
    (dup === null && Math.abs(s.ledger - 150) < 1e-9)
      ? ok("E: a retried refund with the same idempotency key is suppressed")
      : bad("E: BEHAVIOUR — duplicate refund not suppressed", JSON.stringify(s));

    let blocked = false;
    try {
      await admin.begin(async (tx) => recordRefund(tx, {
        tenantId: T, reservationId: R, amount: 1000, method: "refund",
        reference: "seq-2", notes: null, idempotencyKey: "refund:seq-2",
      }));
    } catch (e) { blocked = /exceeds net captured/.test(e.message); }
    blocked ? ok("E: over-refund (1000 of 150) fails closed")
            : bad("E: BEHAVIOUR — over-refund was not rejected");

    const [pv] = await admin`INSERT INTO guesthub.payments (tenant_id, reservation_id, amount, status, paid_at)
                             VALUES (${T}, ${R}, 30, 'paid', now()) RETURNING id`;
    await admin.begin(async (tx) => recomputePaymentAggregates(tx, T, R));
    await admin.begin(async (tx) => voidPayment(tx, T, pv.id));
    s = await state(R);
    (Math.abs(s.ledger - 150) < 1e-9 && Math.abs(s.paid - 150) < 1e-9)
      ? ok("E: voiding a capture removes it from paid (back to 150)")
      : bad("E: BEHAVIOUR — void did not exclude the capture", JSON.stringify(s));
  }

  // =====================================================================
  // F. CONTRACT assertion (structural, NOT behavioural). The concurrency fix
  //    lives in ONE named seam so every money path inherits it. If this fails
  //    while A-E pass, nothing is broken for the user: it is a CONTRACT breach
  //    — the seam was renamed or inlined and the next caller will forget it.
  // =====================================================================
  {
    const ledgerSrc = readFileSync(join(ROOT, "src/lib/payments/ledger.ts"), "utf8");
    const mutSrc = readFileSync(join(ROOT, "src/lib/payments/mutations.ts"), "utf8");
    const declared = /export async function lockReservationForPaymentWrite\(/.test(ledgerSrc);
    const usedByRecompute = /lockReservationForPaymentWrite\(/.test(
      (/export async function recomputePaymentAggregates\([\s\S]*?\n}/.exec(ledgerSrc) || [""])[0]);
    const usedByMutations = (mutSrc.match(/lockReservationForPaymentWrite\(/g) || []).length >= 2;
    (declared && usedByRecompute && usedByMutations)
      ? ok("F: CONTRACT — the per-reservation write lock is one exported seam used by recompute, refund and void")
      : bad("F: CONTRACT BREACH (not a behaviour breach) — lockReservationForPaymentWrite is missing, renamed or no longer called by recompute/refund/void",
          `declared=${declared} recompute=${usedByRecompute} mutations>=2=${usedByMutations}`);
  }
} catch (e) {
  bad("run", e?.message ?? String(e));
  if (e?.stack) console.log(e.stack.split("\n").slice(1, 4).join("\n"));
} finally {
  // NOTHING is deleted: this is a disposable database. Drop the whole thing with
  //   psql "$STAGING_ADMIN_URL" -c 'DROP DATABASE gh_payment_race;'
  await Promise.allSettled([admin.end(), c1.end(), c2.end()]);
}

console.log(fail
  ? `\ncheck:payment-ledger-concurrency FAILED (${fail})`
  : "\ncheck:payment-ledger-concurrency PASSED — the ledger survives concurrent refunds, captures and voids");
process.exit(fail ? 1 : 0);
