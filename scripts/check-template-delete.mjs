// check:template-delete — D205 B6: deleting a message template (owner decision
// 03/10/2026).
//   a. referenced by an automation (active or inactive) → refused, naming it;
//   b. never sent → HARD delete: the template and its versions are gone;
//   c. sent → SOFT delete: gone from the list, the composer and the automation
//      picker, while its versions — and so the history of what was sent — stay;
//   d. a system (seeded) template follows the same rules: nothing re-seeds it.
// One audit entry per delete, naming the mode.
//
// Runs the REAL compiled actions and loaders against a scratch database inside
// a rolled-back transaction, then proves the assertions fail on mutants that
// bring each defect back. DB-backed: connects to TEST_DATABASE_URL
// (action-harness connect()) — the suite reads this file to decide it needs its
// own cloned database.
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-template-delete", [
  "src/app/(dashboard)/communications/actions.ts",
  "src/app/(dashboard)/communications/data.ts",
  "src/app/(dashboard)/reservations/message-actions.ts",
]);
const ACTIONS = "app/(dashboard)/communications/actions.js";
const DATA = "app/(dashboard)/communications/data.js";
const MSG = "app/(dashboard)/reservations/message-actions.js";

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const [A, D, M] = await Promise.all([load(ACTIONS), load(DATA), load(MSG)]);
  stub.audits.length = 0;
  // a mutant may make PostgreSQL itself refuse (the outbound FK on a version is
  // the second line of defence) — an exception is a failed scenario, not a crash
  try { await inRollback(sql, stub, async (tx) => {
    const { tenantId } = await seedTenant(tx, stub, "tpl-delete");
    // fixture guest and booking — no real guest data (D201 rule)
    const [guest] = await tx`
      INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name, email, phone, language)
      VALUES (${tenantId}, 'דנה', 'בדיקה', 'דנה בדיקה', 'guest@example.com', '0501234567', 'he') RETURNING id`;
    const [res] = await tx`
      INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status, primary_guest_id)
      VALUES (${tenantId}, 'R-5005', '2026-07-03', '2026-07-06', 'confirmed', ${guest.id}) RETURNING id`;
    stub.setReservation({
      reservation_number: "R-5005", status: "confirmed", source_label: null,
      guest: { id: guest.id, first_name: "דנה", last_name: "בדיקה", email: "guest@example.com", phone: "0501234567" },
      rooms: [], total_price: 0, balance: 0,
    });
    const wa = (name, text) => ({ channel: "whatsapp", name, category: "reservation", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text } });
    const publish = async (name, text) => (await A.publishTemplateAction(wa(name, text))).id;
    const versions = async (id) => (await tx`
      SELECT COUNT(*)::int AS n FROM guesthub.message_template_versions WHERE template_id = ${id}`)[0].n;
    const row = async (id) => (await tx`
      SELECT deleted_at IS NOT NULL AS deleted, is_active, lifecycle_state FROM guesthub.message_templates WHERE id = ${id}`)[0] ?? null;

    const inUse = await publish("בשימוש באוטומציה", "שלום");
    await tx`INSERT INTO guesthub.communication_automations (tenant_id, name, status, trigger_type, channel, template_id)
             VALUES (${tenantId}, 'אישור הזמנה בוואטסאפ', 'disabled', 'reservation.confirmed', 'whatsapp', ${inUse})`;
    const unsent = await publish("לא נשלחה", "שלום");
    await A.publishTemplateAction({ ...wa("לא נשלחה", "שלום שוב"), id: unsent });
    const sent = await publish("נשלחה", "שלום {{guest.first_name}}, נשלח");
    const [sentVersion] = await tx`SELECT current_published_version_id AS id FROM guesthub.message_templates WHERE id = ${sent}`;
    await tx`
      INSERT INTO guesthub.outbound_messages
        (tenant_id, reservation_id, channel, provider, template_id, template_version_id,
         idempotency_key, to_address, body, rendered_plain_text, status, delivery_type)
      VALUES (${tenantId}, ${res.id}, 'whatsapp', 'green_api', ${sent}, ${sentVersion.id},
              ${`guard:${sent}`}, '+972500000000', 'שלום דנה, נשלח', 'שלום דנה, נשלח', 'sent', 'normal')`;
    const system = await publish("תבנית מערכת", "שלום");
    await tx`UPDATE guesthub.message_templates SET is_system = true WHERE id = ${system}`;

    // a. an automation (disabled, not active) holds it → refused, named, nothing changed
    const refused = await A.deleteTemplateAction(inUse);
    eq(refused.success, false, "a template an automation uses is refused");
    eq(refused.automations?.map((a) => a.name), ["אישור הזמנה בוואטסאפ"], "…naming the automation");
    eq(/אישור הזמנה בוואטסאפ/.test(refused.error ?? ""), true, "…in the Hebrew message too");
    eq([await row(inUse), await versions(inUse)], [{ deleted: false, is_active: true, lifecycle_state: "published" }, 1],
      "…and the template is untouched");

    // b. never sent → hard delete: template and both versions gone
    const hard = await A.deleteTemplateAction(unsent);
    eq([hard.success, hard.mode], [true, "hard"], "a never-sent template is hard-deleted");
    eq([await row(unsent), await versions(unsent)], [null, 0], "…the row and all its versions are gone");

    // c. sent → soft delete: out of service, versions and history intact
    const soft = await A.deleteTemplateAction(sent);
    eq([soft.success, soft.mode], [true, "soft"], "a sent template is soft-deleted, never hard-deleted");
    eq(await row(sent), { deleted: true, is_active: false, lifecycle_state: "archived" }, "…marked deleted and out of service");
    eq(await versions(sent), 1, "…its version stays");
    const data = await D.loadCommunicationsData(tenantId, { templates: true, automations: true, channels: false });
    const historyPage = await D.loadDeliveryPage(tenantId, { from: null, to: null, statuses: [], page: 1 });
    const listed = data.templates.map((t) => t.id);
    eq([listed.includes(sent), listed.includes(unsent)], [false, false], "deleted templates are gone from the list, the archive and the automation picker");
    eq(listed.includes(inUse), true, "…the refused one is still listed");
    const history = historyPage.rows.find((d) => d.renderedPlainText === "שלום דנה, נשלח");
    eq([history?.templateName, history?.templateVersionId], ["נשלחה", sentVersion.id],
      "the history row of the sent message still shows its template and version");
    const ctx = await M.getMessagingContextAction(res.id);
    eq(ctx.success, true, "the composer loads");
    const composer = (ctx.data?.templates.whatsapp ?? []).map((t) => t.id);
    eq([composer.includes(sent), composer.includes(unsent), composer.includes(inUse)], [false, false, true],
      "deleted templates are gone from the composer");
    const pick = await A.saveAutomationAction({
      name: "בחירה בתבנית שנמחקה", triggerType: "reservation.confirmed", channel: "whatsapp", templateId: sent,
      sources: ["back_office"], recipient: { guest: true, owner: null }, activate: false,
    });
    eq([pick.success, pick.error], [false, "התבנית שנבחרה אינה זמינה לערוץ הזה"], "an automation cannot be saved with a deleted template");
    const control = await A.saveAutomationAction({
      name: "בחירה בתבנית חיה", triggerType: "reservation.confirmed", channel: "whatsapp", templateId: inUse,
      sources: ["back_office"], recipient: { guest: true, owner: null }, activate: false,
    });
    eq(control.success, true, "…while the same save with a live template succeeds (the refusal is the deletion)");
    eq((await A.deleteTemplateAction(sent)).success, false, "a deleted template cannot be deleted twice");

    // d. a system (seeded) template, never sent → the same rules: hard delete
    const sys = await A.deleteTemplateAction(system);
    eq([sys.success, sys.mode, await row(system)], [true, "hard", null], "a never-sent system template is hard-deleted like any other");

    eq(stub.audits.filter((a) => a.action === "template_deleted").map((a) => [a.after.name, a.after.mode]),
      [["לא נשלחה", "hard"], ["נשלחה", "soft"], ["תבנית מערכת", "hard"]], "one audit entry per delete, naming the mode");
  }); } catch (error) { fail.push(`the scenario threw: ${error.message}`); }
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "an in-use template is deleted",
    mutations: [[ACTIONS, "if (automations.length > 0) {", "if (false) {"]] },
  { name: "a sent template is hard-deleted",
    mutations: [[ACTIONS, "holds.sent || holds.held ?", "holds.held ?"]] },
  { name: "a soft-deleted template stays in the composer",
    mutations: [[ACTIONS, "SET deleted_at = now(), is_active = false, lifecycle_state = 'archived',", "SET deleted_at = now(),"],
      [ACTIONS, "archived_at = COALESCE(archived_at, now()), updated_by", "updated_by"]] },
  { name: "the list still shows deleted templates",
    mutations: [[DATA, "AND m.deleted_at IS NULL", ""]] },
]);
await sql.end();
