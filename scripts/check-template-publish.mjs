// check:template-publish — D205 B1: "פרסום" publishes the editor's CURRENT
// state, saved or not, in one atomic action; a refusal names the exact field
// and publishes nothing.
//
// The bug it pins (reported by the owner, root cause found 03/10/2026): a
// template that was never saved has no id, and publishTemplateAction's schema
// demanded one — so "פרסום" on it failed with the generic "יש שדות חסרים או לא
// תקינים" although nothing was missing; "שמירת טיוטה" (which creates the id)
// and then "פרסום" worked. Every schema failure also said only "שדות חסרים".
//
// Runs the REAL compiled communications actions against a scratch database
// inside a rolled-back transaction, then proves the assertions fail on mutants
// that bring the bug back. DB-backed: connects to TEST_DATABASE_URL
// (action-harness connect()) — the suite reads this file to decide it needs its
// own cloned database.
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-template-publish", ["src/app/(dashboard)/communications/actions.ts"]);
const ACTIONS = "app/(dashboard)/communications/actions.js";

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const A = await load(ACTIONS);
  await inRollback(sql, stub, async (tx) => {
    const { tenantId } = await seedTenant(tx, stub, "publish");
    const counts = async () => (await tx`
      SELECT (SELECT COUNT(*)::int FROM guesthub.message_templates WHERE tenant_id = ${tenantId}) AS templates,
             (SELECT COUNT(*)::int FROM guesthub.message_template_versions WHERE tenant_id = ${tenantId}) AS versions`)[0];
    const state = async (id) => (await tx`
      SELECT m.lifecycle_state, m.draft_content, v.content AS published, v.subject AS published_subject,
             (SELECT COUNT(*)::int FROM guesthub.message_template_versions x WHERE x.template_id = m.id) AS versions
      FROM guesthub.message_templates m
      LEFT JOIN guesthub.message_template_versions v ON v.id = m.current_published_version_id
      WHERE m.id = ${id}`)[0];
    const wa = (text, extra = {}) => ({ channel: "whatsapp", name: "הוראות הגעה", category: "pre_arrival", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text }, ...extra });
    const em = (subject, html, extra = {}) => ({ channel: "email", name: "אישור הזמנה", subject, category: "reservation",
      language: "he", content: { schemaVersion: 1, kind: "html", html }, ...extra });

    // 1. the owner's repro: a template that was never saved → פרסום
    const fresh = await A.publishTemplateAction(wa("שלום {{guest.first_name}}, מחכים לכם"));
    eq(fresh.success, true, "publish of a never-saved WhatsApp template succeeds (it failed: 'יש שדות חסרים')");
    if (fresh.success) {
      const s = await state(fresh.id);
      eq([s.lifecycle_state, s.versions], ["published", 1], "…it is created AND published, with exactly one version");
      eq(s.published?.text, "שלום {{guest.first_name}}, מחכים לכם", "…the published version is the editor's text");
      eq(s.draft_content?.text, s.published?.text, "…and the draft equals what was published");
    }
    const freshEmail = await A.publishTemplateAction(em("ההזמנה אושרה", "<p>שלום</p>"));
    eq(freshEmail.success, true, "publish of a never-saved email template succeeds");
    if (freshEmail.success) eq((await state(freshEmail.id)).published_subject, "ההזמנה אושרה", "…with the editor's subject");

    // 2. an existing template with UNSAVED changes → the editor state is saved and published, atomically
    const saved = await A.saveTemplateDraftAction(wa("טקסט שמור"));
    const edited = await A.publishTemplateAction(wa("טקסט שלא נשמר", { id: saved.id }));
    eq(edited.success, true, "publish with unsaved changes succeeds");
    const e = await state(saved.id);
    eq([e.published?.text, e.draft_content?.text], ["טקסט שלא נשמר", "טקסט שלא נשמר"],
      "the unsaved editor state is what is published, and it is the saved draft too");

    // 3. a refusal names the field (Hebrew) and publishes / creates nothing
    const before = await counts();
    const shortName = await A.publishTemplateAction(wa("טקסט", { name: "א" }));
    eq([shortName.success, shortName.field], [false, "name"], "a 1-letter name is refused on the name field");
    eq(/שם התבנית/.test(shortName.error ?? ""), true, `…and the message names it in Hebrew (got ${JSON.stringify(shortName.error)})`);
    const badReply = await A.publishTemplateAction(em("נושא תקין", "<p>x</p>", { replyTo: "לא-כתובת" }));
    eq([badReply.success, badReply.field], [false, "replyTo"], "an invalid Reply-To is refused on its field");
    eq(/Reply-To/.test(badReply.error ?? ""), true, "…and the message names it");
    const noSubject = await A.publishTemplateAction(em("", "<p>x</p>"));
    eq([noSubject.success, noSubject.field], [false, "subject"], "an email without a subject is refused on the subject field");
    const empty = await A.publishTemplateAction(wa("   "));
    eq([empty.success, empty.field], [false, "content"], "an empty WhatsApp message is refused on the content field");
    for (const r of [shortName, badReply, noSubject, empty]) {
      eq(/שדות חסרים/.test(r.error ?? ""), false, `no refusal says the generic "שדות חסרים" (got ${JSON.stringify(r.error)})`);
    }
    const draftBad = await A.saveTemplateDraftAction(wa("טקסט", { name: "" }));
    eq([draftBad.success, draftBad.field], [false, "name"], "the draft save names the field too");
    eq(await counts(), before, "a refused publish creates no template and no version");
    const after = await state(saved.id);
    eq(after.versions, 1, "a refused publish of an existing template adds no version");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "publish demands an id (the original bug)",
    mutations: [[ACTIONS, "const publishInputSchema = templateInputSchema;",
      "const publishInputSchema = z.discriminatedUnion(\"channel\", [emailTemplateInputSchema.extend({ id: z.string().uuid() }), whatsappTemplateInputSchema.extend({ id: z.string().uuid() })]);"]] },
  { name: "publish skips the editor state (publishes only what was saved)",
    mutations: [[ACTIONS, "await writeTemplateDraft(tx, actor, input, id);", ""]] },
  { name: "schema refusal is generic again",
    mutations: [[ACTIONS, "return error instanceof z.ZodError ? templateFieldError(error) : fail(error);", "return fail(error);"]] },
]);
await sql.end();
