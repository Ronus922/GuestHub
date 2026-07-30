#!/usr/bin/env node
// ============================================================
// check:resolve-version-lineage — D117 pinned against a REAL Postgres (B2).
//
// THE DEFECT (reservation 1060). resolveVersion's guest-language "sibling"
// lookup matched published templates by (tenant, category, channel, language)
// — labels, not identity — with LIMIT 1 and no ORDER BY. Two published
// WhatsApp templates shared reservation+he, and the guest-confirmation
// automation sent the internal-notification body to the guest.
//
// Why this guard runs REAL SQL: the existing engine harness stubs `sql` by
// string-matching the query text — the stub embodied the same wrong
// assumption and could never catch a defect that lives IN the SQL.
//
// THE PINS:
//   1. Reproduce 1060 exactly (two published templates, same category +
//      channel + language, different lineages, guest language 'עברית') —
//      the resolved version MUST belong to the automation's own template.
//   2. Explicitly-linked lineage still serves translations (en sibling), and
//      an unlinked language falls back to the configured template's version.
//   3. Two published same-language templates in ONE lineage = configuration
//      defect → outcome 'ambiguous', never a lucky pick.
//   4. Migration 067's composite FK rejects a delivery row whose version
//      belongs to a different template than its template_id.
//   5. Call-site integrity: the outbound INSERTs stamp version.template_id.
//
// Needs the local test DB (guesthub-testdb, port 5433) — never production.
// ============================================================
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const url = process.env.TEST_DATABASE_URL
  || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (url.includes(marker)) throw new Error(`refusing production-like database marker: ${marker}`);
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

// ---- migration 067: applied, and idempotently reapplied ----
const migration = readFileSync(join(ROOT, "db/migrations/067_template_lineage.sql"), "utf8");
await sql.unsafe(migration);
await sql.unsafe(migration);
ok("migration 067 applies and reapplies idempotently");

// ---- compile automation.ts from THIS tree, pointed at the test DB ----
mkdirSync(join(ROOT, "node_modules/.cache"), { recursive: true });
const out = mkdtempSync(join(ROOT, "node_modules/.cache/check-resolve-version-lineage-"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
const tsconfig = join(out, "tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    module: "esnext", target: "es2022", moduleResolution: "bundler", skipLibCheck: true,
    baseUrl: ROOT, paths: { "@/*": ["src/*"] }, rootDir: join(ROOT, "src/lib"), outDir: out,
  },
  files: [join(ROOT, "src/lib/communications/automation.ts")],
}));
execSync(`pnpm exec tsc --project ${tsconfig}`, { stdio: "inherit", cwd: ROOT });

// Rewrite emitted imports generically: alias → relative, extensionless → .js.
const emitted = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".js")) emitted.push(path);
  }
})(out);
for (const path of emitted) {
  const rel = relative(dirname(path), out) || ".";
  const source = readFileSync(path, "utf8")
    .replace(/import "server-only";\n?/g, "")
    .replace(/from "@\/lib\/db"/g, `from "${rel}/test-db-real.js"`)
    .replace(/from "@\/lib\/([^"]+)"/g, (_m, x) => `from "${rel}/${x}.js"`)
    .replace(/from "(\.[^"]+)"/g, (_m, x) => (x.endsWith(".js") ? `from "${x}"` : `from "${x}.js"`));
  writeFileSync(path, source);
}
writeFileSync(join(out, "test-db-real.js"),
  `import postgres from "postgres";\nexport const sql = postgres(${JSON.stringify(url)}, { max: 1, prepare: false, onnotice: () => {} });\n`);
writeFileSync(join(out, "communications/automation.js"),
  readFileSync(join(out, "communications/automation.js"), "utf8")
  + "\nexport { resolveVersion, resolvedVersion };\n");

const automation = await import(join(out, "communications/automation.js"));
const db = await import(join(out, "test-db-real.js"));

// ---- fixture: reservation-1060's shape, on a dedicated throwaway tenant ----
const SLUG = "lineage-check";
// Published versions are immutable by trigger (036) — for TEST-fixture removal
// only, the cleanup connection drops to replica role so the throwaway tenant
// can actually be deleted. Never a pattern for application code.
async function cleanup(client) {
  const tenants = await client`SELECT id FROM guesthub.tenants WHERE slug = ${SLUG}`;
  if (tenants.length === 0) return;
  await client`SET session_replication_role = replica`;
  try {
    for (const { id } of tenants) {
      await client`DELETE FROM guesthub.outbound_messages WHERE tenant_id = ${id}`;
      await client`UPDATE guesthub.message_templates SET current_published_version_id = NULL, lineage_id = NULL WHERE tenant_id = ${id}`;
      await client`DELETE FROM guesthub.message_template_versions WHERE tenant_id = ${id}`;
      await client`DELETE FROM guesthub.communication_automations WHERE tenant_id = ${id}`;
      await client`DELETE FROM guesthub.message_templates WHERE tenant_id = ${id}`;
      await client`DELETE FROM guesthub.tenants WHERE id = ${id}`;
    }
  } finally {
    await client`SET session_replication_role = DEFAULT`;
  }
}
await cleanup(sql);

try {
  const [tenant] = await sql`INSERT INTO guesthub.tenants (name, slug) VALUES ('Lineage Check', ${SLUG}) RETURNING id`;
  const tid = tenant.id;

  const template = async (name, language, body) => {
    const [t] = await sql`
      INSERT INTO guesthub.message_templates
        (tenant_id, channel, slug, name, body, category, language, lifecycle_state, is_active, is_system)
      VALUES (${tid}, 'whatsapp', ${`lineage-check-${name}-${language}`}, ${name}, ${body},
              'reservation', ${language}, 'published', true, false)
      RETURNING id`;
    const [v] = await sql`
      INSERT INTO guesthub.message_template_versions
        (tenant_id, template_id, version_number, subject, content)
      VALUES (${tid}, ${t.id}, 1, '', ${sql.json({ schemaVersion: 1, kind: "whatsapp_text", text: body })})
      RETURNING id`;
    await sql`UPDATE guesthub.message_templates SET current_published_version_id = ${v.id} WHERE id = ${t.id}`;
    return { id: t.id, versionId: v.id };
  };

  // 1060 exactly: both published, category='reservation', channel='whatsapp',
  // language='he', DIFFERENT lineages (both NULL = each its own).
  const guestConfirm = await template("guest-confirm", "he", "שלום {{guest.first_name}}, ההזמנה אושרה");
  const internal = await template("internal-note", "he", "התקבלה הזמנה חדשה מאת {{guest.full_name}}");

  const auto = {
    id: "00000000-0000-0000-0000-000000000000", tenant_id: tid,
    channel: "whatsapp", template_id: guestConfirm.id,
    template_version_policy: "latest_published", locked_template_version_id: null,
  };

  // ---- PIN 1: the 1060 reproduction ----
  for (let round = 0; round < 3; round++) {
    const resolution = await automation.resolveVersion(auto, "עברית");
    assert.equal(resolution.outcome, "resolved");
    assert.equal(resolution.version.template_id, guestConfirm.id,
      "the resolved version MUST belong to the automation's own template — 1060 sent another template's body");
    assert.equal(resolution.version.id, guestConfirm.versionId);
  }
  ok("1060 fixture: guest-language resolution stays inside the template's lineage, deterministically (×3)");

  // ---- PIN 2a: explicit lineage still serves translations ----
  const english = await template("guest-confirm", "en", "Hi {{guest.first_name}}, your reservation is confirmed");
  await sql`UPDATE guesthub.message_templates SET lineage_id = ${guestConfirm.id} WHERE id IN (${guestConfirm.id}, ${english.id})`;
  const en = await automation.resolveVersion(auto, "English");
  assert.equal(en.outcome, "resolved");
  assert.equal(en.version.template_id, english.id, "an explicitly-linked en sibling must serve English guests");
  const he = await automation.resolveVersion(auto, "עברית");
  assert.equal(he.outcome, "resolved");
  assert.equal(he.version.template_id, guestConfirm.id);
  ok("explicit lineage: en sibling serves English, he stays on the configured template");

  // ---- PIN 2b: no sibling in the guest's language → own published version ----
  await sql`UPDATE guesthub.message_templates SET lineage_id = NULL WHERE id = ${english.id}`;
  const fallback = await automation.resolveVersion(auto, "English");
  assert.equal(fallback.outcome, "resolved");
  assert.equal(fallback.version.template_id, guestConfirm.id,
    "no in-lineage version for the language → the template's OWN published version, never another template's");
  ok("unlinked language falls back to the configured template's own version");

  // ---- PIN 3: two published same-language templates in ONE lineage = defect ----
  await sql`UPDATE guesthub.message_templates SET lineage_id = ${guestConfirm.id} WHERE id = ${internal.id}`;
  const ambiguous = await automation.resolveVersion(auto, "עברית");
  assert.equal(ambiguous.outcome, "ambiguous",
    ">1 candidate must be a NAMED defect, not a lucky pick");
  assert.deepEqual([...ambiguous.candidateTemplateIds].sort(), [guestConfirm.id, internal.id].sort());
  await sql`UPDATE guesthub.message_templates SET lineage_id = NULL WHERE id = ${internal.id}`;
  ok("same-language duplication inside a lineage resolves to 'ambiguous', naming both candidates");

  // ---- PIN 4: the composite FK forbids the self-contradictory row ----
  const insertDelivery = (templateId, versionId) => sql`
    INSERT INTO guesthub.outbound_messages
      (tenant_id, channel, provider, template_id, template_version_id, to_address,
       subject, body, status, rendered_html, rendered_plain_text, delivery_type,
       scheduled_at, max_attempts)
    VALUES (${tid}, 'whatsapp', 'green_api', ${templateId}, ${versionId}, '+972500000000',
       NULL, 'x', 'queued', '', 'x', 'test', now(), 1)
    RETURNING id`;
  let fkError = null;
  try { await insertDelivery(guestConfirm.id, internal.versionId); } catch (error) { fkError = error; }
  assert.equal(fkError?.code, "23503",
    "a delivery whose version belongs to ANOTHER template must be impossible to write");
  const [good] = await insertDelivery(guestConfirm.id, guestConfirm.versionId);
  assert.ok(good?.id, "a consistent delivery row still inserts");
  ok("outbound_messages composite FK: version-of-another-template is rejected, consistent row accepted");

  // ---- PIN 5: call-site integrity ----
  const source = readFileSync(join(ROOT, "src/lib/communications/automation.ts"), "utf8");
  assert.ok((source.match(/\$\{version\.template_id\}/g) ?? []).length >= 2,
    "both send INSERTs must stamp the template the version actually belongs to");
  assert.match(source, /ORDER BY \(t\.id = cfg\.id\) DESC, t\.id/,
    "the sibling lookup must be deterministically ordered — never execution-plan luck");
  assert.match(source, /COALESCE\(t\.lineage_id, t\.id\) = COALESCE\(cfg\.lineage_id, cfg\.id\)/,
    "the sibling lookup must be lineage-scoped");
  assert.ok(!/t\.category = cfg\.category/.test(source),
    "label-matching (category) must not be the sibling identity — that was the 1060 defect");
  ok("call sites: lineage-scoped ordered lookup; INSERTs stamp version.template_id");
} finally {
  await cleanup(sql);
  await db.sql.end({ timeout: 3 });
  await sql.end({ timeout: 3 });
}

console.log(`\nALL ${n} PASSED — resolve-version-lineage`);
