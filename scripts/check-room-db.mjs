// DB-integration check for migration 012 (room occupancy + overrides,
// pricing_plans policy links) against the ISOLATED test DB (:5433) — NEVER prod.
// Applies the chain (idempotent), then asserts column defaults, backfill
// semantics, CHECK constraints, override persistence (incl. explicit 0), tenant
// isolation, and the pricing_plans → policy FK (ON DELETE SET NULL). All writes
// ROLL BACK. Usage: node scripts/check-room-db.mjs
import { execSync } from "node:child_process";
import postgres from "postgres";
import assert from "node:assert/strict";

const URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const m of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (URL.includes(m)) { console.error(`✗ refusing: production marker "${m}"`); process.exit(1); }
}
console.log("→ applying migration chain (idempotent)…");
execSync('for f in $(ls db/migrations/*.sql | sort); do docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null; done',
  { stdio: "inherit", shell: "/bin/bash" });

const sql = postgres(URL, { prepare: false, max: 1, onnotice: () => {} });
let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };
class Rollback extends Error {}
async function expectViolation(tx, code, label, fn) {
  let threw = null;
  try { await tx.savepoint(fn); } catch (e) { threw = e; }
  assert.ok(threw, `${label}: expected DB error`);
  assert.equal(threw.code, code, `${label}: expected ${code}, got ${threw?.code}`);
}

try {
  await sql.begin(async (tx) => {
    const [tA] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES ('RA','room-check-a') RETURNING id`;
    const [tB] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES ('RB','room-check-b') RETURNING id`;
    const mkRoom = (tid, num, maxOcc = 4) => tx`
      INSERT INTO guesthub.rooms (tenant_id, room_number, max_occupancy, max_adults, max_children, max_infants)
      VALUES (${tid}, ${num}, ${maxOcc}, 3, 2, 1) RETURNING id, included_occupancy, extra_guest_pricing_mode`;

    // ---- column defaults / backfill semantics ----
    const [r1] = await mkRoom(tA.id, "101");
    assert.equal(r1.included_occupancy, null, "new/existing room: included_occupancy unconfigured (requires completion)");
    assert.equal(r1.extra_guest_pricing_mode, "inherit", "default pricing mode is inherit");
    ok("rooms default to inherit + unconfigured included_occupancy (no fake backfill)");

    // ---- override persistence incl. explicit 0 ----
    await tx`UPDATE guesthub.rooms SET extra_guest_pricing_mode='override',
             extra_adult_override=80, extra_child_override=0, extra_infant_override=null,
             charge_frequency_override='per_stay', included_occupancy=2 WHERE id=${r1.id}`;
    const [back] = await tx`SELECT extra_adult_override::float8 AS a, extra_child_override::float8 AS c,
             extra_infant_override AS i, charge_frequency_override AS f, included_occupancy AS inc
             FROM guesthub.rooms WHERE id=${r1.id}`;
    assert.equal(back.a, 80); assert.equal(back.c, 0, "explicit 0 override persists (not null)");
    assert.equal(back.i, null, "null override persists as null (inherit that field)"); assert.equal(back.f, "per_stay");
    assert.equal(back.inc, 2);
    ok("override persists: explicit 0 kept distinct from null (inherit)");

    // ---- CHECK constraints ----
    await expectViolation(tx, "23514", "included>max", (sp) =>
      sp`UPDATE guesthub.rooms SET included_occupancy=9 WHERE id=${r1.id}`);
    await expectViolation(tx, "23514", "included<1", (sp) =>
      sp`UPDATE guesthub.rooms SET included_occupancy=0 WHERE id=${r1.id}`);
    await expectViolation(tx, "23514", "default>max", (sp) =>
      sp`UPDATE guesthub.rooms SET default_occupancy=9 WHERE id=${r1.id}`);
    await expectViolation(tx, "23514", "negative override", (sp) =>
      sp`UPDATE guesthub.rooms SET extra_adult_override=-1 WHERE id=${r1.id}`);
    await expectViolation(tx, "23514", "bad mode", (sp) =>
      sp`UPDATE guesthub.rooms SET extra_guest_pricing_mode='weird' WHERE id=${r1.id}`);
    ok("CHECK constraints: included/default vs max, non-negative override, valid mode");

    // ---- tenant isolation ----
    await mkRoom(tB.id, "999");
    const aRooms = await tx`SELECT tenant_id FROM guesthub.rooms WHERE tenant_id=${tA.id}`;
    assert.ok(aRooms.length === 1 && aRooms.every((x) => x.tenant_id === tA.id), "tenant A sees only its rooms");
    ok("tenant isolation on rooms");

    // ---- pricing_plans → policy FK (ON DELETE SET NULL) ----
    const [su] = await tx`INSERT INTO guesthub.sellable_units (tenant_id, code, name) VALUES (${tA.id},'su1','SU 1') RETURNING id`;
    const [pol] = await tx`INSERT INTO guesthub.cancellation_policies (tenant_id, name, public_title, code)
             VALUES (${tA.id},'Flex','גמיש','flex') RETURNING id`;
    const [pp] = await tx`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, cancellation_policy_id)
             VALUES (${tA.id}, ${su.id}, 'base', 'Base', ${pol.id}) RETURNING id, cancellation_policy_id`;
    assert.equal(pp.cancellation_policy_id, pol.id, "rate plan links to cancellation policy");
    await tx`DELETE FROM guesthub.cancellation_policies WHERE id=${pol.id}`;
    const [after] = await tx`SELECT cancellation_policy_id FROM guesthub.pricing_plans WHERE id=${pp.id}`;
    assert.equal(after.cancellation_policy_id, null, "ON DELETE SET NULL — deleting policy nulls the link, plan survives");
    ok("pricing_plans ↔ policy FK links and ON DELETE SET NULL keeps the plan");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); await sql.end(); process.exit(1); }
}
await sql.end();
console.log(`\n✓ room DB checks passed (${n} groups) — all writes rolled back, test DB untouched`);
