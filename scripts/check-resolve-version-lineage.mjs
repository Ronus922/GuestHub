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
// Why it DROPS 067's objects before applying it: a guard that merely finds a
// constraint in the test DB proves nothing about the migration in THIS tree —
// the object may be left over from an earlier run. Every object 067 creates is
// removed first, then the file is applied, then existence is asserted. Empty
// the migration and this guard falls.
//
// Needs the local test DB (guesthub-testdb, port 5433) — never production.
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

// An ALLOW-list, not a deny-list: a deny-list of production markers passes
// anything its author did not think of, and this guard writes and DELETES rows.
const url = process.env.TEST_DATABASE_URL
  || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
{
  const parsed = new URL(url);
  const localHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (!localHost || parsed.port !== "5433") {
    throw new Error(`refusing ${parsed.hostname}:${parsed.port || "(default)"} — this guard only runs against the local test DB on 5433`);
  }
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const objectExists = async (kind, name) => {
  const [row] = kind === "trigger"
    ? await sql`SELECT 1 AS x FROM pg_trigger WHERE tgname = ${name} AND NOT tgisinternal`
    : kind === "column"
      ? await sql`SELECT 1 AS x FROM information_schema.columns
                  WHERE table_schema = 'guesthub' AND table_name = 'message_templates' AND column_name = ${name}`
      : await sql`SELECT 1 AS x FROM pg_constraint WHERE conname = ${name}`;
  return Boolean(row);
};

// ---- migration 067: dropped, applied from THIS tree, asserted, reapplied ----
const migration = readFileSync(join(ROOT, "db/migrations/067_template_lineage.sql"), "utf8");
const CREATED = [
  ["column", "lineage_id"],
  ["constraint", "message_templates_lineage_tenant_fkey"],
  ["constraint", "message_template_versions_tenant_template_id_key"],
  ["constraint", "outbound_messages_version_matches_template_fkey"],
  ["constraint", "message_templates_current_version_owned_fkey"],
  ["trigger", "trg_template_lineage_root"],
];
await sql.unsafe(`
  SET search_path TO "guesthub", public;
  ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_version_matches_template_fkey;
  ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_current_version_owned_fkey;
  ALTER TABLE message_template_versions DROP CONSTRAINT IF EXISTS message_template_versions_tenant_template_id_key;
  DROP TRIGGER IF EXISTS trg_template_lineage_root ON message_templates;
  DROP FUNCTION IF EXISTS guesthub.enforce_template_lineage_root();
  ALTER TABLE message_templates DROP COLUMN IF EXISTS lineage_id;`);
for (const [kind, name] of CREATED) {
  assert.equal(await objectExists(kind, name), false, `${name} must be gone before the migration runs`);
}
await sql.unsafe(migration);
for (const [kind, name] of CREATED) {
  assert.equal(await objectExists(kind, name), true, `migration 067 must create ${kind} ${name}`);
}
await sql.unsafe(migration);
for (const [kind, name] of CREATED) {
  assert.equal(await objectExists(kind, name), true, `${kind} ${name} must survive a reapply`);
}
ok("migration 067 creates every object from scratch and reapplies idempotently");

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

const dbError = async (fn) => {
  try { await fn(); } catch (error) { return error; }
  return null;
};

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

  const autoFor = (templateId) => ({
    id: "00000000-0000-0000-0000-000000000000", tenant_id: tid,
    channel: "whatsapp", template_id: templateId,
    template_version_policy: "latest_published", locked_template_version_id: null,
  });
  const auto = autoFor(guestConfirm.id);

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
  await sql`UPDATE guesthub.message_templates SET lineage_id = ${guestConfirm.id} WHERE id = ${english.id}`;
  const en = await automation.resolveVersion(auto, "English");
  assert.equal(en.outcome, "resolved");
  assert.equal(en.version.template_id, english.id, "an explicitly-linked en sibling must serve English guests");
  const he = await automation.resolveVersion(auto, "עברית");
  assert.equal(he.outcome, "resolved");
  assert.equal(he.version.template_id, guestConfirm.id);
  ok("explicit lineage: en sibling serves English, he stays on the configured template");

  // ---- PIN 2b: the cfg SIDE of the COALESCE — automation on a MEMBER ----
  // The automation points at the en MEMBER (lineage_id set); a Hebrew guest must
  // reach the ROOT's he version. Only the cfg-side COALESCE makes this work.
  const fromMember = await automation.resolveVersion(autoFor(english.id), "עברית");
  assert.equal(fromMember.outcome, "resolved");
  assert.equal(fromMember.version.template_id, guestConfirm.id,
    "an automation configured on a lineage MEMBER must resolve to the root's same-language sibling");
  ok("cfg-side lineage: an automation on a member resolves across to the root's sibling");

  // ---- PIN 2c: no sibling in the guest's language → own published version ----
  await sql`UPDATE guesthub.message_templates SET lineage_id = NULL WHERE id = ${english.id}`;
  const fallback = await automation.resolveVersion(auto, "English");
  assert.equal(fallback.outcome, "resolved");
  assert.equal(fallback.version.template_id, guestConfirm.id,
    "no in-lineage version for the language → the template's OWN published version, never another template's");
  ok("unlinked language falls back to the configured template's own version");

  // ---- PIN 3: same-language duplication inside a lineage = named defect ----
  await sql`UPDATE guesthub.message_templates SET lineage_id = ${guestConfirm.id} WHERE id = ${internal.id}`;
  const ambiguous = await automation.resolveVersion(auto, "עברית");
  assert.equal(ambiguous.outcome, "ambiguous",
    ">1 candidate must be a NAMED defect, not a lucky pick");
  assert.deepEqual([...ambiguous.candidateTemplateIds].sort(), [guestConfirm.id, internal.id].sort());
  // three duplicates: the evidence must name all three, not just the first two
  const third = await template("third-he", "he", "שלישית");
  await sql`UPDATE guesthub.message_templates SET lineage_id = ${guestConfirm.id} WHERE id = ${third.id}`;
  const ambiguous3 = await automation.resolveVersion(auto, "עברית");
  assert.equal(ambiguous3.outcome, "ambiguous");
  assert.equal(ambiguous3.candidateTemplateIds.length, 3,
    "the skip evidence must name every candidate it can, not silently stop at two");
  await sql`UPDATE guesthub.message_templates SET lineage_id = NULL WHERE id IN (${internal.id}, ${third.id})`;
  ok("same-language duplication inside a lineage → 'ambiguous', naming all candidates (2 and 3)");

  // ---- PIN 4: an ARCHIVED configured template never sends via a sibling ----
  await sql`UPDATE guesthub.message_templates SET lineage_id = ${guestConfirm.id} WHERE id = ${english.id}`;
  await sql`UPDATE guesthub.message_templates SET lifecycle_state = 'archived', archived_at = now() WHERE id = ${guestConfirm.id}`;
  const archived = await automation.resolveVersion(auto, "English");
  assert.equal(archived.outcome, "none",
    "an archived configured template must not keep reaching guests through a live sibling");
  await sql`UPDATE guesthub.message_templates SET lifecycle_state = 'published', archived_at = NULL WHERE id = ${guestConfirm.id}`;
  await sql`UPDATE guesthub.message_templates SET lineage_id = NULL WHERE id = ${english.id}`;
  ok("archived configured template: the sibling path refuses too (outcome 'none')");

  // ---- PIN 5: lineage shape is enforced, not merely documented ----
  const chain = await dbError(() =>
    sql`UPDATE guesthub.message_templates SET lineage_id = ${english.id} WHERE id = ${internal.id}`
      .then(() => sql`UPDATE guesthub.message_templates SET lineage_id = ${guestConfirm.id} WHERE id = ${english.id}`));
  assert.ok(chain, "a lineage CHAIN must be rejected — it would split the family under single-level grouping");
  await sql`UPDATE guesthub.message_templates SET lineage_id = NULL WHERE id IN (${internal.id}, ${english.id})`;
  const self = await dbError(() =>
    sql`UPDATE guesthub.message_templates SET lineage_id = ${english.id} WHERE id = ${english.id}`);
  assert.ok(self, "self-reference must be rejected — NULL already means 'my own lineage'");
  ok("lineage shape: chains and self-references are rejected by the DB");

  // ---- PIN 6: the pointer itself cannot address another template's version ----
  const stolen = await dbError(() =>
    sql`UPDATE guesthub.message_templates
        SET current_published_version_id = ${internal.versionId} WHERE id = ${guestConfirm.id}`);
  assert.equal(stolen?.code, "23503",
    "a published pointer at ANOTHER template's version must be unwritable — that is the 1060 defect class one storage bug away");
  ok("current_published_version_id can only address a version the template owns");

  // ---- PIN 7: the composite FK forbids the self-contradictory delivery row ----
  const insertDelivery = (templateId, versionId) => sql`
    INSERT INTO guesthub.outbound_messages
      (tenant_id, channel, provider, template_id, template_version_id, to_address,
       subject, body, status, rendered_html, rendered_plain_text, delivery_type,
       scheduled_at, max_attempts)
    VALUES (${tid}, 'whatsapp', 'green_api', ${templateId}, ${versionId}, '+972500000000',
       NULL, 'x', 'queued', '', 'x', 'test', now(), 1)
    RETURNING id`;
  const crossed = await dbError(() => insertDelivery(guestConfirm.id, internal.versionId));
  assert.equal(crossed?.code, "23503",
    "a delivery whose version belongs to ANOTHER template must be impossible to write");
  const [good] = await insertDelivery(guestConfirm.id, guestConfirm.versionId);
  assert.ok(good?.id, "a consistent delivery row still inserts");
  const [noVersion] = await insertDelivery(guestConfirm.id, null);
  assert.ok(noVersion?.id, "a manual/test row without a version is untouched by the FK (MATCH SIMPLE)");
  ok("outbound_messages composite FK: crossed row rejected, consistent and version-less rows accepted");

  // ---- PIN 8: call-site integrity ----
  const source = readFileSync(join(ROOT, "src/lib/communications/automation.ts"), "utf8");
  assert.ok((source.match(/\$\{version\.template_id\}/g) ?? []).length >= 2,
    "both send INSERTs must stamp the template the version actually belongs to");
  assert.match(source, /\$\{args\.version\?\.template_id \?\? args\.automation\.template_id\}/,
    "skip rows must stamp the resolved version's template when there is one");
  assert.match(source, /ORDER BY \(t\.id = cfg\.id\) DESC, t\.id/,
    "the sibling lookup must be deterministically ordered — never execution-plan luck");
  assert.match(source, /COALESCE\(t\.lineage_id, t\.id\) = COALESCE\(cfg\.lineage_id, cfg\.id\)/,
    "the sibling lookup must be lineage-scoped");
  assert.match(source, /AND v\.template_id = t\.id/,
    "the sibling lookup must fail closed on a corrupted published pointer");
  assert.ok(!/t\.category = cfg\.category/.test(source),
    "label-matching (category) must not be the sibling identity — that was the 1060 defect");
  ok("call sites: lineage-scoped ordered lookup; INSERTs stamp version.template_id");

  // ---- PIN 9: the engine must ACT on 'ambiguous' ----
  assert.match(source, /resolution\.outcome === "ambiguous"/,
    "the engine must branch on the ambiguous outcome");
  const ambiguousBlock = source.slice(source.indexOf('resolution.outcome === "ambiguous"'),
    source.indexOf('resolution.outcome === "ambiguous"') + 700);
  assert.match(ambiguousBlock, /markNeedsAttention/,
    "an ambiguous lineage is a configuration defect — the automation must be flagged");
  assert.match(ambiguousBlock, /template_resolution_ambiguous/);
  assert.match(ambiguousBlock, /candidateTemplateIds\.join/,
    "the skip must NAME the candidates (D112)");
  assert.match(source, /template_resolution_ambiguous: "/,
    "the skip reason must have a Hebrew label for the operator");
  assert.ok(!/\bconst version = await resolveVersion\(/.test(source),
    "no call site may treat the resolution object as a version row");
  ok("engine: ambiguous outcome flags the automation and writes named evidence");
} finally {
  await cleanup(sql);
  await db.sql.end({ timeout: 3 });
  await sql.end({ timeout: 3 });
}

console.log(`\nALL ${n} PASSED — resolve-version-lineage`);
