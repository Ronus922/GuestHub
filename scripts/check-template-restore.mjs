// check:template-restore — D207: restoring a version makes its content the
// CURRENT version immediately — a NEW immutable version (the restored one is
// never rewritten), with the row's mirror fields copied per channel. No draft
// step: what the restore names is what automations and the composer send next.
//
// D202 bug it still pins: restore set `body = v.subject`. A WhatsApp version
// stores subject '' (that channel has no subject), so every restored WhatsApp
// template got an EMPTY body and a '' subject.
//
// Runs the REAL compiled communications actions (save v1 → save v2 → restore
// v1) against a scratch database inside a rolled-back transaction, then proves
// the assertions fail on mutants. DB-backed: connects to TEST_DATABASE_URL
// (action-harness connect()) — the suite reads this file to decide it needs
// its own cloned database.
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-template-restore", [
  "src/app/(dashboard)/communications/actions.ts",
  "src/lib/communications/automation.ts",
]);
const ACTIONS = "app/(dashboard)/communications/actions.js";

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const [A, AU] = await Promise.all([load(ACTIONS), load("lib/communications/automation.js")]);
  await inRollback(sql, stub, async (tx) => {
    const { tenantId, userId } = await seedTenant(tx, stub, "restore");
    const row = async (id) => (await tx`
      SELECT m.body, m.subject, m.draft_content, m.lifecycle_state, m.current_published_version_id::text AS pub,
             v.content AS pub_content, v.subject AS pub_subject, v.published_by::text AS pub_by
      FROM guesthub.message_templates m
      LEFT JOIN guesthub.message_template_versions v ON v.id = m.current_published_version_id
      WHERE m.id = ${id}`)[0];
    const versions = async (id) => (await tx`
      SELECT id::text, content FROM guesthub.message_template_versions WHERE template_id = ${id} ORDER BY version_number`);
    const context = await AU.propertyOnlyContext(tenantId);

    // ---- WhatsApp ----
    const wa = (text) => ({ channel: "whatsapp", name: "תבנית וואטסאפ", category: "reservation", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text } });
    const waId = (await A.publishTemplateAction(wa("שלום, גרסה ראשונה"))).id;
    if (!waId) { fail.push("WhatsApp: the first שמירה failed"); return; }
    await A.publishTemplateAction({ ...wa("שלום, גרסה שנייה"), id: waId });
    const [waV1, waV2] = (await versions(waId)).map((v) => v.id);
    const v1Before = JSON.stringify((await versions(waId))[0]);
    const waRes = await A.restoreTemplateVersionAction(waV1);
    eq(waRes.success, true, "WhatsApp: the restore succeeds");
    eq(/שוחזר — זו התבנית הפעילה מעכשיו/.test(waRes.message ?? "") && !/טיוט/.test(waRes.message ?? ""), true,
      `WhatsApp: the message says it is live now, never "טיוטה" (got ${JSON.stringify(waRes.message)})`);
    const waAfter = await row(waId);
    const waAll = await versions(waId);
    eq(waAll.length, 3, "WhatsApp: the restore created exactly one NEW version");
    eq([waAfter.pub, waAfter.pub === waV1, waAfter.pub === waV2], [waAll[2].id, false, false],
      "WhatsApp: the new version is the current one (not v1 re-pointed, not v2 kept)");
    eq([waAfter.pub_content?.text, waAfter.lifecycle_state], ["שלום, גרסה ראשונה", "published"], "WhatsApp: the current content is v1's — live");
    eq(waAfter.pub_by, userId, "WhatsApp: the new version is recorded as the operator's");
    eq(JSON.stringify(waAll[0]), v1Before, "WhatsApp: v1 itself is unchanged (history is immutable)");
    eq(waAfter.draft_content?.text, "שלום, גרסה ראשונה", "WhatsApp: the row mirror is v1's — the editor reopens on what is live");
    eq(waAfter.body, "שלום, גרסה ראשונה", "WhatsApp: body is v1's TEXT (it was '' — body = v.subject)");
    eq(waAfter.subject, null, "WhatsApp: subject stays NULL — the channel has no subject");
    const composed = await AU.composePublishedTemplate({ tenantId, templateId: waId, channel: "whatsapp", guestLanguage: "he", context });
    eq([composed.status, composed.versionId === waAfter.pub, composed.text?.includes("גרסה ראשונה")], ["ready", true, true],
      "WhatsApp: the composer sends the restored content at once");

    // ---- Email (HTML kind) ----
    const em = (subject, html) => ({ channel: "email", name: "תבנית מייל", subject, category: "reservation", language: "he",
      content: { schemaVersion: 1, kind: "html", html } });
    const emId = (await A.publishTemplateAction(em("נושא ראשון", "<p>גוף ראשון</p>"))).id;
    if (!emId) { fail.push("email: the first שמירה failed"); return; }
    await A.publishTemplateAction({ ...em("נושא שני", "<p>גוף שני</p>"), id: emId });
    const [emV1] = (await versions(emId)).map((v) => v.id);
    eq((await A.restoreTemplateVersionAction(emV1)).success, true, "email: the restore succeeds");
    const emAfter = await row(emId);
    eq((await versions(emId)).length, 3, "email: exactly one new version");
    eq([emAfter.pub_subject, emAfter.pub_content?.html], ["נושא ראשון", "<p>גוף ראשון</p>"], "email: the current version is v1's subject + body");
    eq(emAfter.subject, "נושא ראשון", "email: subject mirror is v1's");
    eq(emAfter.body, "נושא ראשון", "email: body follows the save rule (legacyBodyFor: the subject)");
    eq(emAfter.draft_content?.html, "<p>גוף ראשון</p>", "email: the row mirror (the body) is v1's");

    // ---- an unknown version writes nothing ----
    const before = (await tx`SELECT COUNT(*)::int AS n FROM guesthub.message_template_versions WHERE tenant_id = ${tenantId}`)[0].n;
    const missing = await A.restoreTemplateVersionAction("00000000-0000-4000-8000-000000000000");
    eq([missing.success, (await tx`SELECT COUNT(*)::int AS n FROM guesthub.message_template_versions WHERE tenant_id = ${tenantId}`)[0].n],
      [false, before], "an unknown version is refused and writes nothing");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "body = v.subject (the D202 bug)",
    mutations: [[ACTIONS, "THEN COALESCE(NULLIF(v.content->>'text', ''), m.name)", "THEN v.subject"]] },
  { name: "WhatsApp subject copied from the version",
    mutations: [[ACTIONS, "subject = CASE WHEN m.channel = 'whatsapp' THEN NULL ELSE v.subject END", "subject = v.subject"]] },
  { name: "restore to draft only (the pre-D207 flow: content copied, nothing made current)",
    mutations: [[ACTIONS, "SET current_published_version_id = ${current.id}, lifecycle_state = 'published',",
      "SET lifecycle_state = lifecycle_state,"]] },
  { name: "restore re-points to the old version instead of a new one",
    mutations: [[ACTIONS, "SET current_published_version_id = ${current.id}, lifecycle_state = 'published',",
      "SET current_published_version_id = ${id}, lifecycle_state = 'published',"]] },
]);
await sql.end();
