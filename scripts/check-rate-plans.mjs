// DB-integration check for the Rate Plans data model (migration 016) against the
// ISOLATED disposable test DB (guesthub-testdb, :5433) — NEVER production. It
//   1. applies the full migration chain 000..016 to the test DB, then re-applies
//      016 a SECOND time, so this doubles as blank-schema + idempotency
//      validation, then
//   2. runs 15 scenarios — each inside its own transaction that ROLLS BACK —
//      asserting the dual-scope pricing_plans model: plan kinds + derivation
//      consistency, tenant-level live-code uniqueness, the parent-guard trigger
//      (self/indirect cycles, cross-tenant, SU-scoped parents, chain depth),
//      scope/validity/advance/DOW CHECKs, pricing_plan_units +
//      pricing_plan_unit_rates constraints, seeded permissions, and the
//      untouched Phase-4A SU-scoped base-plan contract.
// Usage: node scripts/check-rate-plans.mjs
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import assert from "node:assert/strict";

// Disposable local test DB only. Refuse anything that smells of production.
const URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (URL.includes(marker)) { console.error(`✗ refusing: production marker "${marker}" in TEST_DATABASE_URL`); process.exit(1); }
}

// 1. apply the chain to the test DB — proves the migration is self-contained on
//    a blank schema — then re-apply 016 alone to prove idempotency.
console.log("→ applying migration chain 000..016 to guesthub-testdb…");
execSync(
  'for f in $(ls db/migrations/*.sql | sort); do docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null; done',
  { stdio: "inherit", shell: "/bin/bash" },
);
console.log("→ re-applying 016_rate_plans.sql a second time (idempotency)…");
execSync(
  'docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < db/migrations/016_rate_plans.sql >/dev/null',
  { stdio: "inherit", shell: "/bin/bash" },
);

const sql = postgres(URL, { prepare: false, max: 1, onnotice: () => {} });
let n = 0;
const ok = (name) => { n++; console.log(`  ✓ ${n}. ${name}`); };
const note = (msg) => console.log(`    · note: ${msg}`);
class Rollback extends Error {}

// each scenario runs in its own transaction that always rolls back
async function scenario(fn) {
  try {
    await sql.begin(async (tx) => { await fn(tx); throw new Rollback(); });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

// porsager savepoint helper: run a statement expected to fail, without
// poisoning the surrounding transaction. Asserts SQLSTATE / message / constraint.
async function expectError(tx, { code, contains, constraint }, label, fn) {
  let threw = null;
  try { await tx.savepoint(fn); } catch (e) { threw = e; }
  assert.ok(threw, `${label}: expected a DB error`);
  if (code) assert.equal(threw.code, code, `${label}: expected SQLSTATE ${code}, got ${threw.code} (${threw.message})`);
  if (contains) assert.ok(String(threw.message).includes(contains),
    `${label}: expected message containing "${contains}", got "${threw.message}"`);
  if (constraint) assert.equal(threw.constraint_name, constraint,
    `${label}: expected constraint ${constraint}, got ${threw.constraint_name}`);
  return threw;
}
const expectViolation = (tx, code, label, fn) => expectError(tx, { code }, label, fn);

const uniq = (p) => `${p}-${randomUUID().slice(0, 8)}`;
const mkTenant = async (tx, tag) =>
  (await tx`INSERT INTO guesthub.tenants (name, slug) VALUES (${`RP ${tag}`}, ${uniq(`rate-plans-${tag}`)}) RETURNING id`)[0].id;
const mkSU = async (tx, tenantId, tag) =>
  (await tx`INSERT INTO guesthub.sellable_units (tenant_id, code, name) VALUES (${tenantId}, ${uniq(tag)}, ${`SU ${tag}`}) RETURNING id`)[0].id;
// tenant-level unless su is given; RETURNING casts numeric for exact JS compare
const insPlan = async (tx, t) =>
  (await tx`INSERT INTO guesthub.pricing_plans
      (tenant_id, sellable_unit_id, code, name, plan_kind, parent_plan_id, adjustment_value, is_base)
    VALUES (${t.tenant}, ${t.su ?? null}, ${t.code}, ${t.name ?? t.code}, ${t.kind ?? 'base'},
            ${t.parent ?? null}, ${t.adj ?? null}, ${t.isBase ?? false})
    RETURNING id, plan_kind, parent_plan_id, sellable_unit_id, adjustment_value::float8 AS adjustment_value, is_archived`)[0];

let exitCode = 0;
try {
  ok("migration chain 000..016 applies on a blank schema; 016 re-applies cleanly (idempotent)");

  // ---- 1. tenant-level plan CRUD: all four kinds round-trip ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "crud");
    const base = await insPlan(tx, { tenant: t, code: "std", kind: "base" });
    const dpc = await insPlan(tx, { tenant: t, code: "nref", kind: "derived_percentage", parent: base.id, adj: -10 });
    const dfx = await insPlan(tx, { tenant: t, code: "bb", kind: "derived_fixed", parent: base.id, adj: 50 });
    const ind = await insPlan(tx, { tenant: t, code: "corp", kind: "independent" });
    assert.equal(base.plan_kind, "base");
    assert.equal(base.parent_plan_id, null);
    assert.equal(base.adjustment_value, null);
    assert.equal(dpc.plan_kind, "derived_percentage");
    assert.equal(dpc.parent_plan_id, base.id);
    assert.equal(dpc.adjustment_value, -10, "derived_percentage adjustment round-trips as numeric");
    assert.equal(dfx.plan_kind, "derived_fixed");
    assert.equal(dfx.parent_plan_id, base.id);
    assert.equal(dfx.adjustment_value, 50, "derived_fixed adjustment round-trips as numeric");
    assert.equal(ind.plan_kind, "independent");
    assert.equal(ind.parent_plan_id, null);
    assert.equal(ind.adjustment_value, null);
    for (const p of [base, dpc, dfx, ind]) assert.equal(p.sellable_unit_id, null, "tenant-level plans have no SU scope");
    ok("tenant-level plan CRUD: base / derived_percentage / derived_fixed / independent round-trip exactly");
  });

  // ---- 2. live code unique per tenant (case-insensitive); tenant-scoped; archiving frees it ----
  await scenario(async (tx) => {
    const tA = await mkTenant(tx, "code-a");
    const tB = await mkTenant(tx, "code-b");
    await insPlan(tx, { tenant: tA, code: "flex", kind: "independent" });
    await expectViolation(tx, "23505", "duplicate live code (case-insensitive)", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind)
      VALUES (${tA}, 'FLEX', 'Flex upper', 'independent')`);
    ok("duplicate live code within tenant rejected (23505, 'FLEX' vs 'flex' — case-insensitive)");
    await insPlan(tx, { tenant: tB, code: "flex", kind: "independent" });
    ok("same code allowed on a second tenant (uniqueness is tenant-scoped)");
    await tx`UPDATE guesthub.pricing_plans SET is_archived = true WHERE tenant_id = ${tA} AND code = 'flex'`;
    const reused = await insPlan(tx, { tenant: tA, code: "flex", kind: "independent" });
    assert.ok(reused.id, "archiving frees the code for reuse");
    ok("archiving a plan frees its code (partial unique index covers live rows only)");
  });

  // ---- 3. self-parent rejected ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "selfp");
    const base = await insPlan(tx, { tenant: t, code: "std", kind: "base" });
    const d = await insPlan(tx, { tenant: t, code: "d1", kind: "derived_percentage", parent: base.id, adj: -5 });
    let threw = null;
    try { await tx.savepoint((sp) => sp`UPDATE guesthub.pricing_plans SET parent_plan_id = ${d.id} WHERE id = ${d.id}`); }
    catch (e) { threw = e; }
    assert.ok(threw, "self-parent: expected a DB error");
    assert.ok(threw.code === "23514" || String(threw.message).includes("RATE_PLAN_CYCLE"),
      `self-parent: expected 23514 or RATE_PLAN_CYCLE, got ${threw.code} (${threw.message})`);
    ok(`self-parent rejected (${String(threw.message).includes("RATE_PLAN_CYCLE") ? "trigger RATE_PLAN_CYCLE" : "check constraint 23514"})`);
  });

  // ---- 4. indirect cycle rejected ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "cycle");
    const a = await insPlan(tx, { tenant: t, code: "a", kind: "base" });
    const b = await insPlan(tx, { tenant: t, code: "b", kind: "derived_percentage", parent: a.id, adj: -5 });
    await expectError(tx, { contains: "RATE_PLAN_CYCLE" }, "indirect cycle A→B→A", (sp) => sp`
      UPDATE guesthub.pricing_plans
      SET plan_kind = 'derived_percentage', parent_plan_id = ${b.id}, adjustment_value = -20
      WHERE id = ${a.id}`);
    ok("indirect cycle rejected: A→B then B as A's parent raises RATE_PLAN_CYCLE");
  });

  // ---- 5. cross-tenant parent rejected ----
  await scenario(async (tx) => {
    const tA = await mkTenant(tx, "xten-a");
    const tB = await mkTenant(tx, "xten-b");
    const baseA = await insPlan(tx, { tenant: tA, code: "std", kind: "base" });
    await expectError(tx, { contains: "MIXED_TENANT_DATA" }, "cross-tenant parent", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, parent_plan_id, adjustment_value)
      VALUES (${tB}, 'leech', 'Leech', 'derived_percentage', ${baseA.id}, -10)`);
    ok("cross-tenant parent rejected: trigger raises MIXED_TENANT_DATA");
  });

  // ---- 6. parent must be tenant-level (SU-scoped parent refused) ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "suparent");
    const su = await mkSU(tx, t, "su");
    const suPlan = await insPlan(tx, { tenant: t, su, code: "base", kind: "base", isBase: true });
    await expectError(tx, { contains: "RATE_PLAN_PARENT_NOT_TENANT_LEVEL" }, "SU-scoped parent", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, parent_plan_id, adjustment_value)
      VALUES (${t}, 'derived-of-su', 'Derived of SU', 'derived_percentage', ${suPlan.id}, -10)`);
    ok("SU-scoped plan refused as parent: trigger raises RATE_PLAN_PARENT_NOT_TENANT_LEVEL");
  });

  // ---- 7. derivation consistency (pricing_plans_derivation_chk) ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "deriv");
    const base = await insPlan(tx, { tenant: t, code: "std", kind: "base" });
    await expectError(tx, { code: "23514", constraint: "pricing_plans_derivation_chk" },
      "derived_fixed without adjustment", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, parent_plan_id)
      VALUES (${t}, 'dfna', 'x', 'derived_fixed', ${base.id})`);
    await expectError(tx, { code: "23514", constraint: "pricing_plans_derivation_chk" },
      "derived_percentage at -100", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, parent_plan_id, adjustment_value)
      VALUES (${t}, 'dpm100', 'x', 'derived_percentage', ${base.id}, -100)`);
    await expectError(tx, { code: "23514", constraint: "pricing_plans_derivation_chk" },
      "base with parent", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, parent_plan_id)
      VALUES (${t}, 'bwp', 'x', 'base', ${base.id})`);
    await expectError(tx, { code: "23514", constraint: "pricing_plans_derivation_chk" },
      "independent with adjustment", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, adjustment_value)
      VALUES (${t}, 'iwa', 'x', 'independent', 10)`);
    ok("derivation consistency: no-adjustment derived_fixed, -100 percentage, base-with-parent, independent-with-adjustment all rejected (23514 pricing_plans_derivation_chk)");
  });

  // ---- 8. scope check: SU-scoped rows must stay plan_kind='base' ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "scope");
    const su = await mkSU(tx, t, "su");
    await expectError(tx, { code: "23514", constraint: "pricing_plans_scope_chk" },
      "SU-scoped independent", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, plan_kind)
      VALUES (${t}, ${su}, 'su-ind', 'x', 'independent')`);
    ok("SU-scoped row with plan_kind='independent' rejected (23514 pricing_plans_scope_chk)");
  });

  // ---- 9. chain depth boundary (empirical: trigger raises when depth > 5) ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "depth");
    const base = await insPlan(tx, { tenant: t, code: "d0", kind: "base" });
    let parent = base.id;
    const passed = [];
    let failure = null;
    for (let lvl = 1; lvl <= 6; lvl++) {
      const p = parent;
      try {
        await tx.savepoint(async (sp) => {
          const [row] = await sp`
            INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, parent_plan_id, adjustment_value)
            VALUES (${t}, ${`d${lvl}`}, ${`Level ${lvl}`}, 'derived_percentage', ${p}, -5)
            RETURNING id`;
          parent = row.id;
        });
        passed.push(lvl);
      } catch (e) { failure = { lvl, e }; break; }
    }
    assert.deepEqual(passed, [1, 2, 3, 4, 5], `derived levels 1..5 must all insert, got [${passed}]`);
    assert.ok(failure && failure.lvl === 6, "the 6th derived level must be the one that fails");
    assert.ok(String(failure.e.message).includes("RATE_PLAN_CHAIN_TOO_DEEP"),
      `expected RATE_PLAN_CHAIN_TOO_DEEP, got ${failure.e.code} (${failure.e.message})`);
    ok("chain depth: base + 5 derived levels succeed; the 6th derived level raises RATE_PLAN_CHAIN_TOO_DEEP (trigger raises at ancestor-depth > 5)");
    note("boundary is base+5 derived OK / 6th fails — not '5th derived fails' as the spec sketch said; the trigger counts ancestors from the new plan's parent");
  });

  // ---- 10. pricing_plan_units: assignment, uniqueness, validity ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "ppu");
    const su1 = await mkSU(tx, t, "ppu1");
    const su2 = await mkSU(tx, t, "ppu2");
    const plan = await insPlan(tx, { tenant: t, code: "corp", kind: "independent" });
    const [asg] = await tx`
      INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id)
      VALUES (${t}, ${plan.id}, ${su1}) RETURNING id, is_active`;
    assert.ok(asg.id && asg.is_active === true, "assignment inserts, active by default");
    await expectViolation(tx, "23505", "duplicate (plan, unit) assignment", (sp) => sp`
      INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id)
      VALUES (${t}, ${plan.id}, ${su1})`);
    await expectViolation(tx, "23514", "assignment valid_until < valid_from", (sp) => sp`
      INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, valid_from, valid_until)
      VALUES (${t}, ${plan.id}, ${su2}, '2026-08-10', '2026-08-01')`);
    ok("pricing_plan_units: assignment inserts; duplicate (plan, unit) → 23505; valid_until < valid_from → 23514");
  });

  // ---- 11. pricing_plan_unit_rates: overlay row, uniqueness, price/stay checks ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "ppur");
    const su = await mkSU(tx, t, "ppur");
    const plan = await insPlan(tx, { tenant: t, code: "ind", kind: "independent" });
    const [row] = await tx`
      INSERT INTO guesthub.pricing_plan_unit_rates
        (tenant_id, pricing_plan_id, sellable_unit_id, date, price, min_stay_arrival, closed_to_arrival, note)
      VALUES (${t}, ${plan.id}, ${su}, '2026-08-01', 123.45, 2, true, 'holiday override')
      RETURNING price::float8 AS price, min_stay_arrival, closed_to_arrival, note`;
    assert.equal(row.price, 123.45, "numeric(12,2) price round-trips exactly");
    assert.equal(row.min_stay_arrival, 2);
    assert.equal(row.closed_to_arrival, true);
    assert.equal(row.note, "holiday override");
    await expectViolation(tx, "23505", "duplicate (plan, unit, date) overlay", (sp) => sp`
      INSERT INTO guesthub.pricing_plan_unit_rates (tenant_id, pricing_plan_id, sellable_unit_id, date, price)
      VALUES (${t}, ${plan.id}, ${su}, '2026-08-01', 200)`);
    await expectViolation(tx, "23514", "negative price", (sp) => sp`
      INSERT INTO guesthub.pricing_plan_unit_rates (tenant_id, pricing_plan_id, sellable_unit_id, date, price)
      VALUES (${t}, ${plan.id}, ${su}, '2026-08-02', -1)`);
    await expectViolation(tx, "23514", "min_stay_through = 0", (sp) => sp`
      INSERT INTO guesthub.pricing_plan_unit_rates (tenant_id, pricing_plan_id, sellable_unit_id, date, min_stay_through)
      VALUES (${t}, ${plan.id}, ${su}, '2026-08-03', 0)`);
    ok("pricing_plan_unit_rates: overlay (price+restrictions+note) round-trips; duplicate (plan, unit, date) → 23505; price < 0 and min_stay_through = 0 → 23514");
  });

  // ---- 12. DOW constraint (pricing_plans_dow_chk) ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "dow");
    const [wknd] = await tx`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, allowed_checkin_days)
      VALUES (${t}, 'wknd', 'Weekend', 'independent', ${'{0,6}'}::smallint[])
      RETURNING allowed_checkin_days`;
    assert.deepEqual(wknd.allowed_checkin_days, [0, 6], "'{0,6}' round-trips");
    await expectError(tx, { code: "23514", constraint: "pricing_plans_dow_chk" }, "DOW value 7", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, allowed_checkin_days)
      VALUES (${t}, 'dow7', 'x', 'independent', ${'{7}'}::smallint[])`);
    ok("DOW constraint: '{0,6}' accepted, '{7}' rejected (23514 pricing_plans_dow_chk)");
    // Empty array: the constraint uses cardinality(), so '{}' (which would mean
    // "no arrival day is ever allowed") is rejected — NULL means "all days".
    await expectError(tx, { code: "23514", constraint: "pricing_plans_dow_chk" }, "empty DOW array", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, allowed_checkin_days)
      VALUES (${t}, 'dow-empty', 'x', 'independent', ${'{}'}::smallint[])`);
    ok("DOW constraint: empty array rejected (cardinality >= 1); NULL remains 'all days'");
  });

  // ---- 13. validity / advance-window checks ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "windows");
    await expectError(tx, { code: "23514", constraint: "pricing_plans_validity_chk" },
      "valid_until < valid_from", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, valid_from, valid_until)
      VALUES (${t}, 'vinv', 'x', 'independent', '2026-02-10', '2026-02-01')`);
    await expectError(tx, { code: "23514", constraint: "pricing_plans_advance_chk" },
      "max_advance_days < min_advance_days", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, min_advance_days, max_advance_days)
      VALUES (${t}, 'ainv', 'x', 'independent', 10, 5)`);
    await expectError(tx, { code: "23514", constraint: "pricing_plans_advance_chk" },
      "negative min_advance_days", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, min_advance_days)
      VALUES (${t}, 'aneg', 'x', 'independent', -1)`);
    ok("validity/advance: valid_until < valid_from, max_advance < min_advance, negative min_advance all rejected (23514)");
  });

  // ---- 14. permissions seeded by the migration ----
  await scenario(async (tx) => {
    const KEYS = ["rate_plans.view", "rate_plans.create", "rate_plans.edit", "rate_plans.delete", "pricing.simulate"];
    const perms = await tx`SELECT key, category FROM guesthub.permissions WHERE key = ANY(${KEYS}) ORDER BY key`;
    assert.deepEqual(perms.map((p) => p.key).sort(), [...KEYS].sort(), "all 5 permission keys seeded");
    assert.ok(perms.every((p) => p.category === "rates"), "all 5 keys in category 'rates'");
    ok("permissions: rate_plans.view/create/edit/delete + pricing.simulate seeded globally (category 'rates')");

    // roles are PER-TENANT rows; the blank test DB has none at migration time,
    // so 016's role-grant INSERT..SELECTs matched zero roles. Assert honestly:
    // if manager/receptionist roles exist (they were present when 016 ran just
    // now), they must carry the grants; otherwise re-run the migration's exact
    // grant semantics against fixture roles inside this rolled-back tx.
    const preexisting = await tx`
      SELECT r.id, r.key, count(rp.id) FILTER (WHERE p.key = ANY(${KEYS}))::int AS granted
      FROM guesthub.roles r
      LEFT JOIN guesthub.role_permissions rp ON rp.role_id = r.id
      LEFT JOIN guesthub.permissions p ON p.id = rp.permission_id
      WHERE r.key IN ('manager', 'receptionist')
      GROUP BY r.id, r.key`;
    if (preexisting.length === 0) {
      note("test DB has no tenants/roles at migration time → 016's role-grant INSERTs matched zero rows (by design); re-running the grant semantics on fixture roles");
      const t = await mkTenant(tx, "perm");
      const [mgr] = await tx`INSERT INTO guesthub.roles (tenant_id, name, key) VALUES (${t}, 'מנהל', 'manager') RETURNING id`;
      const [rcp] = await tx`INSERT INTO guesthub.roles (tenant_id, name, key) VALUES (${t}, 'פקיד קבלה', 'receptionist') RETURNING id`;
      // the migration's role-grant INSERTs, verbatim semantics
      await tx`INSERT INTO guesthub.role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM guesthub.roles r
        JOIN guesthub.permissions p ON p.key = ANY(${KEYS})
        WHERE r.key = 'manager'
        ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO guesthub.role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM guesthub.roles r
        JOIN guesthub.permissions p ON p.key = 'rate_plans.view'
        WHERE r.key = 'receptionist'
        ON CONFLICT DO NOTHING`;
      const grants = async (roleId) => (await tx`
        SELECT p.key FROM guesthub.role_permissions rp
        JOIN guesthub.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ${roleId} AND p.key = ANY(${KEYS}) ORDER BY p.key`).map((r) => r.key);
      assert.deepEqual(await grants(mgr.id), [...KEYS].sort(), "manager gets all 5 keys");
      assert.deepEqual(await grants(rcp.id), ["rate_plans.view"], "receptionist gets rate_plans.view only");
      ok("role grants: migration's INSERT semantics give manager all 5 keys, receptionist rate_plans.view only (fixture roles, rolled back)");
    } else {
      for (const r of preexisting) {
        if (r.key === "manager") assert.equal(r.granted, 5, `manager role ${r.id} must hold all 5 rate-plan keys`);
        if (r.key === "receptionist") assert.ok(r.granted >= 1, `receptionist role ${r.id} must hold rate_plans.view`);
      }
      ok(`role grants: ${preexisting.length} pre-existing manager/receptionist role(s) carry the migration's grants`);
    }
  });

  // ---- 15. legacy protection: Phase-4A SU-scoped base-plan contract unchanged ----
  await scenario(async (tx) => {
    const t = await mkTenant(tx, "legacy");
    const su = await mkSU(tx, t, "legacy");
    await insPlan(tx, { tenant: t, su, code: "base", kind: "base", isBase: true });
    await expectViolation(tx, "23505", "duplicate code on same SU", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, plan_kind, is_base)
      VALUES (${t}, ${su}, 'base', 'dup code', 'base', false)`);
    await expectError(tx, { code: "23505", constraint: "uq_pricing_plans_base" }, "second is_base per SU", (sp) => sp`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, plan_kind, is_base)
      VALUES (${t}, ${su}, 'base2', 'second base', 'base', true)`);
    ok("legacy protection: UNIQUE(sellable_unit_id, code) and uq_pricing_plans_base still enforced on SU-scoped rows (23505)");
  });

  console.log(`\nALL ${n} RATE-PLAN MODEL CHECKS PASSED — all writes rolled back, test DB untouched`);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await sql.end();
}
process.exit(exitCode);
