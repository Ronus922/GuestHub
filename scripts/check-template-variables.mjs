// check:template-variables — D205 B2/B3/B4/B5/B7.
//   - {{property.waze_url}} ("ניווט ב-Waze") = https://waze.com/ul?ll=<lat>,<lng>&navigate=yes,
//     coordinates rounded to 6 decimals; {{property.website_url}} ("כתובת האתר")
//     from the business profile; both missing → the standard D115 behaviour.
//   - they resolve IDENTICALLY in the automation engine (the outbound row it
//     writes), the manual send (composePublishedTemplate) and the editor
//     preview (preview datasets and the property-only fallback).
//   - the variables sidebar lists every key exactly once (B4).
//   - the version history and the empty state show no version number (B5).
//
// Runs the REAL compiled code; the database part on a scratch database inside
// a rolled-back transaction. Every mutant below must turn it red. DB-backed:
// connects to TEST_DATABASE_URL (action-harness connect()) — the suite reads
// this file to decide it needs its own cloned database.
import { readdirSync, readFileSync } from "node:fs";
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-template-variables", [
  "src/app/(dashboard)/communications/actions.ts",
  "src/lib/communications/automation.ts",
  "src/components/communications/editorShared.tsx",
]);
const VARS = "lib/communications/variables.js";
const AUTO = "lib/communications/automation.js";
const PLACE = "lib/business/google-place.js";

// B5, static: no user-visible "v<number>" / "גרסה <number>" label in the
// communications UI (the runtime render below covers the shared history list).
const staticFail = [];
const UI_FILES = readdirSync("src/components/communications").filter((f) => f.endsWith(".tsx"))
  .map((f) => `src/components/communications/${f}`).concat(["src/app/(dashboard)/communications/actions.ts"]);
const VERSION_LABEL = /`v\$\{|>v\{|\(v\$\{|גרסה \$\{|גרסה \{|v1 ·|את v1/;
for (const file of UI_FILES) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (VERSION_LABEL.test(line) && !/^\s*(\/\/|\*|\{\/\*)/.test(line)) staticFail.push(`${file}:${i + 1} shows a version number: ${line.trim()}`);
  });
}
if (staticFail.length) {
  for (const f of staticFail) console.log(`✗ ${f}`);
  process.exit(1);
}
console.log(`✓ static: no version-number label in ${UI_FILES.length} communications UI files`);

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const [V, AU, P, C, UI] = await Promise.all([
    load(VARS), load(AUTO), load(PLACE),
    load("app/(dashboard)/communications/actions.js"), load("components/communications/editorShared.js"),
  ]);

  // ---- catalog + link builder ----
  const def = (key) => V.COMMUNICATION_VARIABLES.find((v) => v.key === key);
  eq([def("property.waze_url")?.label, def("property.waze_url")?.kind], ["ניווט ב-Waze", "url"], "{{property.waze_url}} is in the catalog");
  eq([def("property.website_url")?.label, def("property.website_url")?.kind], ["כתובת האתר", "url"], "{{property.website_url}} is in the catalog");
  eq(def("property.map_url")?.label, "קישור ניווט", "{{property.map_url}} is unchanged");
  eq(P.wazeNavigationLink(32.08534712345678, 34.78180645123456),
    "https://waze.com/ul?ll=32.085347,34.781806&navigate=yes", "Waze link: coordinates rounded to 6 decimals");
  eq(P.wazeNavigationLink(-33.1, 151.0000004), "https://waze.com/ul?ll=-33.1,151&navigate=yes", "Waze link: no padding, rounding is numeric");
  eq([P.wazeNavigationLink(null, 34.7), P.wazeNavigationLink(32.1, undefined)], [null, null], "Waze link: null without both coordinates");

  // ---- B4: the sidebar lists every key exactly once ----
  const palette = renderToStaticMarkup(h(UI.VariablePalette, { search: "", canEdit: true, onInsert: () => {} }))
    .replace(/<wbr\/?>/g, "");
  const counts = V.COMMUNICATION_VARIABLES.map((v) => [v.key, palette.split(`{{${v.key}}}`).length - 1]);
  eq(counts.filter(([, n]) => n !== 1), [], "every variable appears exactly once in the sidebar");
  eq(new Set(V.COMMUNICATION_VARIABLES.map((v) => v.key)).size, V.COMMUNICATION_VARIABLES.length, "the catalog has no duplicate key");

  // ---- B5: the history names a version by date and publisher, never by number ----
  const history = renderToStaticMarkup(h(UI.VersionHistoryList, { canEdit: true, pending: false, onRestore: () => {},
    versions: [{ id: "a", version: 7, publishedAt: "2026-10-01T10:00:00Z", publishedBy: "צוות" },
               { id: "b", version: 1, publishedAt: "2026-09-01T07:00:00Z", publishedBy: null }] }));
  eq([/\bv7\b|\bv1\b/.test(history), history.includes("01.10.2026"), history.includes("צוות"), history.includes("גרסה ראשונית")],
    [false, true, true, true], "the version history shows date + publisher and no version number");
  const none = renderToStaticMarkup(h(UI.VersionHistoryList, { canEdit: true, pending: false, onRestore: () => {}, versions: [] }));
  eq(/v1|v\d/.test(none), false, `the empty history mentions no version number (got ${JSON.stringify(none)})`);

  // ---- B2/B3/B7: identical resolution across engine, manual send and preview ----
  await inRollback(sql, stub, async (tx) => {
    const { tenantId } = await seedTenant(tx, stub, "variables");
    const profile = { latitude: 32.08534712345678, longitude: 34.78180645123456, website: "https://hotel.example.com" };
    await tx`UPDATE guesthub.tenants SET settings = ${tx.json({ messaging: { whatsappProvider: "green_api" }, business_profile: profile })}
             WHERE id = ${tenantId}`;
    await tx`INSERT INTO guesthub.messaging_provider_connections (tenant_id, provider, status, last_tested_at, secret_ciphertext)
             VALUES (${tenantId}, 'green_api', 'connected', now(), 'fixture')`;
    // fixture guest and booking — no real guest data (D201 rule)
    const [guest] = await tx`
      INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name, phone, language)
      VALUES (${tenantId}, 'דנה', 'בדיקה', 'דנה בדיקה', '0501234567', 'he') RETURNING id`;
    const [res] = await tx`
      INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status, primary_guest_id)
      VALUES (${tenantId}, 'R-7007', '2027-01-10', '2027-01-12', 'confirmed', ${guest.id}) RETURNING id`;
    const WAZE = "https://waze.com/ul?ll=32.085347,34.781806&navigate=yes";
    const SITE = "https://hotel.example.com";
    const pick = (ctx) => [ctx?.values["property.waze_url"], ctx?.values["property.website_url"]];

    const send = await AU.reservationSendContext(tenantId, res.id);
    eq(pick(send?.context), [WAZE, SITE], "manual send / engine context (buildRenderContext) resolves both");
    const datasets = await AU.loadPreviewDatasets(tenantId);
    eq(pick(datasets.find((d) => d.id === res.id)?.context), [WAZE, SITE], "editor preview dataset resolves both");
    eq(pick(await AU.propertyOnlyContext(tenantId)), [WAZE, SITE], "editor property-only preview resolves both");

    const wa = { channel: "whatsapp", name: "ניווט", category: "pre_arrival", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text: "ניווט: {{property.waze_url}} · אתר: {{property.website_url}}" } };
    const templateId = (await C.publishTemplateAction(wa)).id;
    const manual = await AU.composePublishedTemplate({ tenantId, templateId, channel: "whatsapp", guestLanguage: "he", context: send.context });
    eq(manual.status, "ready", "the manual send composes the template");
    const manualText = manual.text ?? "";
    eq([manualText.includes(WAZE), manualText.includes(SITE)], [true, true], "the manual send's wire text carries both links");

    const saved = await C.saveAutomationAction({ name: "אישור עם ניווט", triggerType: "reservation.confirmed", channel: "whatsapp",
      templateId, sources: ["back_office", "direct_website"], activate: false, recipient: { guest: true, owner: null } });
    eq(saved.success, true, `the automation saves (${saved.error ?? ""})`);
    await tx`UPDATE guesthub.communication_automations SET status = 'active' WHERE id = ${saved.id}`;
    const [event] = await tx`
      INSERT INTO guesthub.communication_events (tenant_id, event_type, aggregate_type, reservation_id, source,
                                                 occurrence_key, payload, occurred_at)
      VALUES (${tenantId}, 'reservation.confirmed', 'reservation', ${res.id}, 'back_office',
              ${`reservation:${res.id}:confirmed`}, ${tx.json({})}, now()) RETURNING *`;
    await AU.prepareDeliveriesForEvent(event);
    const [row] = await tx`SELECT body, status, error_code FROM guesthub.outbound_messages WHERE event_id = ${event.id}`;
    eq(row?.body === manualText, true,
      `the automation engine writes the same text as the manual send\n      engine ${JSON.stringify(row)}\n      manual ${JSON.stringify(manualText)}`);

    // missing coordinates / website → the standard D115 behaviour (an empty optional value)
    await tx`UPDATE guesthub.tenants SET settings = ${tx.json({ business_profile: {} })} WHERE id = ${tenantId}`;
    const bare = await AU.reservationSendContext(tenantId, res.id);
    eq(pick(bare?.context).map((v) => v ?? null), [null, null], "without coordinates / website both are missing values");
    eq(V.resolveVariable("property.waze_url", bare.context).issue?.kind, "missing_optional", "…which D115 renders empty (the send proceeds)");
    eq(V.resolveVariable("property.waze_url", bare.context, { required: true }).issue?.kind, "missing_required", "…and {{property.waze_url!}} skips");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "a key listed twice in the sidebar",
    mutations: [[VARS, '{ key: "payment.paid", label: "שולם", group: "payment", kind: "money" },',
      '{ key: "payment.paid", label: "שולם", group: "payment", kind: "money" }, { key: "payment.paid", label: "שולם", group: "payment", kind: "money" },']] },
  { name: "Waze coordinates not rounded",
    mutations: [[PLACE, "String(Math.round(n * 1e6) / 1e6)", "String(n)"]] },
  { name: "the preview fallback misses the new variables (a second, drifting builder)",
    mutations: [[AUTO, "values: propertyValues(profile),", "values: { \"property.name\": profile?.publicPropertyName },"]] },
  { name: "the version history shows the number again",
    mutations: [["components/communications/editorShared.js", '"גרסה ראשונית"', '`v${version.version}`']] },
]);
await sql.end();
