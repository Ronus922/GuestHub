#!/usr/bin/env node
// ============================================================
// check:manual-send-render — the booking composer's MANUAL send renders the
// email subject AND the body of both channels (email, WhatsApp) through the
// communications renderer (D172 + addendum 2026-09-05).
//
// Evidence that motivated it: outbound_messages 6518a028 (2026-09-04 20:46Z)
// went to Gmail with the literal subject
//   "אישור הזמנה {{reservation.number}} · {{property.name}}"
// because message-actions.ts rendered the subject with the legacy
// renderTemplate, whose regex never matches a dotted key. The body had the
// same gap: 2 of the 4 live WhatsApp templates carry {{group.key}} tokens.
//
// Part A (static): both send actions and the composer preview use
//   renderManualText for subject AND body, and the legacy body/subject render
//   calls are gone; a blocked body refuses the send like a blocked subject.
// Part B (runtime, no DB): the REAL compiled renderManualText
//   1-6. the subject scenarios from D172 (dotted, unknown, legacy, mixed, D115);
//   7-8. the two live WhatsApp bodies that carry dotted keys (fixtures copied
//        verbatim from message_templates) render with every token resolved
//        and every newline intact;
//   9.   a body with an unknown dotted key is blanked AND blocked, named;
//   10.  a body with a known-but-missing optional value renders empty, allowed;
//   11.  the live legacy email body still renders through the legacy pass.
// Part C (runtime, no DB — D179): the REAL compiled manualSendGate, fed the
//   REAL renderManualText verdicts. This closes the loop the guard only ever
//   claimed: an unresolvable variable is not merely *detected* by the renderer,
//   it actually LOCKS the send button and names its own reason in Hebrew.
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "./lib/collect-assert.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const src = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ---- Part A: static wiring ----
const actions = src("src/app/(dashboard)/reservations/message-actions.ts");
assert.equal((actions.match(/renderManualText\(/g) ?? []).length, 3,
  "three manual renders: email subject, email body, WhatsApp body");
assert.ok(!/renderTemplate\(/.test(actions),
  "the legacy renderTemplate renders nothing in message-actions any more (its regex ignores dotted keys)");
assert.ok(/reservationRenderContext|safeRenderContext/.test(actions), "the send builds the reservation's communications render context");
assert.ok(/renderedSubject\.canSend/.test(actions), "a blocked subject refuses the send instead of shipping a token");
assert.equal((actions.match(/renderedBody\.canSend/g) ?? []).length, 2,
  "a blocked body refuses the send in BOTH channels instead of shipping a token");
const composer = src("src/components/reservations/BookingActions.tsx");
assert.equal((composer.match(/renderManualText\(/g) ?? []).length, 2, "the composer previews subject and body with the same renderer as the send");
// D178 moved the composer's send lock out of an inline `!subjectBlocked &&
// !bodyBlocked` and into the ONE gate in lib/messaging/composer-draft.ts, so
// this now follows the real path across both files: the composer must FEED
// both flags to that gate, and the gate must lock on each of them. That is
// stronger than the old grep for a bare negation, which a dead
// `const x = !subjectBlocked` would also have satisfied.
assert.ok(/manualSendGate\(\{[\s\S]*?subjectBlocked,[\s\S]*?\}\)/.test(composer),
  "the composer feeds subjectBlocked into the send gate");
assert.ok(/manualSendGate\(\{[\s\S]*?bodyBlocked,[\s\S]*?\}\)/.test(composer),
  "the composer feeds bodyBlocked into the send gate");
assert.ok(/canSend = gate\.canSend/.test(composer),
  "…and the send button is driven by that gate's verdict");
const gate = src("src/lib/messaging/composer-draft.ts");
// D179: the gate's own two locks used to be asserted here as source text. A
// grep cannot tell a live branch from a dead one — `if (input) return null;`
// at the top of the IIFE left every character of those two lines in place and
// this guard stayed green (measured 07/09/2026). Part C RUNS the gate instead.
const automation = src("src/lib/communications/automation.ts");
assert.ok(/export async function reservationRenderContext\(/.test(automation), "automation.ts exports the per-reservation render context");
const module_ = src("src/lib/messaging/render-manual.ts");
assert.ok(/renderTemplateString\(/.test(module_) && /renderTemplate\(/.test(module_), "renderManualText chains the legacy pass and the communications renderer");
console.log("✓ Part A: wiring is in place");

// ---- Part B: compile the real module (tsc → CJS) and exercise it ----
console.log("compiling render-manual.ts via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-manual-subject-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/lib/messaging/render-manual.ts"),
            join(ROOT, "src/lib/messaging/composer-draft.ts")],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });
const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  try {
    return origResolve.call(this, request, ...rest);
  } catch (e) {
    // bare specifiers (zod, …) live in the PROJECT's node_modules, not under /tmp
    if (!request.startsWith(".") && !request.startsWith("/")) return req.resolve(request);
    throw e;
  }
};
const { renderManualText: renderManualSubject, renderManualText } = req(join(out, "lib/messaging/render-manual.js"));

const context = {
  bookingOrigin: "direct",
  values: {
    "reservation.number": "1159",
    "property.name": "מגדל הים",
    "guest.first_name": "בוריס",
    "room.floor": null, // known key, no value → D115: empty, not blocking
  },
};
const legacyVars = { booking_number: "1159", property_name: "מגדל הים" };

// 1. the exact subject that shipped raw on 2026-09-04
const r1 = renderManualSubject("אישור הזמנה {{reservation.number}} · {{property.name}}", legacyVars, context);
assert.equal(r1.value, "אישור הזמנה 1159 · מגדל הים", "dotted keys resolve to the reservation's values");
assert.equal(r1.canSend, true, "a fully resolved subject is sendable");
assert.equal(r1.detail, null, "no blocking detail on a clean subject");

// 2. unknown dotted key: blanked AND blocked, named
const r2 = renderManualSubject("שלום {{guest.first_name}}, {{foo.bar}} ממתין", legacyVars, context);
assert.ok(!r2.value.includes("{{") && !r2.value.includes("}}"), "an unknown token never survives literally in the subject");
assert.equal(r2.canSend, false, "an unknown variable blocks the send");
assert.ok(r2.issues.some((i) => i.kind === "unknown_variable" && i.key === "foo.bar"), "the issue names the unknown variable");
assert.ok(typeof r2.detail === "string" && r2.detail.includes("foo.bar"), "the Hebrew detail line names the variable (D112)");
assert.ok(r2.value.includes("בוריס"), "known keys in the same subject still resolve");

// 3. legacy grammar keeps working (1 of 2 live email subjects uses it)
const r3 = renderManualSubject("הזמנה {{booking_number}} — {{property_name}}", legacyVars, context);
assert.equal(r3.value, "הזמנה 1159 — מגדל הים", "legacy {{snake_case}} keys still resolve");
assert.equal(r3.canSend, true, "legacy keys never block");

// 4. mixed grammars in one subject
const r4 = renderManualSubject("{{booking_number}} · {{property.name}}", legacyVars, context);
assert.equal(r4.value, "1159 · מגדל הים", "legacy and dotted keys resolve side by side");

// 5. D115: known key without a value renders empty and does not block
const r5 = renderManualSubject("קומה {{room.floor}} · {{reservation.number}}", legacyVars, context);
assert.equal(r5.value, "קומה  · 1159", "a missing optional value renders empty");
assert.equal(r5.canSend, true, "a missing optional value does not block");

// 6. legacy unknown key is blanked by the legacy pass (pre-existing behaviour, pinned)
const r6 = renderManualSubject("{{no_such_key}} {{reservation.number}}", legacyVars, context);
assert.equal(r6.value, " 1159", "an unknown legacy key renders empty (existing behaviour)");
assert.equal(r6.canSend, true, "an unknown legacy key does not block (existing behaviour)");

// ---- body scenarios (addendum 2026-09-05) ----
// A context with every key the two live dotted WhatsApp templates use.
const bodyContext = {
  bookingOrigin: "direct",
  values: {
    ...context.values,
    "guest.full_name": "בוריס כהן",
    "guest.phone": "+972525460546",
    "reservation.source": "Booking.com",
    "stay.arrival_date": "12/09/2026",
    "stay.departure_date": "14/09/2026",
    "stay.nights": 2,
    "stay.check_in_time": "15:00",
    "stay.check_out_time": "11:00",
    "stay.guests": "2 מבוגרים",
    "room.number": "1318",
    "payment.total": "₪1,200",
    "property.address": "רחוב הים 1, נתניה",
  },
};

// 7. "הודעה לעצמי על הזמנה" — live WhatsApp template (custom_0b398a2b), body verbatim
const waSelf = "התקבלה הזמנה חדשה מאת {{guest.full_name}}\n הזמנה מספר: {{reservation.number}}\n שם המזמין:  {{guest.full_name}}\nטלפון: {{guest.phone}} \nמקור ההזמנה: {{reservation.source}} \nתאריך הגעה: {{stay.arrival_date}}\nתאריך עזיבה: {{stay.departure_date}}\nצ'ק אין מבוקש: {{stay.check_in_time}} \nהרכב נפשות: {{stay.guests}} \nמספר חדר: {{room.number}} \n סה\"כ לתשלום: {{payment.total}}";
const r7 = renderManualText(waSelf, legacyVars, bodyContext);
assert.equal(r7.canSend, true, "the live 'הודעה לעצמי' body is sendable with a full context");
assert.ok(!r7.value.includes("{{"), "no token survives in the 'הודעה לעצמי' body");
for (const v of ["בוריס כהן", "1159", "+972525460546", "Booking.com", "12/09/2026", "14/09/2026", "15:00", "2 מבוגרים", "1318", "₪1,200"]) {
  assert.ok(r7.value.includes(v), `'הודעה לעצמי' body carries ${v}`);
}
assert.equal(r7.value.split("\n").length, waSelf.split("\n").length, "every newline of the 'הודעה לעצמי' body survives");

// 8. "וואטצאפ אישור הזמנה" — live WhatsApp template (custom_eea8d676), body verbatim
const waConfirm = "שלום {{guest.first_name}},\nתודה שבחרת להתארח אצלנו.\nשמחים לעדכן שהזמנתך התקבלה בהצלחה, ואנחנו כבר מצפים לארח אותך.\nפרטי ההזמנה:\nתאריך הגעה: {{stay.arrival_date}}\nתאריך עזיבה: {{stay.departure_date}}\nמספר לילות: {{stay.nights}}\nמספר אורחים: {{stay.guests}}\nצ'ק-אין: החל מהשעה {{stay.check_in_time}}\nצ'ק-אאוט: עד השעה {{stay.check_out_time}}\nבברכה,\nצוות {{property.name}}\n{{property.address}}";
const r8 = renderManualText(waConfirm, legacyVars, bodyContext);
assert.equal(r8.canSend, true, "the live 'וואטצאפ אישור הזמנה' body is sendable with a full context");
assert.ok(!r8.value.includes("{{"), "no token survives in the 'וואטצאפ אישור הזמנה' body");
for (const v of ["שלום בוריס,", "12/09/2026", "14/09/2026", "מספר לילות: 2", "2 מבוגרים", "15:00", "11:00", "צוות מגדל הים", "רחוב הים 1, נתניה"]) {
  assert.ok(r8.value.includes(v), `'וואטצאפ אישור הזמנה' body carries ${v}`);
}
assert.equal(r8.value.split("\n").length, waConfirm.split("\n").length, "every newline of the 'וואטצאפ אישור הזמנה' body survives");

// 9. unknown dotted key in a body: blanked AND blocked, named in Hebrew
const r9 = renderManualText("שלום {{guest.first_name}},\nהחדר שלך: {{room.wifi_password}}\nלהתראות", legacyVars, bodyContext);
assert.equal(r9.canSend, false, "an unknown variable in the body blocks the send");
assert.ok(!r9.value.includes("{{") && !r9.value.includes("}}"), "an unknown token never survives literally in the body");
assert.ok(typeof r9.detail === "string" && r9.detail.includes("room.wifi_password") && /משתנה לא מוכר/.test(r9.detail),
  "the Hebrew detail line names the unknown body variable");
assert.ok(r9.value.includes("בוריס"), "known keys in the same body still resolve");

// 10. D115 in a body: known key without a value renders empty, send allowed
const r10 = renderManualText("קומה {{room.floor}}\nחדר {{room.number}}", legacyVars, bodyContext);
assert.equal(r10.value, "קומה \nחדר 1318", "a missing optional value renders empty inside a body");
assert.equal(r10.canSend, true, "a missing optional value in a body does not block");

// 11. the live legacy email body (booking_confirmation) still renders through the legacy pass
const emailLegacy = "שלום {{guest_first_name}},\nמספר הזמנה: {{booking_number}}\nנשמח לארח אתכם!\n{{property_name}}";
const r11 = renderManualText(emailLegacy, { ...legacyVars, guest_first_name: "בוריס" }, bodyContext);
assert.equal(r11.value, "שלום בוריס,\nמספר הזמנה: 1159\nנשמח לארח אתכם!\nמגדל הים", "legacy {{snake_case}} body keys resolve and newlines survive");
assert.equal(r11.canSend, true, "a legacy body never blocks");

console.log("✓ Part B: 11 runtime scenarios passed on the compiled renderer (6 subject + 5 body)");

// ---- Part C: render → verdict → gate → locked button, all executed (D179) ----
// Parts A and B stopped one hop short. The renderer said canSend:false, and the
// claim "a guest never receives a raw token" rested on a grep proving the gate
// still contained two lines of source. Below, the gate is COMPILED AND CALLED
// with the renderer's own output, so the guard proves the chain it advertises.
const { manualSendGate, sendBlockMessage } = req(join(out, "lib/messaging/composer-draft.js"));

/**
 * The composer's own wiring, reproduced from BookingActions.tsx:197-213.
 * The `isEmail &&` on the subject is not a shortcut — it is the component's:
 * WhatsApp renders no subject at all, so `subjectRender` is null there and
 * `subjectBlocked` is false whatever the subject string happens to hold.
 */
const gateFor = (subjectText, bodyText, isEmail = true) => {
  const rs = isEmail ? renderManualText(subjectText, legacyVars, bodyContext) : null;
  const rb = renderManualText(bodyText, legacyVars, bodyContext);
  return {
    render: { subject: rs, body: rb },
    ...manualSendGate({
      isEmail, providerConfigured: true, recipientValid: true,
      subjectBlocked: rs !== null && !rs.canSend, bodyBlocked: !rb.canSend,
      subject: subjectText, renderedBody: rb.value,
    }),
  };
};

// C1 — a clean template must not be locked by the chain itself
const c1 = gateFor("אישור הזמנה {{reservation.number}}", "שלום {{guest.first_name}}");
assert.equal(c1.canSend, true, "C1: a fully resolved subject and body leave the send button live");
assert.equal(c1.block, null, "C1: …and the footer states no reason");

// C2 — the 2026-09-04 failure mode, end to end: unknown dotted key in the BODY
const c2 = gateFor("אישור הזמנה {{reservation.number}}", "הסיסמה היא {{room.wifi_password}}");
assert.equal(c2.render.body.canSend, false, "C2: the renderer refuses the unknown dotted key");
assert.equal(c2.canSend, false, "C2: …and the SEND BUTTON is actually locked, not merely the render");
assert.equal(c2.block, "body_blocked", "C2: …under the reason the footer will print");
assert.match(sendBlockMessage(c2.block, true), /משתנה שלא ניתן לשלוח/, "C2: …and that sentence exists in Hebrew");
assert.ok(!c2.render.body.value.includes("{{"), "C2: …while the token never survives literally either way");

// C3 — the same, one field over: the subject
const c3 = gateFor("אישור {{foo.bar}}", "שלום {{guest.first_name}}");
assert.equal(c3.canSend, false, "C3: an unresolvable SUBJECT variable locks the send too");
assert.equal(c3.block, "subject_blocked", "C3: …and the subject is named as the reason, not the body");

// C4 — order: the upstream cause wins, so the operator is never sent chasing the wrong field
const c4 = gateFor("אישור {{foo.bar}}", "הסיסמה היא {{room.wifi_password}}");
assert.equal(c4.block, "subject_blocked", "C4: with BOTH fields blocked the subject is stated first");

// C5 — the legacy hole has a floor. An unknown {{snake_case}} key is blanked
// silently and never blocks (Part B scenario 6), but a body made only of such
// tokens renders to nothing, and emptiness is its own lock.
const c5 = gateFor("אישור הזמנה {{reservation.number}}", "{{totally_unknown}}");
assert.equal(c5.render.body.canSend, true, "C5: an unknown legacy key still does not block the RENDER");
assert.equal(c5.canSend, false, "C5: …but a body that renders to nothing cannot be sent");
assert.equal(c5.block, "body_empty", "C5: …and the reason is emptiness, not a variable");

// C6 — WhatsApp shows no subject field, so leftover subject text (blocked or
// not) must never lock a WhatsApp send. The email case above proves the same
// string DOES lock email, so this is a real asymmetry and not a vacuous pass.
const c6 = gateFor("אישור {{foo.bar}}", "שלום {{guest.first_name}}", false);
assert.equal(c3.block, "subject_blocked", "C6: the identical subject locks EMAIL…");
assert.equal(c6.canSend, true, "C6: …and leaves WhatsApp live, because WhatsApp has no subject to fix");
assert.equal(c6.block, null, "C6: …with no reason printed in the footer");

console.log("✓ Part C: 6 runtime scenarios passed on the compiled send gate (D179)");
console.log("check:manual-send-render — PASS");
