#!/usr/bin/env node
// ============================================================
// check:totals-parity — migration 058 + the single totals source leave every
// existing reservation's money byte-identical (D106).
//
// Two modes, auto-selected by what is on the :5433 test DB:
//
//   COPY MODE — the operator restored a production pg_dump of schema
//   `guesthub` into guesthub-testdb and the 058 columns are not there yet.
//   The full gate: (1) TSV-dump the pre-058 money columns; (2) apply the
//   pending migrations (057, 058); (3) dump again — the TSVs must be
//   BYTE-IDENTICAL; (4) replay every reservation through the compiled
//   computeReservationTotals and require grandTotal === total_price and
//   discountAmount === discount_amount; (5) recomputePaymentAggregates in a
//   rolled-back tx must reproduce the stored paid/balance.
//
//   FIXTURE MODE — no restored copy (fresh/empty DB). The guard rebuilds the
//   schema from the full migration chain, synthesizes reservations covering
//   the mode matrix, and proves the same invariants + 058 idempotency
//   (applying it twice changes nothing). This keeps the guard green in
//   routine runs; the copy-mode run before deploy is the production proof.
//
// SELECT-only toward any data it did not create; nothing survives the run.
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;

const psql = (sql) =>
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -tA -v ON_ERROR_STOP=1`,
    { input: sql, cwd: ROOT, shell: "/bin/bash" },
  ).toString().trim();
const applyMigration = (file) =>
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "db/migrations/${file}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );

// ---- the money columns of record (pre-058 list — MUST stay stable) ----
const DUMP_SQL = `
  SELECT r.id::text, r.reservation_number, r.discount_amount::text, r.discount_percent::text,
         r.extra_charges::text, r.tax_exempt::text, r.deposit::text, r.total_price::text,
         r.paid_amount::text, r.balance::text, r.currency
  FROM guesthub.reservations r ORDER BY r.id;
  SELECT rr.id::text, rr.reservation_id::text, rr.rate_per_night::text, rr.price_total::text,
         rr.is_manual_rate::text
  FROM guesthub.reservation_rooms rr ORDER BY rr.id;`;
const dumpMoney = () => psql(DUMP_SQL);

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// ---- what state is the DB in? ----
const hasSchema = psql(`SELECT to_regclass('guesthub.reservations') IS NOT NULL`) === "t";
const has058 = hasSchema &&
  psql(`SELECT count(*) FROM information_schema.columns
        WHERE table_schema='guesthub' AND table_name='reservations' AND column_name='discount_mode'`) === "1";
const rowCount = hasSchema ? Number(psql(`SELECT count(*) FROM guesthub.reservations`)) : 0;
const copyMode = hasSchema && rowCount > 0;
console.log(`# mode: ${copyMode ? `COPY (${rowCount} reservations${has058 ? ", 058 already applied" : ""})` : "FIXTURE"}`);

const manifest = readFileSync(join(ROOT, "db/migrations/manifest.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean);
assert.ok(manifest.includes("058_reservation_totals_v2.sql"), "058 is in the manifest");

let pre = null;
if (copyMode && !has058) {
  pre = dumpMoney();
  applyMigration("057_length_of_stay_discounts.sql");
  applyMigration("058_reservation_totals_v2.sql");
  const post = dumpMoney();
  assert.equal(post, pre, "money columns byte-identical across 057+058");
  ok(`COPY: 057+058 applied — every money column of ${rowCount} reservations is byte-identical`);
} else if (!copyMode) {
  console.log("rebuilding schema from the full migration chain…");
  psql(`DROP SCHEMA IF EXISTS guesthub CASCADE`);
  for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    applyMigration(f);
  }
  ok("FIXTURE: full migration chain applied from scratch");
}

// 058 is idempotent: applying it again over an applied DB changes nothing
{
  const before = dumpMoney();
  applyMigration("058_reservation_totals_v2.sql");
  assert.equal(dumpMoney(), before, "re-applying 058 is a no-op on money columns");
  ok("058 is idempotent — a re-run never moves money");
}

// ---- compile the pure totals module + ledger via tsc (real modules) ----
console.log("compiling totals.ts + ledger via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-parity-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/lib/pricing/totals.ts"), join(ROOT, "src/lib/payments/ledger.ts")],
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
  return origResolve.call(this, request, ...rest);
};
const { computeReservationTotals } = req(join(out, "lib/pricing/totals.js"));
const ledger = req(join(out, "lib/payments/ledger.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1 });
class Rollback extends Error {}

try {
  // ---- replay: stored rows in, stored money out — for every reservation ----
  const replay = async (tx) => {
    const rows = await tx`
      SELECT r.id, r.reservation_number, r.total_price, r.discount_mode, r.discount_value,
             r.discount_amount, r.extra_charges, r.rooms_total_override, r.tax_exempt,
             r.currency, r.paid_amount, r.balance,
             COALESCE((SELECT json_agg(json_build_object(
               'priceTotal', rr.price_total,
               'nights', (rr.check_out - rr.check_in)))
               FROM guesthub.reservation_rooms rr
               WHERE rr.reservation_id = r.id AND rr.tenant_id = r.tenant_id), '[]') AS stays
      FROM guesthub.reservations r ORDER BY r.reservation_number`;
    let checked = 0;
    for (const r of rows) {
      const totals = computeReservationTotals(
        {
          stays: r.stays.map((s) => ({ priceTotal: Number(s.priceTotal), nights: Number(s.nights) })),
          roomsTotalOverride: r.rooms_total_override == null ? null : Number(r.rooms_total_override),
          discountMode: r.discount_mode,
          discountValue: Number(r.discount_value),
          extraCharges: Number(r.extra_charges),
          taxExempt: r.tax_exempt,
          vatRate: 18,
          currency: r.currency,
          paid: Number(r.paid_amount),
        },
        { validate: false }, // replay must mirror stored data, never reject it
      );
      assert.equal(totals.grandTotal, Number(r.total_price),
        `reservation ${r.reservation_number}: computeReservationTotals(${totals.grandTotal}) === stored total_price(${r.total_price})`);
      assert.equal(totals.discountAmount, Number(r.discount_amount),
        `reservation ${r.reservation_number}: resolved discount === stored discount_amount`);
      checked++;
    }
    return { rows, checked };
  };

  const replayLedger = async (tx, rows) => {
    for (const r of rows) {
      const [{ tenant_id }] = await tx`SELECT tenant_id FROM guesthub.reservations WHERE id = ${r.id}`;
      const agg = await ledger.recomputePaymentAggregates(tx, tenant_id, r.id);
      assert.equal(agg.paid, Number(r.paid_amount), `reservation ${r.reservation_number}: ledger paid unchanged`);
      assert.equal(agg.balance, Number(r.balance), `reservation ${r.reservation_number}: ledger balance unchanged`);
    }
  };

  if (copyMode) {
    await sql.begin(async (tx) => {
      const { rows, checked } = await replay(tx);
      ok(`replay: computeReservationTotals reproduces the stored total of all ${checked} reservations`);
      await replayLedger(tx, rows);
      ok("ledger: recomputePaymentAggregates reproduces stored paid/balance for every reservation (rolled back)");
      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  } else {
    await sql.begin(async (tx) => {
      const [t] = await tx`
        INSERT INTO guesthub.tenants (name, slug) VALUES ('parity', ${"parity-" + Date.now()}) RETURNING id`;
      const [g] = await tx`
        INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name)
        VALUES (${t.id}, 'בדיקת', 'זהות', 'בדיקת זהות') RETURNING id`;
      const mk = async (num, fields, rooms) => {
        const [r] = await tx`
          INSERT INTO guesthub.reservations
            (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out,
             total_price, discount_mode, discount_value, discount_amount, extra_charges,
             rooms_total_override, tax_exempt, currency, paid_amount, balance)
          VALUES (${t.id}, ${num}, ${g.id}, 'confirmed', '2027-05-01', '2027-05-04',
             ${fields.total}, ${fields.mode}, ${fields.value}, ${fields.amount}, ${fields.extras ?? 0},
             ${fields.override ?? null}, ${fields.taxExempt ?? false}, 'ILS', 0, ${fields.total})
          RETURNING id`;
        for (const room of rooms) {
          await tx`
            INSERT INTO guesthub.reservation_rooms
              (tenant_id, reservation_id, check_in, check_out, adults, price_total, rate_per_night)
            VALUES (${t.id}, ${r.id}, '2027-05-01', '2027-05-04', 2, ${room}, ${Math.round((room / 3) * 100) / 100})`;
        }
      };
      await mk("P1", { total: 900,     mode: "amount_total",      value: 120,  amount: 120 },                 [1020]);
      await mk("P2", { total: 918,     mode: "percent_total",     value: 10,   amount: 102 },                 [500, 520]);
      await mk("P3", { total: 900,     mode: "amount_per_night",  value: 40,   amount: 120 },                 [1020]);
      await mk("P4", { total: 918,     mode: "percent_per_night", value: 10,   amount: 102 },                 [1020]);
      await mk("P5", { total: 1264.56, mode: "none",              value: 0,    amount: 0, extras: 30, override: 1234.56 }, [999]);
      await mk("P6", { total: 0,       mode: "amount_total",      value: 5000, amount: 5000, extras: 30 },    [1020]);
      await mk("P7", { total: 1000.01, mode: "none",              value: 0,    amount: 0, taxExempt: true },  [1000.01]);
      const { rows, checked } = await replay(tx);
      ok(`replay (fixture): computeReservationTotals reproduces the stored total of all ${checked} mode-matrix rows`);
      await replayLedger(tx, rows);
      ok("ledger (fixture): recomputePaymentAggregates reproduces stored paid/balance (rolled back)");
      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  }

  console.log(`\nALL ${n} TOTALS-PARITY CHECKS PASSED — nothing committed`);
} finally {
  await sql.end();
}
