import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (url.includes(marker)) {
    process.stderr.write(`✗ refusing production-like database marker: ${marker}\n`);
    process.exit(1);
  }
}

execSync(
  'for f in $(ls db/migrations/*.sql | sort); do docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null 2>&1; done',
  { stdio: "inherit", shell: "/bin/bash" },
);

// Import the production TypeScript core after compiling only its pure dependency
// closure. Extension patching is limited to emitted test artifacts; source stays
// in the extensionless format Next.js consumes.
const out = mkdtempSync(join(process.cwd(), "node_modules/.cache/check-hours-db-"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
execSync(
  `pnpm exec tsc src/lib/check-in-check-out-mutation.ts src/lib/check-in-check-out.ts ` +
    `src/lib/check-in-check-out-policy.ts ` +
    `src/lib/dates.ts src/lib/auth/permission-check.ts src/lib/audit-write.ts --outDir ${out} ` +
    "--module esnext --target es2022 --moduleResolution bundler --skipLibCheck",
  { stdio: "inherit" },
);
const patchImport = (path, replacements) => {
  let source = readFileSync(path, "utf8");
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  writeFileSync(path, source);
};
patchImport(join(out, "check-in-check-out.js"), [
  ['"./dates"', '"./dates.js"'],
  ['"./check-in-check-out-policy"', '"./check-in-check-out-policy.js"'],
]);
patchImport(join(out, "check-in-check-out-policy.js"), [['"./dates"', '"./dates.js"']]);
patchImport(join(out, "check-in-check-out-mutation.js"), [
  ['"./check-in-check-out"', '"./check-in-check-out.js"'],
  ['"./auth/permission-check"', '"./auth/permission-check.js"'],
  ['"./audit-write"', '"./audit-write.js"'],
]);
const { saveCheckInCheckOutSettingsCore } = await import(join(out, "check-in-check-out-mutation.js"));

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
class Rollback extends Error {}
let checks = 0;
const ok = (name) => {
  process.stdout.write(`  ✓ ${name}\n`);
  checks += 1;
};

const saved = {
  timezone: "Asia/Jerusalem",
  regular: { weekdays: [0, 1, 2, 3, 4, 5], check_in_from: "15:00", check_out_until: "11:00" },
  special: {
    saturday: true,
    holiday_eve: true,
    holiday: true,
    check_in_from: "14:00",
    check_out_until: "12:00",
  },
};
const slug = `check-hours-${Date.now()}`;

try {
  await sql.begin(async (tx) => {
    const initial = {
      vat_rate: 17,
      business_profile: { property_name: "Sibling setting" },
      unrelated_nested: { enabled: true, value: 42 },
    };
    const [tenant] = await tx`
      INSERT INTO guesthub.tenants (name, slug, settings)
      VALUES ('Check hours disposable tenant', ${slug}, ${sql.json(initial)}::jsonb)
      RETURNING id`;
    const [user] = await tx`
      INSERT INTO guesthub.users (tenant_id, username)
      VALUES (${tenant.id}, 'check-hours-verifier')
      RETURNING id`;

    const unauthorizedActor = {
      tenantId: tenant.id,
      userId: user.id,
      roleKey: "viewer",
      permissions: new Set(),
    };
    await assert.rejects(
      saveCheckInCheckOutSettingsCore({ actor: unauthorizedActor, raw: saved, db: tx }),
      (error) => error?.name === "AuthorizationError" && /settings\.edit/.test(error.message),
    );
    const [afterRejected] = await tx`
      SELECT settings, (SELECT count(*)::int FROM guesthub.audit_logs WHERE tenant_id = ${tenant.id}) AS audits
      FROM guesthub.tenants WHERE id = ${tenant.id}`;
    assert.deepEqual(afterRejected.settings, initial);
    assert.equal(afterRejected.audits, 0);
    ok("the production core rejects unauthorized callers before settings or audit writes");

    const authorizedActor = {
      tenantId: tenant.id,
      userId: user.id,
      roleKey: "manager",
      permissions: new Set(["settings.edit"]),
    };
    await assert.rejects(
      saveCheckInCheckOutSettingsCore({
        actor: authorizedActor,
        raw: { ...saved, regular: { ...saved.regular, check_in_from: "24:00" } },
        db: tx,
      }),
      (error) => error?.name === "CheckInCheckOutValidationError",
    );
    const [afterInvalid] = await tx`
      SELECT settings, (SELECT count(*)::int FROM guesthub.audit_logs WHERE tenant_id = ${tenant.id}) AS audits
      FROM guesthub.tenants WHERE id = ${tenant.id}`;
    assert.deepEqual(afterInvalid.settings, initial);
    assert.equal(afterInvalid.audits, 0);
    ok("the production core rejects malformed HH:mm before settings or audit writes");

    const brokenAuditActor = {
      tenantId: tenant.id,
      userId: randomUUID(),
      roleKey: "manager",
      permissions: new Set(["settings.edit"]),
    };
    await assert.rejects(
      saveCheckInCheckOutSettingsCore({ actor: brokenAuditActor, raw: saved, db: tx }),
      (error) => error?.code === "23503",
    );
    const [afterAuditFailure] = await tx`
      SELECT settings, (SELECT count(*)::int FROM guesthub.audit_logs WHERE tenant_id = ${tenant.id}) AS audits
      FROM guesthub.tenants WHERE id = ${tenant.id}`;
    assert.deepEqual(afterAuditFailure.settings, initial);
    assert.equal(afterAuditFailure.audits, 0);
    ok("an audit FK failure rolls back the preceding settings update atomically");

    const returned = await saveCheckInCheckOutSettingsCore({
      actor: authorizedActor,
      raw: saved,
      db: tx,
    });
    assert.deepEqual(returned, saved);

    const [tenantAfter] = await tx`
      SELECT settings FROM guesthub.tenants WHERE id = ${tenant.id}`;
    assert.deepEqual(tenantAfter.settings.check_in_check_out, saved);
    assert.equal(tenantAfter.settings.vat_rate, 17);
    assert.deepEqual(tenantAfter.settings.business_profile, initial.business_profile);
    assert.deepEqual(tenantAfter.settings.unrelated_nested, initial.unrelated_nested);
    ok("the production core saves a valid payload and preserves every JSONB sibling");

    const audits = await tx`
      SELECT action, entity_type, entity_id, before_data, after_data
      FROM guesthub.audit_logs
      WHERE tenant_id = ${tenant.id}`;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "update_check_in_check_out_hours");
    assert.equal(audits[0].entity_type, "tenant_settings");
    assert.equal(audits[0].entity_id, tenant.id);
    assert.deepEqual(audits[0].before_data, { check_in_check_out: null });
    assert.deepEqual(audits[0].after_data, { check_in_check_out: saved });
    ok("the same core writes the exact before/after audit atomically with the setting");

    const [sideEffects] = await tx`
      SELECT
        (SELECT count(*)::int FROM guesthub.reservations WHERE tenant_id = ${tenant.id}) AS reservations,
        (SELECT count(*)::int FROM guesthub.bulk_rate_update_logs WHERE tenant_id = ${tenant.id}) AS rate_updates,
        (SELECT count(*)::int FROM guesthub.channel_dirty_ranges WHERE tenant_id = ${tenant.id}) AS dirty_ranges,
        (SELECT count(*)::int FROM guesthub.channel_sync_jobs WHERE tenant_id = ${tenant.id}) AS sync_jobs,
        (SELECT count(*)::int FROM guesthub.channel_inventory_holds WHERE tenant_id = ${tenant.id}) AS inventory_holds`;
    assert.deepEqual(sideEffects, {
      reservations: 0,
      rate_updates: 0,
      dirty_ranges: 0,
      sync_jobs: 0,
      inventory_holds: 0,
    });
    ok("the production core creates no booking, rate, inventory or channel side effect");

    throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) {
    await sql.end();
    throw error;
  }
}

const [residue] = await sql`
  SELECT
    (SELECT count(*)::int FROM guesthub.tenants WHERE slug = ${slug}) AS tenants,
    (SELECT count(*)::int FROM guesthub.audit_logs a
      JOIN guesthub.tenants t ON t.id = a.tenant_id WHERE t.slug = ${slug}) AS audits`;
assert.deepEqual(residue, { tenants: 0, audits: 0 });
ok("outer disposable transaction rolled back with no fixture or audit residue");

await sql.end();
process.stdout.write(`\n✓ check-in/check-out DB checks passed (${checks} groups) through production core\n`);
