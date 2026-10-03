// check:template-restore — D202: restoring a published version copies the
// right fields per channel INTO THE DRAFT, and never publishes.
//
// The bug it pins: restoreTemplateVersionAction set `body = v.subject`. A
// WhatsApp version stores subject '' (that channel has no subject), so every
// restored WhatsApp template got an EMPTY body and a '' subject — reproduced on
// a scratch database 03/10/2026 (never used in production: 0 restores).
//
// Runs the REAL compiled communications actions (save → publish v1 → publish
// v2 → restore v1) against a scratch database inside a rolled-back
// transaction, then proves the assertions fail on mutants that bring the bug
// back. DB-backed: connects to TEST_DATABASE_URL (action-harness connect()) —
// the suite reads this file to decide it needs its own cloned database.
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-template-restore", ["src/app/(dashboard)/communications/actions.ts"]);
const ACTIONS = "app/(dashboard)/communications/actions.js";

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const A = await load(ACTIONS);
  await inRollback(sql, stub, async (tx) => {
    await seedTenant(tx, stub, "restore");
    const row = async (id) => (await tx`
      SELECT body, subject, draft_content, lifecycle_state, current_published_version_id::text AS pub
      FROM guesthub.message_templates WHERE id = ${id}`)[0];
    const versionIds = async (id) => (await tx`
      SELECT id::text FROM guesthub.message_template_versions WHERE template_id = ${id} ORDER BY version_number`).map((r) => r.id);

    // ---- WhatsApp ----
    const wa = (text) => ({ channel: "whatsapp", name: "תבנית וואטסאפ", category: "reservation", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text } });
    const waId = (await A.saveTemplateDraftAction(wa("שלום, גרסה ראשונה"))).id;
    await A.publishTemplateAction({ ...wa("שלום, גרסה ראשונה"), id: waId });
    await A.publishTemplateAction({ ...wa("שלום, גרסה שנייה"), id: waId });
    const [waV1, waV2] = await versionIds(waId);
    const waRes = await A.restoreTemplateVersionAction(waV1);
    eq(waRes.success, true, "WhatsApp: the restore succeeds");
    const waAfter = await row(waId);
    eq(waAfter.draft_content?.text, "שלום, גרסה ראשונה", "WhatsApp: the draft content is v1's");
    eq(waAfter.body, "שלום, גרסה ראשונה", "WhatsApp: body is v1's TEXT (it was '' — body = v.subject)");
    eq(waAfter.subject, null, "WhatsApp: subject stays NULL — the channel has no subject");
    eq(waAfter.pub, waV2, "WhatsApp: the published version is still v2 — restore never publishes");
    eq(waAfter.lifecycle_state, "published", "WhatsApp: the lifecycle is untouched");
    eq((await versionIds(waId)).length, 2, "WhatsApp: no version was created");

    // ---- Email (HTML kind) ----
    const em = (subject, html) => ({ channel: "email", name: "תבנית מייל", subject, category: "reservation", language: "he",
      content: { schemaVersion: 1, kind: "html", html } });
    const emId = (await A.saveTemplateDraftAction(em("נושא ראשון", "<p>גוף ראשון</p>"))).id;
    await A.publishTemplateAction({ ...em("נושא ראשון", "<p>גוף ראשון</p>"), id: emId });
    await A.publishTemplateAction({ ...em("נושא שני", "<p>גוף שני</p>"), id: emId });
    const [emV1, emV2] = await versionIds(emId);
    eq((await A.restoreTemplateVersionAction(emV1)).success, true, "email: the restore succeeds");
    const emAfter = await row(emId);
    eq(emAfter.subject, "נושא ראשון", "email: subject is v1's");
    eq(emAfter.body, "נושא ראשון", "email: body follows the save rule (legacyBodyFor: the subject)");
    eq(emAfter.draft_content?.html, "<p>גוף ראשון</p>", "email: the draft content (the body) is v1's");
    eq(emAfter.pub, emV2, "email: the published version is still v2 — restore never publishes");
    eq((await versionIds(emId)).length, 2, "email: no version was created");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "body = v.subject (the original bug)",
    mutations: [[ACTIONS, "THEN COALESCE(NULLIF(v.content->>'text', ''), m.name)", "THEN v.subject"]] },
  { name: "WhatsApp subject copied from the version",
    mutations: [[ACTIONS, "subject = CASE WHEN m.channel = 'whatsapp' THEN NULL ELSE v.subject END", "subject = v.subject"]] },
  { name: "restore also publishes",
    mutations: [[ACTIONS, "draft_content = v.content,\n", "draft_content = v.content, current_published_version_id = v.id,\n"]] },
]);
await sql.end();
