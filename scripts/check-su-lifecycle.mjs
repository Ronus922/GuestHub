// DB-integration check for the sellable-unit lifecycle (migration 026, D66)
// against the ISOLATED disposable test DB (guesthub-testdb, :5433) — NEVER
// production. It
//   1. applies the full migration chain 000..026 to the test DB, then
//      re-applies 026 a SECOND time (blank-schema + idempotency validation),
//   2. seeds a tenant that reproduces the production defect (orphaned units
//      "302"/"303", a room "1424" with no unit), re-applies 026 and asserts
//      the repair: orphans deleted with their substrate, protected orphans
//      archived instead, the missing unit created + base-planned + assigned
//      to the live tenant plans only,
//   3. asserts the guards: the Step-3 selection derivation never returns a
//      unit without an active member room, deleting the last membership
//      archives the unit (trigger), tenant-mismatched membership rows are
//      rejected (composite FKs), one unit per room (UNIQUE room_id), and
//      effective_sell_state prices the repaired unit from the room type's
//      base_price — no fabricated per-date rows.
// Usage: node scripts/check-su-lifecycle.mjs
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import assert from "node:assert/strict";

// Disposable local test DB only. Refuse anything that smells of production.
const URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (URL.includes(marker)) { console.error(`✗ refusing: production marker "${marker}" in TEST_DATABASE_URL`); process.exit(1); }
}

const applyChain = () => execSync(
  'for f in $(ls db/migrations/*.sql | sort); do docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null; done',
  { stdio: "inherit", shell: "/bin/bash" },
);
const apply026 = () => execSync(
  'docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < db/migrations/026_sellable_unit_lifecycle.sql >/dev/null 2>&1',
  { stdio: "inherit", shell: "/bin/bash" },
);

console.log("→ applying migration chain 000..026 to guesthub-testdb…");
applyChain();
console.log("→ re-applying 026_sellable_unit_lifecycle.sql a second time (idempotency)…");
apply026();

const sql = postgres(URL, { prepare: false, max: 1, onnotice: () => {} });
let n = 0;
const ok = (name) => { n++; console.log(`  ✓ ${n}. ${name}`); };

const uniq = (p) => `${p}-${randomUUID().slice(0, 8)}`;

// COMMITTED seed (026 is re-applied from a separate psql session mid-test, so
// rollback-scenarios can't carry the defect state). Torn down by tenant delete.
let tenantId;
let exitCode = 0;
try {
  [{ id: tenantId }] = await sql`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('SU lifecycle', ${uniq("su-lifecycle")}) RETURNING id`;
  const [{ id: typeId }] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price) VALUES (${tenantId}, 'סוויטה', 980) RETURNING id`;
  const mkRoom = async (number) =>
    (await sql`
      INSERT INTO guesthub.rooms (tenant_id, room_number, name, room_type_id, max_occupancy, max_adults)
      VALUES (${tenantId}, ${number}, ${"חדר " + number}, ${typeId}, 2, 2) RETURNING id`)[0].id;
  const mkSU = async (code, withRoomId = null) => {
    const [{ id }] = await sql`
      INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${tenantId}, ${code}, ${"יחידה " + code}, ${typeId}) RETURNING id`;
    if (withRoomId) await sql`
      INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
      VALUES (${tenantId}, ${id}, ${withRoomId})`;
    const [{ id: planId }] = await sql`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base)
      VALUES (${tenantId}, ${id}, 'base', 'מחיר בסיס', true) RETURNING id`;
    return { id, planId };
  };

  // ---- reproduce the production defect ----
  // healthy mapped room, tenant plans (one live, one archived, one inactive)
  const okRoomId = await mkRoom("926");
  const okSU = await mkSU("101", okRoomId);
  const [{ id: livePlan }] = await sql`
    INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind)
    VALUES (${tenantId}, 'BG', 'ביטול גמיש', 'independent') RETURNING id`;
  const [{ id: archivedPlan }] = await sql`
    INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, is_archived)
    VALUES (${tenantId}, 'OLD', 'ארכיון', 'independent', true) RETURNING id`;
  const [{ id: inactivePlan }] = await sql`
    INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind, is_active)
    VALUES (${tenantId}, 'OFF', 'כבויה', 'independent', false) RETURNING id`;

  // orphan "302": no member room; base-ARI rows + plan assignment (pure substrate)
  const orphan302 = await mkSU("302");
  await sql`
    INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
    VALUES (${tenantId}, ${orphan302.id}, ${orphan302.planId}, '2026-08-01', 500),
           (${tenantId}, ${orphan302.id}, ${orphan302.planId}, '2026-08-02', 500)`;
  await sql`
    INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id)
    VALUES (${tenantId}, ${livePlan}, ${orphan302.id})`;

  // orphan "303": carries an operator-authored overlay row → protected
  const orphan303 = await mkSU("303");
  await sql`
    INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id)
    VALUES (${tenantId}, ${livePlan}, ${orphan303.id})`;
  await sql`
    INSERT INTO guesthub.pricing_plan_unit_rates (tenant_id, pricing_plan_id, sellable_unit_id, date, price)
    VALUES (${tenantId}, ${livePlan}, ${orphan303.id}, '2026-08-01', 777)`;

  // room "1424": exists, active, has NO sellable unit
  const room1424 = await mkRoom("1424");

  // ---- run the repair (the migration itself, third application) ----
  apply026();
  ok("seeded the production defect and re-applied 026 (third application — still clean)");

  const su = async (code) => (await sql`
    SELECT id, is_active FROM guesthub.sellable_units WHERE tenant_id = ${tenantId} AND code = ${code}`)[0];

  // reference-free orphan deleted with its substrate
  assert.equal(await su("302"), undefined, "orphan 302 deleted");
  const [{ c: pprLeft }] = await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.pricing_plan_rates WHERE sellable_unit_id = ${orphan302.id}`;
  const [{ c: ppuLeft }] = await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.pricing_plan_units WHERE sellable_unit_id = ${orphan302.id}`;
  assert.equal(pprLeft, 0, "orphan base-ARI rows cascaded");
  assert.equal(ppuLeft, 0, "orphan plan assignments cascaded");
  ok("reference-free orphan unit (302) deleted; its base-ARI rows + plan assignments went with it");

  // protected orphan (operator overlay rows) archived, never deleted
  const s303 = await su("303");
  assert.ok(s303, "protected orphan survives");
  assert.equal(s303.is_active, false, "protected orphan archived");
  const [{ c: ppurKept }] = await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.pricing_plan_unit_rates WHERE sellable_unit_id = ${orphan303.id}`;
  assert.equal(ppurKept, 1, "operator-authored overlay row retained");
  ok("orphan with operator-authored overlay rates (303) archived — data retained, unit unsellable");

  // missing unit created for room 1424: membership + base plan + live-plan assignment
  const s1424 = await su("1424");
  assert.ok(s1424, "unit 1424 created");
  assert.equal(s1424.is_active, true);
  const [member] = await sql`
    SELECT room_id FROM guesthub.sellable_unit_rooms WHERE sellable_unit_id = ${s1424.id}`;
  assert.equal(member.room_id, room1424, "membership points at room 1424");
  const [basePlan] = await sql`
    SELECT id FROM guesthub.pricing_plans WHERE sellable_unit_id = ${s1424.id} AND is_base AND is_active`;
  assert.ok(basePlan, "SU-scoped base plan created");
  const assigned = await sql`
    SELECT pricing_plan_id FROM guesthub.pricing_plan_units WHERE sellable_unit_id = ${s1424.id}`;
  assert.deepEqual(assigned.map((a) => a.pricing_plan_id), [livePlan],
    "assigned to the live tenant plan ONLY — never to archived/inactive plans");
  void archivedPlan; void inactivePlan;
  ok("room 1424 repaired: one unit, membership, base plan, assigned to live tenant plans only");

  // no fabricated prices: zero per-date rows; effective_sell_state falls back
  // to the room type's base_price
  const [{ c: invented }] = await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.pricing_plan_rates WHERE sellable_unit_id = ${s1424.id}`;
  assert.equal(invented, 0, "no per-date price rows invented");
  const ess = await sql`
    SELECT price::float8 AS price, sellable FROM guesthub.effective_sell_state(${tenantId}, '2026-08-01', '2026-08-03')
    WHERE sellable_unit_id = ${s1424.id}`;
  assert.equal(ess.length, 2, "repaired unit appears in effective_sell_state");
  assert.ok(ess.every((r) => r.price === 980 && r.sellable), "prices via room-type base_price fallback (980), sellable");
  ok("room 1424 prices through the canonical room-type base_price fallback — nothing copied or fabricated");

  // Step-3 selection derivation (the exact join listAssignableUnits uses):
  // active rooms with valid units only — 302/303 absent, 926+1424 present
  const selectable = await sql`
    SELECT r.room_number
    FROM guesthub.sellable_units su
    JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
    JOIN guesthub.rooms r ON r.id = sur.room_id AND r.is_active
    WHERE su.tenant_id = ${tenantId} AND su.is_active
    ORDER BY r.room_number`;
  assert.deepEqual(selectable.map((r) => r.room_number), ["1424", "926"],
    "selection = active rooms with valid units, nothing else");
  ok("Rate Plan selection derivation returns exactly the active rooms (1424 in, 302/303 out)");

  // idempotency of the repair on real data: fourth application changes nothing
  const census = () => sql`
    SELECT (SELECT COUNT(*)::int FROM guesthub.sellable_units WHERE tenant_id = ${tenantId}) AS units,
           (SELECT COUNT(*)::int FROM guesthub.sellable_unit_rooms WHERE tenant_id = ${tenantId}) AS members,
           (SELECT COUNT(*)::int FROM guesthub.pricing_plans WHERE tenant_id = ${tenantId}) AS plans,
           (SELECT COUNT(*)::int FROM guesthub.pricing_plan_units WHERE tenant_id = ${tenantId}) AS assignments`;
  const [before] = await census();
  apply026();
  const [after] = await census();
  assert.deepEqual(after, before, "re-applying 026 on repaired data is a no-op");
  ok("repair is idempotent — fourth application of 026 changes nothing");

  // trigger: deleting the last membership row archives the unit (direct-SQL
  // room deletion can never strand a selectable unit again)
  const tRoom = await mkRoom("TRIG");
  const tSU = await mkSU("TRIG", tRoom);
  await sql`DELETE FROM guesthub.rooms WHERE id = ${tRoom}`; // cascades the membership
  const [tState] = await sql`
    SELECT is_active FROM guesthub.sellable_units WHERE id = ${tSU.id}`;
  assert.equal(tState.is_active, false, "unit archived by trigger");
  ok("direct-SQL room delete → membership cascade → trigger archives the unit (the 302/303 hole is closed)");

  // one unit per room: second membership for the same room rejected
  const dSU = await mkSU("DUP");
  let dupErr = null;
  try {
    await sql`
      INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
      VALUES (${tenantId}, ${dSU.id}, ${okRoomId})`;
  } catch (e) { dupErr = e; }
  assert.equal(dupErr?.code, "23505", "duplicate membership rejected");
  ok("a room can never carry two sellable units (UNIQUE room_id, 23505)");

  // tenant consistency: membership pairing a unit with a foreign tenant's id fails
  const [{ id: otherTenant }] = await sql`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('SU foreign', ${uniq("su-foreign")}) RETURNING id`;
  const fRoom = await mkRoom("FK"); // fresh room — no membership, so the FK (not UNIQUE) decides
  let fkErr = null;
  try {
    await sql`
      INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
      VALUES (${otherTenant}, ${dSU.id}, ${fRoom})`;
  } catch (e) { fkErr = e; }
  assert.equal(fkErr?.code, "23503", "cross-tenant membership rejected");
  await sql`DELETE FROM guesthub.tenants WHERE id = ${otherTenant}`;
  ok("cross-tenant membership rejected by the composite FKs (23503)");

  // healthy unit untouched throughout
  const [okState] = await sql`
    SELECT su.is_active, sur.room_id
    FROM guesthub.sellable_units su
    JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
    WHERE su.id = ${okSU.id}`;
  assert.ok(okState?.is_active && okState.room_id === okRoomId, "healthy unit untouched");
  ok("healthy mapped unit (926) untouched by repair, trigger and guards");

  console.log(`\nALL ${n} SELLABLE-UNIT LIFECYCLE CHECKS PASSED`);
} catch (e) {
  exitCode = 1;
  console.error("\n✗ FAILED:", e.message ?? e);
} finally {
  if (tenantId) await sql`DELETE FROM guesthub.tenants WHERE id = ${tenantId}`.catch(() => {});
  await sql.end();
}
process.exit(exitCode);
