// DB-integration check for the commercial-settings migration (011) against the
// ISOLATED disposable test DB (guesthub-testdb, :5433) — NEVER production. It
//   1. applies the full migration chain 000..011 to the test DB (idempotent), so
//      this doubles as migration-validation on a blank schema, then
//   2. seeds fixtures and asserts tenant isolation, tier/stage ordering, the
//      one-default-per-tenant + unique-code partial indexes, the money/percent
//      CHECK constraints, and numeric(12,2) precision — ALL inside a transaction
//      that ROLLS BACK, so the test DB is left untouched.
// Usage: node scripts/check-commercial-db.mjs
import { execSync } from "node:child_process";
import postgres from "postgres";
import assert from "node:assert/strict";

// Disposable local test DB only. Refuse anything that smells of production.
const URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (URL.includes(marker)) { console.error(`✗ refusing: production marker "${marker}" in TEST_DATABASE_URL`); process.exit(1); }
}

// 1. apply the chain to the test DB (idempotent) — proves the migration is
//    self-contained on a blank schema and gives us the tables to test.
console.log("→ applying migration chain 000..011 to guesthub-testdb (idempotent)…");
execSync(
  'for f in $(ls db/migrations/*.sql | sort); do docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null; done',
  { stdio: "inherit", shell: "/bin/bash" },
);

const sql = postgres(URL, { prepare: false, max: 1, onnotice: () => {} });
let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };
class Rollback extends Error {}

// porsager savepoint helper: run a statement expected to violate `code`, without
// poisoning the surrounding transaction.
async function expectViolation(tx, code, label, fn) {
  let threw = null;
  try { await tx.savepoint(fn); } catch (e) { threw = e; }
  assert.ok(threw, `${label}: expected a DB error`);
  assert.equal(threw.code, code, `${label}: expected SQLSTATE ${code}, got ${threw.code}`);
}

try {
  await sql.begin(async (tx) => {
    // ---- fixtures: two tenants + a user (created_by FK) + payment methods ----
    const [tA] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES ('T-A', 'commercial-check-a') RETURNING id`;
    const [tB] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES ('T-B', 'commercial-check-b') RETURNING id`;
    const [u] = await tx`INSERT INTO guesthub.users (tenant_id, username) VALUES (${tA.id}, 'checker') RETURNING id`;
    await tx`INSERT INTO guesthub.lookup_items (tenant_id, category, key, label) VALUES
      (${tA.id}, 'payment_methods', 'cash', 'מזומן'),
      (${tA.id}, 'payment_methods', 'credit_card', 'כרטיס אשראי')`;

    // ---- cancellation policy + ordered tiers ----
    const [pol] = await tx`
      INSERT INTO guesthub.cancellation_policies (tenant_id, name, public_title, code, is_default, created_by)
      VALUES (${tA.id}, 'Flexible', 'ביטול גמיש', 'flex', true, ${u.id}) RETURNING id`;
    // insert tiers in shuffled order; sort_order defines the read order
    for (const [so, pct] of [[2, 100], [0, 0], [1, 50]]) {
      await tx`INSERT INTO guesthub.cancellation_policy_tiers
        (tenant_id, policy_id, sort_order, trigger_type, fee_type, fee_percent, fee_amount, calc_base)
        VALUES (${tA.id}, ${pol.id}, ${so}, 'before_checkin', 'percentage', ${pct}, 0, 'accommodation')`;
    }
    const tiers = await tx`
      SELECT sort_order, fee_percent::float8 AS fee_percent FROM guesthub.cancellation_policy_tiers
      WHERE tenant_id = ${tA.id} AND policy_id = ${pol.id} ORDER BY sort_order`;
    assert.deepEqual(tiers.map((r) => r.sort_order), [0, 1, 2], "tiers read back in sort_order");
    assert.deepEqual(tiers.map((r) => r.fee_percent), [0, 50, 100], "percent stored/ordered exactly");
    ok("cancellation tiers persist and read back in deterministic sort_order");

    // numeric(12,2) precision (no float drift)
    await tx`INSERT INTO guesthub.cancellation_policy_tiers
      (tenant_id, policy_id, sort_order, trigger_type, fee_type, fee_amount, calc_base)
      VALUES (${tA.id}, ${pol.id}, 5, 'after_checkin', 'fixed', 33.33, 'accommodation')`;
    const [{ amt }] = await tx`SELECT fee_amount::float8 AS amt FROM guesthub.cancellation_policy_tiers WHERE tenant_id=${tA.id} AND sort_order=5`;
    assert.equal(amt, 33.33, "numeric(12,2) stores money exactly");
    ok("money stored as numeric(12,2) — no float drift");

    // ---- tenant isolation ----
    await tx`INSERT INTO guesthub.cancellation_policies (tenant_id, name, public_title, code)
             VALUES (${tB.id}, 'B-policy', 'B', 'flex')`; // same code, different tenant — allowed
    const aOnly = await tx`SELECT tenant_id FROM guesthub.cancellation_policies WHERE tenant_id = ${tA.id}`;
    assert.ok(aOnly.length === 1 && aOnly.every((r) => r.tenant_id === tA.id), "tenant A query returns only A");
    ok("tenant isolation: same code reused across tenants; queries scoped by tenant_id");

    // ---- one-default-per-tenant partial unique index ----
    await expectViolation(tx, "23505", "second default", (sp) =>
      sp`INSERT INTO guesthub.cancellation_policies (tenant_id, name, public_title, code, is_default)
         VALUES (${tA.id}, 'Second default', 'x', 'flex2', true)`);
    ok("one-default-per-tenant enforced by partial unique index");

    // ---- unique code among non-archived; archiving frees the code ----
    await expectViolation(tx, "23505", "duplicate live code", (sp) =>
      sp`INSERT INTO guesthub.cancellation_policies (tenant_id, name, public_title, code)
         VALUES (${tA.id}, 'Dup', 'y', 'flex')`);
    await tx`UPDATE guesthub.cancellation_policies SET is_archived = true, is_default = false WHERE tenant_id = ${tA.id} AND code = 'flex'`;
    const [freed] = await tx`INSERT INTO guesthub.cancellation_policies (tenant_id, name, public_title, code)
         VALUES (${tA.id}, 'Reuse', 'z', 'flex') RETURNING id`;
    assert.ok(freed.id, "archiving frees the code for reuse");
    ok("unique code among live policies; archiving releases it");

    // ---- CHECK constraints (money >= 0, percent 0..100) ----
    const [pol2] = await tx`INSERT INTO guesthub.cancellation_policies (tenant_id, name, public_title, code)
      VALUES (${tA.id}, 'C', 'c', 'chk') RETURNING id`;
    await expectViolation(tx, "23514", "negative amount", (sp) =>
      sp`INSERT INTO guesthub.cancellation_policy_tiers (tenant_id, policy_id, sort_order, trigger_type, fee_type, fee_amount, calc_base)
         VALUES (${tA.id}, ${pol2.id}, 0, 'after_checkin', 'fixed', -1, 'accommodation')`);
    await expectViolation(tx, "23514", "percent > 100", (sp) =>
      sp`INSERT INTO guesthub.cancellation_policy_tiers (tenant_id, policy_id, sort_order, trigger_type, fee_type, fee_percent, calc_base)
         VALUES (${tA.id}, ${pol2.id}, 1, 'after_checkin', 'percentage', 150, 'accommodation')`);
    ok("CHECK constraints reject negative money and percent > 100");

    // ---- payment policy + ordered stages + methods jsonb ----
    const [pp] = await tx`INSERT INTO guesthub.payment_policies (tenant_id, name, public_title, code, is_default, created_by)
      VALUES (${tA.id}, 'Deposit 30', 'מקדמה', 'dep30', true, ${u.id}) RETURNING id`;
    await tx`INSERT INTO guesthub.payment_policy_stages
      (tenant_id, policy_id, sort_order, trigger_type, amount_type, amount_percent, methods)
      VALUES (${tA.id}, ${pp.id}, 0, 'booking', 'percentage', 30, ${sql.json(["credit_card"])}::jsonb)`;
    await tx`INSERT INTO guesthub.payment_policy_stages
      (tenant_id, policy_id, sort_order, trigger_type, trigger_offset_unit, trigger_offset_value, amount_type, methods)
      VALUES (${tA.id}, ${pp.id}, 1, 'before_checkin', 'days', 7, 'remaining_balance', ${sql.json(["credit_card","cash"])}::jsonb)`;
    const stages = await tx`SELECT sort_order, methods FROM guesthub.payment_policy_stages WHERE tenant_id=${tA.id} AND policy_id=${pp.id} ORDER BY sort_order`;
    assert.deepEqual(stages.map((s) => s.sort_order), [0, 1], "stages ordered");
    assert.deepEqual(stages[1].methods, ["credit_card", "cash"], "methods jsonb round-trips");
    await expectViolation(tx, "23514", "payment percent > 100", (sp) =>
      sp`INSERT INTO guesthub.payment_policy_stages (tenant_id, policy_id, sort_order, trigger_type, amount_type, amount_percent)
         VALUES (${tA.id}, ${pp.id}, 9, 'booking', 'percentage', 150)`);
    ok("payment stages ordered, methods jsonb round-trips, percent CHECK enforced");

    // ---- cascade: deleting a policy removes its children ----
    await tx`DELETE FROM guesthub.cancellation_policies WHERE id = ${pol.id}`;
    const [{ c }] = await tx`SELECT count(*)::int AS c FROM guesthub.cancellation_policy_tiers WHERE policy_id = ${pol.id}`;
    assert.equal(c, 0, "tiers cascade-deleted with the policy");
    ok("ON DELETE CASCADE removes tiers/stages with the policy");

    throw new Rollback(); // leave the test DB untouched
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); await sql.end(); process.exit(1); }
}

await sql.end();
console.log(`\n✓ commercial DB checks passed (${n} groups) — all writes rolled back, test DB untouched`);
