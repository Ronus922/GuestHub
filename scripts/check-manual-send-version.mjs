// check:manual-send-version — D202: the booking composer's TEMPLATE mode sends
// the template's PUBLISHED version, exactly as an automation would, and records
// which version it sent. Owner decisions 03/10/2026:
//   1. the composer resolves the published version the automations' way
//      (resolveVersion: same lineage + guest-language rules, D117);
//   2. an unpublished template is not sendable — disabled in the panel AND
//      refused by the server;
//   3. template mode is read-only: the server ignores any client-sent body and
//      re-resolves; "העתק לכתיבה חופשית" (WhatsApp) turns the rendered text into
//      free text, sent with no template id and no version;
//   4. the outbound_messages row records template_id + template_version_id;
//   email: the published subject + HTML through the automation renderer.
//
// Before D202 the composer loaded message_templates.body — the DRAFT for
// WhatsApp, and for email the SUBJECT (legacyBodyFor), sent as the body.
//
// Runs the REAL compiled message-actions / communications actions / renderer /
// composer gate against a scratch database inside a rolled-back transaction;
// only the providers (a fake that records the wire), the actor, the audit
// writer and the canonical reservation load are stubbed. Every mutant below
// must turn it red. DB-backed: connects to TEST_DATABASE_URL (action-harness
// connect()) — the suite reads this file to decide it needs its own database.
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-manual-send-version", [
  "src/app/(dashboard)/reservations/message-actions.ts",
  "src/app/(dashboard)/communications/actions.ts",
  "src/lib/messaging/composer-draft.ts",
]);
const MSG = "app/(dashboard)/reservations/message-actions.js";
const COMM = "app/(dashboard)/communications/actions.js";
const DRAFT = "lib/messaging/composer-draft.js";

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const ok = (cond, message) => { if (!cond) fail.push(message); };
  const [M, C, D, AUTO, R] = await Promise.all([
    load(MSG), load(COMM), load(DRAFT),
    load("lib/communications/automation.js"), load("lib/communications/renderer.js"),
  ]);

  await inRollback(sql, stub, async (tx) => {
    const { tenantId } = await seedTenant(tx, stub, "manual-send");
    // fixture guest and booking — no real guest data (D201 rule)
    const [guest] = await tx`
      INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name, email, phone, language)
      VALUES (${tenantId}, 'דנה', 'בדיקה', 'דנה בדיקה', 'guest@example.com', '0501234567', 'he') RETURNING id`;
    const [res] = await tx`
      INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status, primary_guest_id)
      VALUES (${tenantId}, 'R-4112', '2026-07-03', '2026-07-06', 'confirmed', ${guest.id}) RETURNING id`;
    stub.setReservation({
      reservation_number: "R-4112", status: "confirmed", source_label: null,
      guest: { id: guest.id, first_name: "דנה", last_name: "בדיקה", email: "guest@example.com", phone: "0501234567" },
      rooms: [], total_price: 0, balance: 0,
    });

    // templates: saved (D207: שמירה = the current version), THEN a different
    // row mirror written underneath — no action writes one since D207, but the
    // composer must still read the VERSION, never the row's draft_content/body
    const wa = (text) => ({ channel: "whatsapp", name: "וואטסאפ מפורסם", category: "reservation", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text } });
    const mirror = (id, content, subject, body) => tx`
      UPDATE guesthub.message_templates SET draft_content = ${tx.json(content)}, subject = ${subject}, body = ${body} WHERE id = ${id}`;
    const waId = (await C.publishTemplateAction(wa("שלום {{guest.first_name}}, זו הגרסה המפורסמת"))).id;
    await mirror(waId, wa("טיוטה שלא פורסמה {{guest.first_name}}").content, null, "טיוטה שלא פורסמה");

    const em = (subject, html) => ({ channel: "email", name: "מייל מפורסם", subject, category: "reservation", language: "he",
      content: { schemaVersion: 1, kind: "html", html } });
    const emId = (await C.publishTemplateAction(em("אישור הזמנה {{reservation.number}}", "<p>שלום {{guest.first_name}}, המייל המפורסם</p>"))).id;
    await mirror(emId, em("נושא טיוטה", "<p>טיוטה שלא פורסמה</p>").content, "נושא טיוטה", "נושא טיוטה");

    // a never-saved template (as the 3 system ones are): no version at all
    const [{ id: unpubId }] = await tx`
      INSERT INTO guesthub.message_templates (tenant_id, channel, slug, name, body, category, language,
        lifecycle_state, draft_content, is_active, is_system)
      VALUES (${tenantId}, 'whatsapp', 'never_saved', 'לא פורסמה', 'רק טיוטה', 'reservation', 'he', 'draft',
        ${tx.json(wa("רק טיוטה").content)}, true, true) RETURNING id::text`;

    const pub = async (id) => (await tx`
      SELECT current_published_version_id::text AS id FROM guesthub.message_templates WHERE id = ${id}`)[0].id;
    const waVersion = await pub(waId);
    const emVersion = await pub(emId);

    // ---- 1. the composer load shows the PUBLISHED version, rendered ----
    const ctx = await M.getMessagingContextAction(res.id);
    eq(ctx.success, true, "the composer context loads");
    const waT = ctx.data?.templates.whatsapp.find((t) => t.id === waId);
    const emT = ctx.data?.templates.email.find((t) => t.id === emId);
    const unT = ctx.data?.templates.whatsapp.find((t) => t.id === unpubId);
    eq(waT?.status, "ready", "WhatsApp: the published template is ready");
    ok(waT?.text.includes("שלום דנה, זו הגרסה המפורסמת"), `WhatsApp: the composer shows the published text, rendered (got ${JSON.stringify(waT?.text)})`);
    ok(!waT?.text.includes("טיוטה"), "WhatsApp: the draft never reaches the composer");
    eq(emT?.subject, "אישור הזמנה R-4112", "email: the composer shows the published subject, rendered");
    ok(emT?.html?.includes("שלום דנה, המייל המפורסם"), "email: the composer shows the published HTML, rendered");
    ok(!emT?.html?.includes("טיוטה") && emT?.subject !== "נושא טיוטה", "email: the draft never reaches the composer");
    eq(unT?.status, "unpublished", "an unpublished template is listed as unpublished");
    eq(unT?.detail, "התבנית לא פעילה", "…with the hint the panel shows (D207: 'התבנית לא פעילה')");

    // the email HTML is the AUTOMATION renderer's output for this booking
    const send = await AUTO.reservationSendContext(tenantId, res.id);
    const [ver] = await tx`SELECT subject, content FROM guesthub.message_template_versions WHERE id = ${emVersion}`;
    const expected = R.renderTemplateContent(ver.content, send.context);
    eq(emT?.html, expected.html, "email: the preview HTML is byte-identical to renderTemplateContent of the published version");
    eq(emT?.text, expected.plainText, "email: the plain-text part is the renderer's, not the subject");

    // ---- 2. the real send gate (composer-draft) over that entry ----
    const gateFor = (t, isEmail) => D.manualSendGate({
      isEmail, providerConfigured: true, recipientValid: true, subjectBlocked: false, bodyBlocked: false,
      subject: t?.subject ?? "", renderedBody: t?.text ?? "",
      template: !t ? "none" : t.status === "ready" ? "ready" : t.status === "unpublished" ? "unpublished" : "blocked",
    });
    eq(gateFor(waT, false).canSend, true, "gate: a ready WhatsApp template can be sent");
    eq(gateFor(emT, true).canSend, true, "gate: a ready email template can be sent");
    eq(gateFor(unT, false).block, "template_unpublished", "gate: an unpublished template locks the button, named");

    // ---- 3. WhatsApp template send: client body ignored, version recorded ----
    stub.wire.length = 0;
    const waSend = await M.sendBookingWhatsAppAction(res.id, { templateId: waId, body: "גוף זדוני מהלקוח" });
    eq(waSend.data?.ok, true, "WhatsApp: the template send goes out");
    const waWire = stub.wire.find((w) => w.channel === "whatsapp");
    eq(waWire?.body, waT?.text, "WhatsApp: the wire carries exactly what the composer showed");
    ok(!waWire?.body?.includes("זדוני"), "WhatsApp: a client-sent body is ignored in template mode");
    const [waRow] = await tx`
      SELECT template_id::text, template_version_id::text, body FROM guesthub.outbound_messages
      WHERE tenant_id = ${tenantId} AND channel = 'whatsapp' AND template_id = ${waId}`;
    eq(waRow?.template_version_id, waVersion, "WhatsApp: the row records the published version sent");
    eq(waRow?.body, waT?.text, "WhatsApp: the row records the text sent");

    // ---- 4. email template send: published subject + HTML ----
    stub.wire.length = 0;
    const emSend = await M.sendBookingEmailAction(res.id, { templateId: emId, subject: "נושא מהלקוח", body: "גוף מהלקוח" });
    eq(emSend.data?.ok, true, "email: the template send goes out");
    const emWire = stub.wire.find((w) => w.channel === "email");
    eq(emWire?.subject, "אישור הזמנה R-4112", "email: the wire subject is the published one, rendered");
    eq(emWire?.html, expected.html, "email: the wire carries the automation renderer's HTML");
    eq(emWire?.body, expected.plainText, "email: the plain-text part is the rendered content — not the subject");
    ok(emWire?.body !== emWire?.subject, "email: the body is never the subject (legacyBodyFor)");
    const [emRow] = await tx`
      SELECT template_version_id::text, subject, rendered_html FROM guesthub.outbound_messages
      WHERE tenant_id = ${tenantId} AND channel = 'email' AND template_id = ${emId}`;
    eq(emRow?.template_version_id, emVersion, "email: the row records the published version sent");
    eq(emRow?.rendered_html, expected.html, "email: the row records the HTML sent");

    // ---- 5. an unpublished template is refused by the SERVER ----
    stub.wire.length = 0;
    const unSend = await M.sendBookingWhatsAppAction(res.id, { templateId: unpubId, body: "רק טיוטה" });
    eq(unSend.data?.ok, false, "server: an unpublished template is not sent");
    eq(unSend.data?.detail, "התבנית לא פעילה", "…and the refusal names why");
    eq(stub.wire.length, 0, "…nothing reached the provider");
    const [{ n: unRows }] = await tx`
      SELECT count(*)::int AS n FROM guesthub.outbound_messages WHERE tenant_id = ${tenantId} AND template_id = ${unpubId}`;
    eq(unRows, 0, "…and no row claims that template");

    // ---- 6. "העתק לכתיבה חופשית" → free text, no template ids ----
    stub.wire.length = 0;
    const copied = D.copyToFreeText({ mode: "template", templateId: waId, subject: "", body: "" }, waT?.text ?? "");
    eq(copied.mode, "custom", "copy: the draft switches to free text");
    eq(copied.body, waT?.text, "copy: with the rendered text, variables already resolved");
    const payload = D.sendPayload({ ...copied, body: `${copied.body}\nתוספת של המפעיל` });
    eq(payload.templateId, null, "copy: the free-text payload carries no template id");
    const freeSend = await M.sendBookingWhatsAppAction(res.id, { templateId: payload.templateId, body: payload.body });
    eq(freeSend.data?.ok, true, "copy: the edited free text goes out");
    ok(stub.wire[0]?.body?.endsWith("תוספת של המפעיל"), "copy: exactly the edited text is sent");
    const freeRows = await tx`
      SELECT template_id, template_version_id FROM guesthub.outbound_messages
      WHERE tenant_id = ${tenantId} AND channel = 'whatsapp' AND body LIKE ${"%תוספת של המפעיל"}`;
    eq(freeRows.map((r) => [r.template_id, r.template_version_id]), [[null, null]],
      "copy: the row records no template and no version");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "send-side legacyBodyFor draft body (the pre-D202 path)",
    mutations: [[MSG, "body: t.text,", "body: (await sql`SELECT body FROM guesthub.message_templates WHERE id = ${input.templateId}`)[0].body,"]] },
  { name: "composer renders the draft content instead of the published version",
    mutations: [["lib/communications/automation.js", "const content = parseTemplateContent(version.content);",
      "const content = parseTemplateContent((await sql`SELECT draft_content FROM guesthub.message_templates WHERE id = ${version.template_id}`)[0].draft_content);"]] },
  { name: "no template_version_id recorded",
    mutations: [["lib/messaging/service.js", "templateVersionId: params.templateVersionId,", "templateVersionId: null,"]] },
  { name: "email: subject as body, no HTML",
    mutations: [[MSG, "body: t.plainText, html: t.html,", "body: t.subject, html: null,"]] },
  { name: "template mode accepts the client body",
    mutations: [[MSG, "body: t.text,", "body: input.body || t.text,"]] },
  { name: "copy to free text keeps the template id",
    mutations: [[DRAFT, "return { templateId: null, subject: draft.subject, body: draft.body };",
      "return { templateId: draft.templateId || null, subject: draft.subject, body: draft.body };"]] },
  { name: "server allows an unpublished template",
    mutations: [[MSG, "{ refused: composed.detail }",
      "(composed.status === \"unpublished\" ? { ready: { status: \"ready\", channel, templateId, versionId: null, text: \"רק טיוטה\" } } : { refused: composed.detail })"]] },
]);
await sql.end();
