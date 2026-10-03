// check:template-publish — D207 (owner decision 03/10/2026): a template has ONE
// save action, "שמירה". It validates, writes the editor's state as a NEW
// immutable version and makes it the current one, in one transaction — valid
// content is live at once (automations, the manual composer, the preview).
// Invalid content writes nothing, and the refusal names the field in Hebrew.
// There is no draft step and no "טיוטה" anywhere in the template UI.
//
// History: D205 B1 pinned that "פרסום" published the editor's CURRENT state,
// saved or not (a never-saved template failed with "יש שדות חסרים"). D207 makes
// that path the only writer — "שמירת טיוטה" (saveTemplateDraftAction) is gone.
//
// Runs the REAL compiled communications actions, automation engine and editor
// chrome against a scratch database inside a rolled-back transaction, then
// proves the assertions fail on mutants that bring a draft step back.
// DB-backed: connects to TEST_DATABASE_URL (action-harness connect()) — the
// suite reads this file to decide it needs its own cloned database.
import { readFileSync } from "node:fs";
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-template-publish", [
  "src/app/(dashboard)/communications/actions.ts",
  "src/lib/communications/automation.ts",
  "src/components/communications/editorShared.tsx",
]);
const ACTIONS = "app/(dashboard)/communications/actions.js";
const SHARED = "components/communications/editorShared.js";

// ---- static: every editor has the ONE save action, wired to the toast, and no draft ----
const EDITORS = ["TemplateEditor", "HtmlTemplateEditor", "WhatsAppTemplateEditor"];
const SAVE_CALL = "run(() => publishTemplateAction(payload), (result) => announceTemplateSaved(result, template ? undefined : onClose))";
function wiringFailures(name, src) {
  const fail = [];
  if (!src.includes("onDone?.(result);")) fail.push(`${name}: run() does not pass its result to onDone`);
  if (src.split("<TemplateSaveControls").length !== 2) fail.push(`${name}: not exactly one <TemplateSaveControls>`);
  if (src.split(SAVE_CALL).length !== 2) fail.push(`${name}: שמירה does not save through publishTemplateAction + announceTemplateSaved`);
  if (/saveTemplateDraftAction|שמירת טיוטה/.test(src)) fail.push(`${name}: a draft save is still wired`);
  if (!src.includes("liveAutomations={template?.activeAutomations ?? []}")) fail.push(`${name}: the live-automation note is not fed`);
  return fail;
}
// "טיוטה" may appear in the communications UI only as an AUTOMATION status —
// these lines, verbatim; any other occurrence (a template label, badge, filter
// or hint) is the concept coming back
const AUTOMATION_DRAFT_LINES = [
  'draft: "טיוטה", archived: "בארכיון",',
  '{activate ? "שמירה והפעלה" : "שמירה כטיוטה"}',
  ': "תישמר כטיוטה ולא תישלח עד שתופעל."}',
];
function draftWordFailures(file, src) {
  return src.split("\n").map((line, i) => [line.trim(), i + 1])
    .filter(([line]) => /טיוט/.test(line) && !/^(\/\/|\*|\{\/\*)/.test(line) && !AUTOMATION_DRAFT_LINES.includes(line))
    .map(([line, n]) => `${file}:${n} shows "טיוטה" in the template UI: ${line}`);
}
const UI_FILES = [...EDITORS.map((n) => `src/components/communications/${n}.tsx`),
  "src/components/communications/editorShared.tsx", "src/components/communications/CommunicationsShell.tsx",
  "src/components/reservations/BookingActions.tsx", "src/lib/messaging/composer-draft.ts"];
const staticFail = [
  ...EDITORS.flatMap((name) => wiringFailures(name, readFileSync(`src/components/communications/${name}.tsx`, "utf8"))),
  ...UI_FILES.flatMap((file) => draftWordFailures(file, readFileSync(file, "utf8"))),
];
const wa = readFileSync("src/components/communications/WhatsAppTemplateEditor.tsx", "utf8");
const vacuity = [
  wiringFailures("mutant", wa.replace(SAVE_CALL, "run(() => publishTemplateAction(payload))")).length > 0,
  wiringFailures("mutant", wa.replace("{canTest && (", "{canEdit && <button onClick={() => run(() => saveTemplateDraftAction(payload))}>שמירת טיוטה</button>}\n          {canTest && (")).length > 0,
  draftWordFailures("mutant", '<span className="chip">טיוטה</span>').length > 0,
];
if (staticFail.length || vacuity.includes(false)) {
  for (const f of staticFail) console.log(`✗ ${f}`);
  if (vacuity.includes(false)) console.log(`✗ a static check is vacuous (${JSON.stringify(vacuity)})`);
  process.exit(1);
}
console.log(`✓ static: ${EDITORS.length} editors have one שמירה (toast + live-automation note), no draft save; no "טיוטה" in ${UI_FILES.length} template UI files (vacuity proven)`);

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const [A, AU, UI] = await Promise.all([load(ACTIONS), load("lib/communications/automation.js"), load(SHARED)]);
  eq(typeof A.saveTemplateDraftAction, "undefined", "there is no draft-save action");

  // ---- the editor chrome, rendered: one שמירה, the live note, the states ----
  const controls = (live) => renderToStaticMarkup(h(UI.TemplateSaveControls,
    { blocker: null, disabled: false, pending: false, liveAutomations: live, onSave: () => {} }));
  const two = controls(["אישור הזמנה", "תזכורת"]);
  eq([/>\s*שמירה\s*</.test(two.replace(/<span class="ms-icon[^<]*<\/span>/g, "")), two.includes("השינוי ייכנס מיד לאוטומציה: אישור הזמנה, תזכורת")],
    [true, true], `שמירה + the note naming the active automations (got ${two})`);
  eq(controls([]).includes("השינוי ייכנס"), false, "no active automation → no note");
  eq(["published", "archived", "draft"].map((s) => UI.templateStateLabel(s)),
    ["פעילה", "בארכיון", "לא פעילה — שמירה תפעיל אותה"], "template states: פעילה / בארכיון / לא פעילה");
  const history = renderToStaticMarkup(h(UI.VersionHistoryList, { canEdit: true, pending: false, onRestore: () => {},
    versions: [{ id: "a", version: 2, publishedAt: "2026-10-01T10:00:00Z", publishedBy: "צוות" }] }))
    + renderToStaticMarkup(h(UI.VersionHistoryList, { canEdit: true, pending: false, onRestore: () => {}, versions: [] }))
    + renderToStaticMarkup(h(UI.RestoreVersionDialog, { version: { id: "a", version: 2, publishedAt: "2026-10-01T10:00:00Z", publishedBy: null },
      pending: false, onCancel: () => {}, onConfirm: () => {} }));
  eq(/טיוט/.test(history), false, `the history and the restore dialog never say "טיוטה" (got ${history})`);
  eq(history.includes("התבנית הפעילה מיד"), true, "the restore dialog says the content goes live at once");

  await inRollback(sql, stub, async (tx) => {
    const { tenantId } = await seedTenant(tx, stub, "save");
    await tx`UPDATE guesthub.tenants SET settings = ${tx.json({ messaging: { whatsappProvider: "green_api" } })} WHERE id = ${tenantId}`;
    await tx`INSERT INTO guesthub.messaging_provider_connections (tenant_id, provider, status, last_tested_at, secret_ciphertext)
             VALUES (${tenantId}, 'green_api', 'connected', now(), 'fixture')`;
    const counts = async () => (await tx`
      SELECT (SELECT COUNT(*)::int FROM guesthub.message_templates WHERE tenant_id = ${tenantId}) AS templates,
             (SELECT COUNT(*)::int FROM guesthub.message_template_versions WHERE tenant_id = ${tenantId}) AS versions,
             (SELECT md5(string_agg(m::text, ',' ORDER BY id)) FROM guesthub.message_templates m WHERE tenant_id = ${tenantId}) AS rows`)[0];
    const state = async (id) => (await tx`
      SELECT m.lifecycle_state, m.draft_content, v.id::text AS current, v.content AS published, v.subject AS published_subject,
             (SELECT COUNT(*)::int FROM guesthub.message_template_versions x WHERE x.template_id = m.id) AS versions,
             (SELECT x.id::text FROM guesthub.message_template_versions x WHERE x.template_id = m.id ORDER BY x.version_number DESC LIMIT 1) AS newest
      FROM guesthub.message_templates m
      LEFT JOIN guesthub.message_template_versions v ON v.id = m.current_published_version_id
      WHERE m.id = ${id}`)[0];
    const wa = (text, extra = {}) => ({ channel: "whatsapp", name: "הוראות הגעה", category: "pre_arrival", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text }, ...extra });
    const em = (subject, html, extra = {}) => ({ channel: "email", name: "אישור הזמנה", subject, category: "reservation",
      language: "he", content: { schemaVersion: 1, kind: "html", html }, ...extra });

    // 1. a NEW template: שמירה creates it with exactly one version, and that version is current
    const fresh = await A.publishTemplateAction(wa("שלום {{guest.first_name}}, מחכים לכם"));
    eq([fresh.success, fresh.message], [true, "התבנית נשמרה"], "שמירה of a new template succeeds: 'התבנית נשמרה'");
    if (!fresh.success) return;
    let s = await state(fresh.id);
    eq([s.lifecycle_state, s.versions, s.current === s.newest], ["published", 1, true], "…one version, and it is the current one (live)");
    eq(s.published?.text, "שלום {{guest.first_name}}, מחכים לכם", "…the current version is the editor's text");
    const freshEmail = await A.publishTemplateAction(em("ההזמנה אושרה", "<p>שלום</p>"));
    eq(freshEmail.success, true, "שמירה of a new email template succeeds");
    if (!freshEmail.success) return;
    eq((await state(freshEmail.id)).published_subject, "ההזמנה אושרה", "…with the editor's subject");

    // 2. an EXISTING template: each שמירה adds exactly one version, the new one is current
    const edited = await A.publishTemplateAction(wa("טקסט חדש {{guest.first_name}}", { id: fresh.id }));
    s = await state(fresh.id);
    eq([edited.success, s.versions, s.current === s.newest, s.published?.text, s.draft_content?.text],
      [true, 2, true, "טקסט חדש {{guest.first_name}}", "טקסט חדש {{guest.first_name}}"],
      "an edit + שמירה: exactly one new version, current, and the row mirrors it");

    // 3. …and it is live at once: the manual composer and the automation engine resolve the NEW version
    const context = await AU.propertyOnlyContext(tenantId);
    const composed = await AU.composePublishedTemplate({ tenantId, templateId: fresh.id, channel: "whatsapp", guestLanguage: "he",
      context: { ...context, values: { ...context.values, "guest.first_name": "דנה" } } });
    eq([composed.status, composed.versionId === s.current, composed.text?.includes("טקסט חדש דנה")], ["ready", true, true],
      `the manual composer sends the just-saved version (got ${JSON.stringify(composed)})`);
    const [guest] = await tx`
      INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name, phone, language)
      VALUES (${tenantId}, 'דנה', 'בדיקה', 'דנה בדיקה', '0501234567', 'he') RETURNING id`;
    const [res] = await tx`
      INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status, primary_guest_id)
      VALUES (${tenantId}, 'R-2071', '2027-01-10', '2027-01-12', 'confirmed', ${guest.id}) RETURNING id`;
    const auto = await A.saveAutomationAction({ name: "אישור", triggerType: "reservation.confirmed", channel: "whatsapp",
      templateId: fresh.id, sources: ["back_office", "direct_website"], activate: false, recipient: { guest: true, owner: null } });
    await tx`UPDATE guesthub.communication_automations SET status = 'active' WHERE id = ${auto.id}`;
    const [event] = await tx`
      INSERT INTO guesthub.communication_events (tenant_id, event_type, aggregate_type, reservation_id, source,
                                                 occurrence_key, payload, occurred_at)
      VALUES (${tenantId}, 'reservation.confirmed', 'reservation', ${res.id}, 'back_office',
              ${`reservation:${res.id}:confirmed`}, ${tx.json({})}, now()) RETURNING *`;
    await AU.prepareDeliveriesForEvent(event);
    const [row] = await tx`SELECT template_version_id::text AS v, body FROM guesthub.outbound_messages WHERE event_id = ${event.id}`;
    eq([row?.v === s.current, row?.body?.includes("טקסט חדש דנה")], [true, true],
      `the automation engine sends the just-saved version (got ${JSON.stringify(row)})`);

    // 4. invalid content: NOTHING is written, and the refusal names the field (Hebrew)
    const before = await counts();
    const refusals = [
      [await A.publishTemplateAction(wa("שלום {{guest.nickname}}", { id: fresh.id })), "content", /תוכן התבנית: המשתנה \{\{guest\.nickname\}\} אינו מוכר/],
      [await A.publishTemplateAction(em("הזמנה {{reservation.nmber}}", "<p>x</p>", { id: freshEmail.id })), "subject", /נושא האימייל: המשתנה/],
      [await A.publishTemplateAction(em("נושא תקין", "<p>x</p>", { id: freshEmail.id, preheader: "{{stay.nightz}}" })), "preheader", /טקסט מקדים: המשתנה/],
      [await A.publishTemplateAction(em("נושא תקין", "<p>{{room.nam}}</p>", { id: freshEmail.id })), "content", /תוכן התבנית: המשתנה/],
      [await A.publishTemplateAction(wa("טקסט", { name: "א" })), "name", /שם התבנית/],
      [await A.publishTemplateAction(em("נושא תקין", "<p>x</p>", { replyTo: "לא-כתובת" })), "replyTo", /Reply-To/],
      [await A.publishTemplateAction(em("", "<p>x</p>")), "subject", /נושא האימייל/],
      [await A.publishTemplateAction(wa("   ", { id: fresh.id })), "content", /תוכן התבנית/],
    ];
    for (const [r, field, text] of refusals) {
      eq([r.success, r.field, text.test(r.error ?? ""), /שדות חסרים/.test(r.error ?? "")], [false, field, true, false],
        `refused on "${field}" with a Hebrew message naming it (got ${JSON.stringify(r)})`);
    }
    eq(await counts(), before, "a refused שמירה writes nothing: no template, no version, no row change");

    // 5. the never-saved system templates stay NOT live until the first שמירה
    const [sys] = await tx`
      INSERT INTO guesthub.message_templates (tenant_id, channel, slug, name, body, category, language,
        lifecycle_state, draft_content, is_active, is_system)
      VALUES (${tenantId}, 'whatsapp', 'sys_wa', 'מערכת', 'x', 'reservation', 'he', 'draft',
        ${tx.json({ schemaVersion: 1, kind: "whatsapp_text", text: "שלום" })}, true, true) RETURNING id`;
    const sysCompose = await AU.composePublishedTemplate({ tenantId, templateId: sys.id, channel: "whatsapp", guestLanguage: "he", context });
    eq([sysCompose.status, sysCompose.detail], ["unpublished", "התבנית לא פעילה"], "a never-saved template is not sendable: 'התבנית לא פעילה'");
    await A.publishTemplateAction(wa("שלום", { id: sys.id, name: "מערכת" }));
    s = await state(sys.id);
    eq([s.lifecycle_state, s.versions, s.current === s.newest], ["published", 1, true], "…its first שמירה makes it live");

    // the toast, on the action's REAL results
    const announce = (result, isNew) => {
      stub.toasts.length = 0; let closed = 0;
      UI.announceTemplateSaved(result, isNew ? () => { closed += 1; } : undefined);
      return [stub.toasts.map((t) => `${t.type}:${t.message}`), closed];
    };
    eq(announce(fresh, true), [["success:התבנית נשמרה"], 1], "שמירה of a NEW template: the toast, then the editor closes");
    eq(announce(edited, false), [["success:התבנית נשמרה"], 0], "שמירה of an existing template: the toast, the editor stays");
    eq(announce(refusals[0][0], true), [[], 0], "a refusal shows no toast and keeps the editor open");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "save without publishing (a draft step: the version is written but not made current)",
    mutations: [[ACTIONS, "SET current_published_version_id = ${published.id}, lifecycle_state = 'published',",
      "SET lifecycle_state = lifecycle_state,"]] },
  { name: "save writes no version at all (the old שמירת טיוטה)",
    mutations: [[ACTIONS, "await writeTemplateDraft(tx, actor, input, id);\n            const [locked]", "await writeTemplateDraft(tx, actor, input, id);\n            return;\n            const [locked]"]] },
  { name: "partial write on invalid (the editor state is stored before the gate refuses)",
    mutations: [[ACTIONS, "const blocker = saveBlocker(input);",
      "const blocker = saveBlocker(input);\n        if (blocker) await sql.begin((tx) => writeTemplateDraft(tx, actor, input, input.id ?? randomUUID()));"]] },
  { name: "an unknown variable is saved (no variable gate)",
    mutations: [[ACTIONS, "if (unknown)\n            return", "if (false)\n            return"]] },
  { name: "the publish path demands an id (the D205 bug)",
    mutations: [[ACTIONS, "const publishInputSchema = templateInputSchema;",
      "const publishInputSchema = z.discriminatedUnion(\"channel\", [emailTemplateInputSchema.extend({ id: z.string().uuid() }), whatsappTemplateInputSchema.extend({ id: z.string().uuid() })]);"]] },
  { name: "no toast after שמירה",
    mutations: [[SHARED, 'toast.success(result.message ?? "נשמר");', ""]] },
  { name: "a refusal also toasts success",
    mutations: [[SHARED, "if (!result.success)\n        return;", ""]] },
  { name: "the template state says טיוטה again",
    mutations: [[SHARED, 'return "לא פעילה — שמירה תפעיל אותה";', 'return "טיוטה";']] },
  { name: "no live-automation note",
    mutations: [[SHARED, "liveAutomations.length > 0 &&", "false &&"]] },
]);
await sql.end();
