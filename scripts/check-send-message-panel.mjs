#!/usr/bin/env node
// ============================================================
// check:send-message-panel — the guest message drawer
// ("שליחת מייל לאורח", approved design + owner rulings 2026-09-07, D178).
//
// The four owner rulings this guard freezes:
//   1. the composer STAYS an overlay inside the booking drawer (D53) — no
//      second SidePanel, no width of its own;
//   2. BOTH channels wear the design (email and WhatsApp);
//   3. the preview is TRUTHFUL TO THE WIRE — a known variable with no value
//      renders empty, exactly as it will be sent; the reference's "—" filler is
//      NOT implemented, and an unresolvable variable still blocks by name (D172);
//   4. all 16 canonical variables are offered as chips.
// Plus the two places the SYSTEM overrode the reference: the §7 header chrome
// and the system toast.
//
// Runtime where it can be: src/lib/messaging/composer-draft.ts is compiled
// ALONE with tsc and CALLED, so the caret maths and every send-lock reason are
// proven by running them. Static where it cannot (a React drawer needs a
// browser): the drawer wires that module, the partial is imported, the icons
// exist in the vendored font, and no orphan CSS was left behind.
//
// No DB, no network, no build. D127 collect-all: every failure is reported,
// then the guard fails once. Usage: node scripts/check-send-message-panel.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

// ---- compile the real pure module (no imports, so one file is the whole program) ----
const out = mkdtempSync(join(tmpdir(), "gh-sendmsg-"));
execSync(
  `pnpm exec tsc src/lib/messaging/composer-draft.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck --strict`,
  { cwd: ROOT, stdio: "inherit" },
);
const req = createRequire(join(ROOT, "package.json"));
const m = req(join(out, "composer-draft.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CSS = read("src/app/styles/send-message-panel.css");
const BASE = read("src/app/styles/base.css");
const TSX = read("src/components/reservations/BookingActions.tsx");
const CODE = stripComments(TSX);
const REFERENCE = "שליחת מייל לאורח.dc.html";

// ============================================================
// 1. inserting a variable lands the caret AFTER the token, and replaces a selection
// ============================================================
{
  const r = m.insertToken("שלום , ברוך הבא", 5, 5, "{{guest_first_name}}");
  assert.equal(r.text, "שלום {{guest_first_name}}, ברוך הבא", "a collapsed caret inserts in place");
  assert.equal(r.caret, 5 + "{{guest_first_name}}".length, "the caret lands just after the token");
  assert.equal(r.text.slice(0, r.caret).endsWith("}}"), true, "…so the next keystroke types after it, never inside");

  const sel = m.insertToken("שלום XXXX סוף", 5, 9, "{{nights}}");
  assert.equal(sel.text, "שלום {{nights}} סוף", "a real selection is REPLACED, like typing would");
  assert.equal(sel.caret, 5 + "{{nights}}".length, "and the caret follows the inserted token");

  // a textarea that was never focused reports no selection; the composer passes
  // body.length, and out-of-range indices must never corrupt the draft
  const end = m.insertToken("abc", 99, 99, "{{x}}");
  assert.equal(end.text, "abc{{x}}", "an out-of-range caret appends instead of throwing");
  const rev = m.insertToken("abcdef", 4, 2, "{{x}}");
  assert.equal(rev.text, "ab{{x}}ef", "a backwards selection is normalised, not mis-sliced");
  ok("clicking a variable chip inserts at the caret and leaves the caret after the token");
}

// ============================================================
// 2. the send gate — every lock, in the order the footer must state them
// ============================================================
{
  const base = {
    isEmail: true, providerConfigured: true, recipientValid: true,
    subjectBlocked: false, bodyBlocked: false, subject: "שלום", renderedBody: "תוכן",
  };
  assert.equal(m.manualSendGate(base).canSend, true, "a complete email is sendable");
  assert.equal(m.manualSendGate(base).block, null, "…with no stated reason");

  const cases = [
    [{ recipientValid: false }, "recipient", "no valid email locks the send"],
    [{ providerConfigured: false }, "provider", "an unconfigured provider locks the send"],
    [{ subjectBlocked: true }, "subject_blocked", "an unresolvable subject variable locks the send (D172)"],
    [{ bodyBlocked: true }, "body_blocked", "an unresolvable body variable locks the send (D172)"],
    [{ subject: "   " }, "subject_empty", "an empty subject locks the send"],
    [{ renderedBody: "  \n " }, "body_empty", "an empty body locks the send"],
  ];
  for (const [patch, block, why] of cases) {
    const g = m.manualSendGate({ ...base, ...patch });
    assert.equal(g.canSend, false, why);
    assert.equal(g.block, block, `…and names it "${block}"`);
    assert.ok(m.sendBlockMessage(g.block, true), `…and the footer has a sentence for "${block}"`);
  }

  // the missing recipient must never hide behind a downstream complaint
  const both = m.manualSendGate({ ...base, recipientValid: false, subject: "" });
  assert.equal(both.block, "recipient",
    "with BOTH no address and no subject, the address is the reason shown — the upstream cause wins");
  assert.match(m.sendBlockMessage("recipient", true), /חסרה כתובת אימייל/,
    "the email footer names the missing address in the reference's own words");
  assert.match(m.sendBlockMessage("recipient", false), /טלפון/,
    "…and WhatsApp names the phone instead (ruling 2: both channels)");

  // WhatsApp has no subject field, so an empty subject must NOT lock it
  const wa = m.manualSendGate({ ...base, isEmail: false, subject: "" });
  assert.equal(wa.canSend, true, "WhatsApp has no subject, so an empty one cannot lock it");
  ok("one gate drives both the disabled button and the footer's stated reason, upstream cause first");
}

// ============================================================
// 3. ruling 3 — the preview is truthful to the wire ("—" is NOT implemented)
// ============================================================
{
  assert.doesNotMatch(CODE, /previewBody\s*\|\|\s*"—"/,
    'the body preview does not substitute "—" for an empty render (owner ruling: truthful to the wire)');
  assert.doesNotMatch(CODE, /previewSubject\s*\|\|\s*"—"/,
    "…and neither does the subject preview");
  // the ONE "—" the reference does keep: the missing-address line in the mail head
  const dashes = [...CODE.matchAll(/"—[^"]*"/g)].map((x) => x[0]);
  assert.deepEqual(dashes, ['"— (חסרה כתובת)"'],
    `the only "—" in the drawer is the reference's missing-address line (found ${JSON.stringify(dashes)})`);
  assert.match(CODE, /renderManualText\(subject, vars, ctx\.renderContext\)/,
    "the subject preview runs the server's own chain (D172), not a second renderer");
  assert.match(CODE, /renderManualText\(body, vars, ctx\.renderContext\)/,
    "…and so does the body preview");
  assert.match(CODE, /subjectBlocked[\s\S]{0,400}?שלא ניתן לשלוח/,
    "an unresolvable subject variable is still NAMED in red, not silently blanked");
  assert.match(CODE, /bodyBlocked[\s\S]{0,400}?שלא ניתן לשלוח/,
    "…and so is an unresolvable body variable");
  ok("the preview shows exactly what the wire will carry, and D172's blocking alerts survived the redesign");
}

// ============================================================
// 4. ruling 4 — all 16 canonical variables are offered as chips
// ============================================================
{
  const vars = [...read("src/lib/messaging/templates.ts")
    .match(/export const CANONICAL_VARIABLES[\s\S]*?\n\];/)[0]
    .matchAll(/key:\s*"([a-z_]+)"/g)].map((x) => x[1]);
  assert.equal(vars.length, 16, `the canonical set is 16 variables (found ${vars.length})`);
  for (const k of ["booking_status", "source"]) {
    assert.ok(vars.includes(k), `"${k}" is in the canonical set — the reference's 14-chip list dropped it`);
  }
  assert.match(CODE, /ctx\.variableDefs\.map/,
    "the chips render the WHOLE canonical set from the server, never a hand-written subset");
  assert.doesNotMatch(CODE, /variableDefs[\s\S]{0,120}?\.filter\(/,
    "…and nothing filters it down (owner ruling: all 16)");
  ok("all 16 canonical variables reach the chip row — no hand-maintained second list");
}

// ============================================================
// 5. ruling 1 — still an overlay, still no width of its own
// ============================================================
{
  assert.doesNotMatch(CODE, /<SidePanel/,
    "the composer is NOT a second SidePanel (owner ruling: it stays an overlay)");
  assert.match(CSS, /\.sm-panel\s*\{[^}]*position:\s*absolute/,
    "the shell is absolutely positioned over the booking drawer it lives in");
  assert.doesNotMatch(CSS, /\.sm-panel\s*\{[^}]*\bwidth:/,
    "…and declares no width — it inherits the booking drawer's (60% / 900–1200)");
  const panel = read("src/components/reservations/EditReservationPanel.tsx");
  assert.match(panel, /overlay=\{[\s\S]{0,200}?<MessageComposer/,
    "it is still mounted in SidePanel's overlay slot, so the booking keeps its scroll (D53)");
  ok("the composer is still an overlay inside the booking drawer, with no width of its own");
}

// ============================================================
// 6. ruling 2 — both channels wear the design
// ============================================================
{
  assert.match(CODE, /channel:\s*"email"\s*\|\s*"whatsapp"/,
    "one component still serves both channels");
  assert.match(CODE, /isEmail\s*&&\s*\([\s\S]{0,200}?field-label">נושא/,
    "the subject field is email-only");
  assert.match(CODE, /isEmail\s*\?\s*"outgoing-mail"\s*:\s*"whatsapp"/,
    "the header glyph switches with the channel");
  assert.match(CODE, /"mail-off"\s*:\s*"phone"/,
    "the recipient pill switches between the email and phone glyphs");
  assert.doesNotMatch(CODE, /className="bk-cmp/,
    "no branch of the composer falls back to the pre-redesign shell");
  ok("email and WhatsApp both render the approved design, with the channel differences named");
}

// ============================================================
// 7. the SYSTEM overrode the reference: §7 header chrome + the system toast
// ============================================================
{
  for (const [cls, what] of [["dw-icon", "40px header square"], ["dw-close", "36px close button"],
                             ["dw-title", "21px/800 title"], ["dw-sub", "14px subtitle"]]) {
    assert.match(CODE, new RegExp(`className="${cls}`),
      `the header consumes the canonical ${what} (§7 beats the reference's own 42/38)`);
    assert.doesNotMatch(CSS, new RegExp(`^\\.sm-h-${cls.slice(3)}\\s*\\{`, "m"),
      `…and the partial does not redeclare it`);
  }
  assert.match(CODE, /toast\.success\(/, "success is the system toast (§9, 2.8s), not a bespoke one");
  assert.doesNotMatch(CSS, /\.sm-toast|position:\s*fixed/,
    "the partial declares no toast and nothing fixed to the viewport");
  ok("the §7 header chrome and the system toast won over the reference's local values");
}

// ============================================================
// 8. every value outside the closed sets names the reference; no orphan CSS
// ============================================================
{
  const lines = CSS.split("\n");
  const allowed = new Set();
  lines.forEach((l, i) => { if (l.includes("ds-allow:")) allowed.add(i + 1); });
  for (const [i, line] of lines.entries()) {
    if (line.includes("ds-allow:")) continue;
    const hex = line.match(/#[0-9a-fA-F]{6}\b/);
    if (!hex || /^#(fff(fff)?)$/i.test(hex[0])) continue;
    assert.ok(allowed.has(i) || allowed.has(i + 1),
      `send-message-panel.css:${i + 1} — ${hex[0]} carries no ds-allow marker`);
  }
  const markers = [...CSS.matchAll(/ds-allow:\s*([^\n—]+)—/g)].map((x) => x[1].trim());
  assert.ok(markers.length >= 10, `the deviations are itemised (${markers.length} markers)`);
  for (const ref of markers) {
    assert.equal(ref, REFERENCE, `every marker names the approved design ("${ref}")`);
  }

  // no orphan CSS (iron rule #9): the composer's old rules are gone, and the
  // shell the OTHER two overlays still wear is untouched.
  const bw = read("src/app/styles/booking-window.css");
  for (const dead of ["bk-cmp-recipient", "bk-cmp-tabs", "bk-cmp-tab", "bk-cmp-vars",
                      "bk-cmp-preview", "bk-cmp-alert", "bk-cmp-textarea", "bk-cmp-ok", "bk-cmp-f"]) {
    assert.doesNotMatch(bw, new RegExp(`\\.${dead}\\b`),
      `.${dead} was removed with the composer that used it (no orphan CSS)`);
  }
  const shared = read("src/components/reservations/CancelReservationDialog.tsx")
    + read("src/components/reservations/BookingComReports.tsx");
  for (const kept of ["bk-cmp", "bk-cmp-h", "bk-cmp-back", "bk-cmp-icon", "bk-cmp-body"]) {
    assert.match(shared, new RegExp(`bk-cmp`), "the other two overlays still use the shared shell");
    assert.match(bw, new RegExp(`\\.${kept}[\\s,{]`), `.${kept} survives — it is not orphaned, it is shared`);
  }
  ok("every deviation names the approved design, and the composer left no orphan CSS behind");
}

// ============================================================
// 9. the wiring the drawer depends on exists
// ============================================================
{
  const globals = read("src/app/globals.css");
  assert.match(globals, /@import "\.\/styles\/send-message-panel\.css";/,
    "the partial is in globals.css (iron rule #9: a table of contents)");
  const order = globals.indexOf("send-message-panel.css") < globals.indexOf("responsive.css");
  assert.ok(order, "…and before responsive.css, so the mobile layer still overrides it");

  const icons = read("src/components/shared/Icon.tsx");
  for (const lig of ["outgoing_mail", "stylus_note", "mark_email_read", "mail_off",
                     "public", "edit_note", "drafts"]) {
    assert.match(icons, new RegExp(`"${lig}"`), `the "${lig}" ligature is registered`);
  }
  assert.doesNotMatch(CODE, /<svg|lucide/, "§10: Material Symbols only, through the Icon component");

  // the draft outlives the composer, which is what makes "עדכון פרטי האורח" safe
  const panel = read("src/components/reservations/EditReservationPanel.tsx");
  assert.match(panel, /const \[drafts, setDrafts\]/,
    "the draft is held by the booking panel, so closing the composer cannot lose it");
  assert.match(panel, /email: EMPTY_DRAFT,\s*\n\s*whatsapp: EMPTY_DRAFT,/,
    "…one draft per channel — the two never share text");
  assert.match(panel, /const focusGuestEmail = \(\) => \{[\s\S]*?setComposer\(null\)/,
    '"עדכון פרטי האורח" closes the composer and returns to the booking');
  assert.match(panel, /guestEmailRef/, "…and focuses the booking's own guest email field");
  assert.match(CODE, /onEditGuest\(\)|onClick=\{onEditGuest\}/,
    "the recipient card's link calls it");
  assert.match(CODE, /!recipientValid && \(\s*\n?\s*<button[\s\S]{0,200}?onEditGuest/,
    "…and the link appears only when the address is missing (the reference shows it in that state alone)");
  ok("the partial, the icons, the lifted draft and the guest-details escape hatch are all wired");
}

// ============================================================
// 10. the mode switch — "כתיבת הודעה חדשה" is a BLANK page (D178, owner ruling
//     10/09/2026); template mode is READ-ONLY (D202, owner ruling 03/10/2026)
// ============================================================
{
  // D202 replaced the old "switching back refills the draft from the template":
  // template mode no longer copies a template into the editable draft at all —
  // it shows the published version the server rendered, and the send
  // re-resolves it server-side. So applyMode takes no template any more.
  const typed = { mode: "custom", templateId: "t1", subject: "נושא {{reservation.number}}", body: "שלום {{guest_first_name}}" };

  const custom = m.applyMode({ ...typed, mode: "template" }, "custom");
  assert.equal(custom.body, "", 'switching to "כתיבת הודעה חדשה" empties the textarea');
  // owner ruling 10/09/2026: empty means empty — the subject goes with the body
  assert.equal(custom.subject, "", "…and empties the subject field too");
  assert.ok(!custom.body.includes("{{"), "…so no {{placeholder}} can linger in the body");
  assert.ok(!custom.subject.includes("{{"), "…and none in the subject either");
  assert.equal(custom.mode, "custom", "…and the mode really changed");
  assert.equal(custom.templateId, "t1",
    "…while the chosen template is REMEMBERED — switching back shows the same template again");

  const back = m.applyMode(custom, "template");
  assert.equal(back.mode, "template", "switching back to a template changes the mode");
  assert.equal(back.templateId, "t1", "…to the same remembered template");
  assert.equal(back.body, "", "…and copies nothing into the draft: template mode is read-only (D202)");

  // an untouched custom draft must survive its own no-op switch intact
  const kept = m.applyMode(typed, "template");
  assert.equal(kept.body, typed.body, "entering template mode leaves what the operator typed alone");
  assert.equal(kept.subject, typed.subject,
    "…including the subject — the clear belongs to the switch INTO custom, not to every switch");

  // the preview is derived, so an empty pair leaves nothing for it to render
  assert.equal(custom.body.trim() + custom.subject.trim(), "",
    "with both fields empty there is nothing left for the preview to render");

  // wiring: both buttons must go through applyMode, or the runtime proof above is decoration
  assert.doesNotMatch(CODE, /patch\(\{\s*mode:/,
    "no mode switch still patches `mode` on its own (that is the bug: it spread the old body through)");
  assert.match(CODE, /onClick=\{\(\) => switchMode\("template"\)\}/, 'the "בחירה מתבנית" button routes through the switch');
  assert.match(CODE, /onClick=\{\(\) => switchMode\("custom"\)\}/, 'the "כתיבת הודעה חדשה" button routes through it too');
  assert.match(CODE, /const switchMode = \(next: ComposerDraft\["mode"\]\) =>\s*onDraftChange\(applyMode\(/,
    "…and that switch is the pure applyMode, so this section's assertions are about live code");
  ok('switching to "כתיבת הודעה חדשה" clears body AND subject; template mode copies nothing into the draft');
}

// ============================================================
// 11. the composer's free-text fields are RTL by DECLARATION, not by content
//     (D178, owner report 10/09/2026)
// ============================================================
{
  // The bug was never a missing `direction`. base.css hands every input that
  // does NOT declare a dir `unicode-bidi: plaintext` — the CSS spelling of
  // dir="auto" — so the base direction is read off the first strong character
  // of the VALUE. An empty field has no strong character, falls back to LTR and
  // parks the caret on the left; measured in Chrome at 390x844, a lone neutral
  // "5" landed 24px from the LEFT edge with 643px of space to its right.
  // `:not([dir])` is that rule's own declared opt-out, so the attribute is the
  // sanctioned fix rather than an ad-hoc one — these two assertions are the
  // link that makes dir="rtl" load-bearing instead of decorative.
  assert.match(BASE, /input:not\(\[dir\]\)/,
    "base.css's bidi rule still exempts any input that declares its own dir");
  assert.match(BASE, /textarea:not\(\[dir\]\)\s*\{\s*unicode-bidi:\s*plaintext/,
    "…and the same exemption covers textarea — that is what dir=\"rtl\" switches off");

  assert.match(CODE, /<input\b[\s\S]{0,200}?dir="rtl"[\s\S]{0,200}?placeholder="נושא ההודעה"/,
    'the subject input declares dir="rtl"');
  assert.match(CODE, /<textarea\b[\s\S]{0,200}?dir="rtl"[\s\S]{0,300}?placeholder="כתבו את ההודעה/,
    'the body textarea declares dir="rtl"');
  // the owner ruled dir="auto" OUT by name: deriving direction from content is
  // the defect, not a milder form of it
  assert.doesNotMatch(CODE, /dir="auto"/,
    'no field in the composer derives its direction from content (dir="auto" is the bug, restated)');

  // text-align resolves against the declared direction, so the value, the caret
  // and the placeholder all sit on the right — the [dir="rtl"] attribute selector
  // keeps the template <select> out of it, which never carried a dir and needs none
  assert.match(
    CSS,
    /\.sm-field input\.field-input\[dir="rtl"\],\s*\.sm-field textarea\.field-input\[dir="rtl"\]\s*\{[^}]*text-align:\s*start/,
    "the composer pins text-align: start on exactly the two fields that declare dir",
  );
  ok('the subject and body are RTL while EMPTY, by declaration — not because a Hebrew template happened to fill them');
}

// ============================================================
// 12. template mode, RENDERED (D202, owner ruling 03/10/2026) — the real
//     MessageComposer through react-dom/server, with a fixture context
// ============================================================
// Replaces §10's old "switching back refills the draft" claims with the panel
// the operator actually gets: template mode is a read-only preview (no editable
// subject or body, no variable chips), an unpublished template stays disabled,
// and "העתק לכתיבה חופשית" lands in free text with the rendered text. The copy
// button's REAL onClick is captured by a spy over react/jsx-runtime and called,
// so the click path is executed, not grepped. Every mutant below must turn it red.
{
  const { compile, variant } = await import("./lib/action-harness.mjs");
  const { writeFileSync } = await import("node:fs");
  const { createElement: h } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const out = compile("check-send-message-panel", ["src/components/reservations/BookingActions.tsx"]);
  const SPY = join(out, "jsx-spy.mjs");
  writeFileSync(SPY, `
import * as rt from "react/jsx-runtime";
export const Fragment = rt.Fragment;
const wrap = (f) => (type, props, key) => {
  if (props && typeof props.className === "string" && props.className.includes("sm-copy")) {
    (globalThis.__smCopySpy ??= []).push(props);
  }
  return f(type, props, key);
};
export const jsx = wrap(rt.jsx);
export const jsxs = wrap(rt.jsxs);
`);
  const BA = "components/reservations/BookingActions.js";
  const DRAFT = "lib/messaging/composer-draft.js";
  const spy = [BA, 'from "react/jsx-runtime"', `from ${JSON.stringify(SPY)}`];

  const WA_TEXT = "‏שלום דנה,\n‏ההזמנה 4112 אושרה.";
  const ctx = {
    reservationId: "r1", guestName: "דנה בדיקה", reservationNumber: "4112", roomNumbers: "201",
    checkIn: "2026-07-03", checkOut: "2026-07-06", sourceLabel: null,
    email: "guest@example.com", emailValid: true, phone: "0501234567", phoneE164: "+972501234567", phoneValid: true,
    variables: {}, variableDefs: [{ key: "guest_first_name", label: "שם פרטי" }], renderContext: null,
    gmailConfigured: true, whatsappConfigured: true,
    templates: {
      whatsapp: [
        { id: "wa1", name: "אישור הזמנה", status: "ready", detail: null, subject: null, text: WA_TEXT, html: null },
        { id: "wa2", name: "מידע צ׳ק-אין", status: "unpublished", detail: "התבנית טרם פורסמה", subject: null, text: "", html: null },
      ],
      email: [
        { id: "em1", name: "אישור במייל", status: "ready", detail: null, subject: "אישור הזמנה 4112",
          text: "שלום דנה", html: "<p>שלום דנה, המייל המפורסם</p>" },
      ],
    },
  };

  async function scenario(load) {
    const fail = [];
    const yes = (cond, message) => { if (!cond) fail.push(message); };
    const { MessageComposer } = await load(BA);
    const D = await load(DRAFT);
    const render = (channel, draft, onDraftChange = () => {}) => renderToStaticMarkup(h(MessageComposer, {
      channel, reservationId: "r1", draft, onDraftChange, onEditGuest() {}, onClose() {}, onSent() {}, initialContext: ctx,
    }));
    const template = (templateId) => ({ mode: "template", templateId, subject: "", body: "" });

    // WhatsApp, a published template chosen: read-only preview
    globalThis.__smCopySpy = [];
    let changed = null;
    const wa = render("whatsapp", template("wa1"), (next) => { changed = next; });
    yes(!/<textarea/.test(wa), "template mode (WhatsApp) renders no editable body");
    yes(!/class="sm-vars"/.test(wa), "template mode renders no variable chips");
    yes(wa.includes("שלום דנה,") && wa.includes("ההזמנה 4112 אושרה."), "template mode previews the rendered published text");
    yes(wa.includes("התוכן נשלח כפי שפורסם בתבנית"), "the hint says the content is sent as published (not 'editable')");
    yes(!wa.includes("אפשר לערוך"), "no hint claims the template text can be edited");
    yes(/class="btn btn-secondary sm-copy"/.test(wa) && wa.includes("העתק לכתיבה חופשית"), 'WhatsApp offers "העתק לכתיבה חופשית"');

    // an unpublished template stays disabled in the picker
    yes(/<option value="wa2" disabled="">מידע צ׳ק-אין · התבנית טרם פורסמה<\/option>/.test(wa),
      "the unpublished template is a DISABLED option carrying the hint");
    yes(/<option value="wa1"(?: selected="")?>אישור הזמנה<\/option>/.test(wa), "…while the published one is selectable");
    const stale = render("whatsapp", template("wa2"));
    yes(/<button type="button" class="btn btn-primary" disabled="">/.test(stale), "a draft holding an unpublished template cannot send");
    yes(stale.includes("התבנית טרם פורסמה — לא ניתן לשלוח"), "…and the footer names why");

    // the copy button's real onClick → free text with the rendered text
    const copyProps = globalThis.__smCopySpy.at(-1);
    yes(typeof copyProps?.onClick === "function", "the copy button carries an onClick");
    copyProps?.onClick?.();
    yes(changed?.mode === "custom", "copy switches the draft to free text");
    yes(changed?.body === WA_TEXT, "copy fills the free-text body with the rendered text, variables resolved");
    yes(changed?.subject === "", "copy carries no subject");
    if (changed) {
      const free = render("whatsapp", changed);
      yes(/<textarea[^>]*>[^<]*שלום דנה,/.test(free), "free text after copy: the textarea holds the copied text, editable");
      yes(/class="sm-vars"/.test(free), "free text after copy: the variable chips are back");
      yes(!/sm-copy/.test(free), "free text after copy: no copy button");
      yes(D.sendPayload(changed).templateId === null, "free text after copy sends no template id");
    }

    // email, a published template chosen: read-only subject + HTML
    const em = render("email", template("em1"));
    yes(!/<textarea/.test(em) && !/placeholder="נושא ההודעה"/.test(em), "template mode (email) renders no editable subject or body");
    yes(!/class="sm-vars"/.test(em), "template mode (email) renders no variable chips");
    yes(/<iframe class="sm-pv-frame" sandbox=""/.test(em), "the email preview is an inert sandbox frame");
    yes(em.includes("אישור הזמנה 4112"), "the email preview shows the published subject");
    yes(!/sm-copy/.test(em), "email offers no copy button");

    // free text is unchanged: editable subject + body + chips
    const custom = render("email", { mode: "custom", templateId: "", subject: "נושא", body: "טקסט חופשי" });
    yes(/placeholder="נושא ההודעה"/.test(custom) && /<textarea[^>]*>טקסט חופשי<\/textarea>/.test(custom),
      "free text keeps its editable subject and body");
    yes(/class="sm-vars"/.test(custom), "free text keeps its variable chips");
    return fail;
  }

  const real = await scenario(await variant(out, [spy]));
  for (const message of real) assert.ok(false, `§12 real code: ${message}`);
  const mutants = [
    ["editable textarea in template mode", [BA, 'isFree && (_jsxs("label", { className: "field sm-field"', 'true && (_jsxs("label", { className: "field sm-field"']],
    ["editable subject in template mode", [BA, 'isFree && isEmail && (_jsxs("label"', 'isEmail && (_jsxs("label"']],
    ["variable chips in template mode", [BA, 'isFree && (_jsxs("div", { className: "sm-vars"', 'true && (_jsxs("div", { className: "sm-vars"']],
    ["unpublished template enabled", [BA, 'disabled: t.status === "unpublished",', "disabled: false,"]],
    ["copy button not wired", [BA, "onClick: copyToFree,", "onClick: () => {},"]],
    ["copy stays in template mode", [DRAFT, 'return { ...draft, mode: "custom", subject: "", body: renderedText };', "return { ...draft, body: renderedText };"]],
  ];
  for (const [name, mutation] of mutants) {
    const caught = await scenario(await variant(out, [spy, mutation]));
    assert.ok(caught.length > 0, `§12 mutant "${name}" survives — the rendered-panel assertions do not detect it`);
    if (caught.length) console.log(`  ✓ mutant "${name}" caught (${caught.length}, e.g. ${caught[0]})`);
  }
  if (!real.length) ok("template mode renders read-only (no body/subject field, no chips); unpublished stays disabled; copy lands in free text — on the REAL panel, 6/6 mutants caught");
}

console.log(`\nAll ${n} send-message-drawer claim groups hold.`);
