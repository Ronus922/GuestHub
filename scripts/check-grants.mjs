#!/usr/bin/env node
// ============================================================
// check:grants — every table in schema guesthub is readable by guesthub_app.
//
// THE DEFECT CLASS (076→077 was the third occurrence, D136 the doctrine): a
// migration creates a table as supabase_admin, forgets the per-table grant,
// and the app hits "permission denied" on the first live tick. Worse, the
// live schema's grants were partly HISTORY (granted outside migrations), so a
// rebuilt-from-source schema silently diverged from production — 58 of 71
// tables unreadable on replay before migration 080. This guard measures the
// replayed truth: after the chain runs, EVERY table (and view) in guesthub
// carries SELECT for guesthub_app, schema USAGE included, and the
// schema_migrations ledger stays read-only (SELECT yes, write NO — a writable
// ledger is a corruptible record of what ran).
//
// WHERE IT RUNS: inside the suite (run-checks.mjs hands it DATABASE_URL for a
// clone built from manifest order) — it measures CODE, i.e. what the
// migration chain produces. It REFUSES production markers outright: the live
// system belongs to liveness (D138), and this guard proves nothing there that
// the replay cannot prove better.
//
// WITHOUT A DATABASE — DECIDED EXPLICITLY: no DSN → a LOUD, reported SKIP
// (exit 0) that says in so many words that nothing was verified. A silent
// pass is a guard failure; this skip is impossible to mistake for a verdict.
// A DSN that is present but unreachable is a FAILURE (exit 1), fail-closed.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN, against the real database:
//   · REVOKE mutant: inside a rolled-back transaction, SELECT is revoked from
//     one real table — the scan MUST report it, or the guard is not a guard.
//   · coverage-removal mutant: the enumeration is re-run with one table
//     filtered out (simulating a future edit that narrows the query) — the
//     independent cross-count MUST flag the mismatch.
// Usage: DATABASE_URL=<non-production DSN> node scripts/check-grants.mjs
// ============================================================
import { createRequire } from "node:module";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const DSN = process.env.CHECK_GRANTS_DB_URL || process.env.DATABASE_URL;
if (!DSN) {
  console.log("SKIP (reported, deliberate): no CHECK_GRANTS_DB_URL / DATABASE_URL — grants were NOT verified in this run.");
  console.log("     This is a skip, not a verdict. Inside the suite run-checks supplies the clone DSN and the guard always runs.");
  process.exit(0);
}
// Suite doctrine (D138): this guard measures what the MIGRATION CHAIN
// produces, on a disposable clone. Keep the marker list in sync with
// run-checks.mjs / run-liveness.mjs.
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (DSN.includes(marker)) {
    console.error(`REFUSED: production marker "${marker}" in the DSN — check:grants measures replayed clones only; the live system belongs to liveness (D138).`);
    process.exit(2);
  }
}

const require_ = createRequire(import.meta.url);
const postgres = require_("postgres");
const sql = postgres(DSN, { prepare: false, max: 1 });

const APP_ROLE = "guesthub_app";
// The enumeration under test: every relation in guesthub and whether the app
// role may SELECT from it. relkinds: r=table, p=partitioned, v=view.
const scanTables = (tx, { exclude = null } = {}) => tx`
  SELECT c.relname AS name,
         has_table_privilege(${APP_ROLE}, c.oid, 'SELECT') AS has_select
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'guesthub'
     AND c.relkind IN ('r', 'p', 'v')
     AND (${exclude}::text IS NULL OR c.relname <> ${exclude})
   ORDER BY c.relname`;

// The independent cross-count: a DIFFERENT catalog surface counting the same
// population. A future edit that quietly narrows the enumeration above cannot
// narrow this one with the same keystrokes — the counts split and the guard
// fails. (pg_tables covers r+p, pg_views covers v.)
const independentCount = async (tx) => {
  const [{ c }] = await tx`
    SELECT ((SELECT count(*) FROM pg_tables WHERE schemaname = 'guesthub')
          + (SELECT count(*) FROM pg_views  WHERE schemaname = 'guesthub'))::int AS c`;
  return c;
};

// rows + cross-count → violations. Ran on the real state, then per mutant.
const validate = (rows, crossCount) => {
  const errs = [];
  if (rows.length === 0) errs.push("the enumeration found NO relations in schema guesthub — wrong database, or the query lost its subject");
  if (rows.length !== crossCount)
    errs.push(`enumeration count (${rows.length}) != independent catalog count (${crossCount}) — the scan is no longer seeing every table; a narrowed query reads as full coverage`);
  for (const r of rows)
    if (r.has_select !== true)
      errs.push(`guesthub.${r.name} has NO SELECT for ${APP_ROLE} — a rebuilt schema would refuse the app here (076→077 class; migration 080 is the fence)`);
  return errs;
};

try {
  // matviews would silently fall outside pg_tables/pg_views — refuse to
  // guess: extend both surfaces the day one appears.
  const [{ m }] = await sql`
    SELECT count(*)::int AS m FROM pg_matviews WHERE schemaname = 'guesthub'`;
  assert.equal(m, 0, "materialized views appeared in guesthub — extend scanTables AND independentCount to cover them before trusting this guard");

  // ---- 1. the real state passes -------------------------------------------
  const rows = await scanTables(sql);
  const cross = await independentCount(sql);
  const errs = validate(rows, cross);
  assert.equal(errs.length, 0, `grants are broken:\n  - ${errs.join("\n  - ")}`);
  ok(`all ${rows.length} relations in guesthub carry SELECT for ${APP_ROLE} (cross-checked against an independent catalog count of ${cross})`);

  // ---- 2. schema USAGE — the door in front of every table ACL -------------
  const [{ usage }] = await sql`
    SELECT has_schema_privilege(${APP_ROLE}, 'guesthub', 'USAGE') AS usage`;
  assert.equal(usage, true, `${APP_ROLE} lacks USAGE on schema guesthub — every table SELECT above is unreachable (080 grants it; production has carried it since before the migrations)`);
  ok(`${APP_ROLE} holds USAGE on schema guesthub — the table grants are actually reachable`);

  // ---- 3. the ledger stays read-only --------------------------------------
  // Decided 2026-08-08: SELECT only, never INSERT/UPDATE/DELETE — the ledger
  // is written by the migration runner alone; app-side write access would
  // open a path to corrupting the record of what ran.
  const [led] = await sql`
    SELECT has_table_privilege(${APP_ROLE}, 'guesthub.schema_migrations', 'INSERT') AS ins,
           has_table_privilege(${APP_ROLE}, 'guesthub.schema_migrations', 'UPDATE') AS upd,
           has_table_privilege(${APP_ROLE}, 'guesthub.schema_migrations', 'DELETE') AS del`;
  assert.equal(led.ins || led.upd || led.del, false,
    `${APP_ROLE} holds WRITE on guesthub.schema_migrations (insert=${led.ins} update=${led.upd} delete=${led.del}) — the ledger must be SELECT-only for the app role`);
  ok("guesthub.schema_migrations is SELECT-only for the app role — the ledger cannot be rewritten from the app");

  // ---- 4. B2 — the guard proves itself against the live catalog -----------
  // (a) REVOKE mutant, inside a transaction that always rolls back: a real
  //     missing grant MUST surface. Requires an owner/admin connection — the
  //     suite's clone DSN is one; anything less fails loudly here, which is
  //     correct (an unprovable guard must not report proof).
  const victim = rows[0].name;
  await sql.begin(async (tx) => {
    await tx.unsafe(`REVOKE SELECT ON guesthub."${victim}" FROM ${APP_ROLE}`);
    const mutantRows = await scanTables(tx);
    const mutantErrs = validate(mutantRows, await independentCount(tx));
    assert.ok(mutantErrs.some((e) => e.includes(victim)),
      `B2: REVOKE mutant PASSED — SELECT was revoked from guesthub.${victim} and the scan did not report it; the guard is not a guard`);
    console.log(`  ✓ B2 mutant rejected: SELECT revoked from guesthub.${victim} (in-txn) → scan reports it → rolled back`);
    throw Object.assign(new Error("b2-rollback"), { b2: true }); // roll the REVOKE back, always
  }).catch((e) => { if (!e.b2) throw e; });
  const [{ back }] = await sql`
    SELECT has_table_privilege(${APP_ROLE}, ${"guesthub." + victim}, 'SELECT') AS back`;
  assert.equal(back, true, `B2 rollback failed — guesthub.${victim} lost its real SELECT; restore it before trusting anything`);

  // (b) coverage-removal mutant: one table filtered out of the enumeration —
  //     the independent cross-count must split from it.
  const narrowed = await scanTables(sql, { exclude: victim });
  const narrowedErrs = validate(narrowed, await independentCount(sql));
  assert.ok(narrowedErrs.some((e) => e.includes("independent catalog count")),
    `B2: coverage-removal mutant PASSED — guesthub.${victim} was dropped from the enumeration and the cross-count did not flag it`);
  console.log(`  ✓ B2 mutant rejected: guesthub.${victim} filtered out of the enumeration → cross-count mismatch flagged`);
  ok("B2: both mutants rejected — a real missing grant surfaces, and a narrowed scan cannot read as full coverage");

  console.log(`\nall ${n} grants checks passed — a rebuilt guesthub schema is fully readable by ${APP_ROLE}, and the ledger stays read-only`);
} finally {
  await sql.end({ timeout: 5 });
}
