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
// 10. the mode switch — "כתיבת הודעה חדשה" is a BLANK page (D178, owner ruling 10/09/2026)
// ============================================================
{
  const tpl = { subject: "אישור הזמנה {{reservation.number}}", body: "שלום {{guest_first_name}},\nמספר {{reservation.number}}" };
  const filled = { mode: "template", templateId: "t1", subject: tpl.subject, body: tpl.body };

  const custom = m.applyMode(filled, "custom", tpl, true);
  assert.equal(custom.body, "", 'switching to "כתיבת הודעה חדשה" empties the textarea');
  assert.ok(!custom.body.includes("{{"), "…so no {{placeholder}} can linger on screen");
  assert.equal(custom.mode, "custom", "…and the mode really changed");
  assert.equal(custom.templateId, "t1",
    "…while the chosen template is REMEMBERED — switching back has to have something to refill from");

  const back = m.applyMode(custom, "template", tpl, true);
  assert.equal(back.body, tpl.body, "switching back to a template repopulates the body");
  assert.equal(back.subject, tpl.subject, "…and the subject, on email");
  assert.equal(m.applyMode(custom, "template", tpl, false).subject, custom.subject,
    "…but never the subject on WhatsApp, which has no subject field");

  // the select keeps its value, so re-picking the same option fires no change
  // event: without this branch the body could never come back at all
  assert.notEqual(back.body, "", "the round trip template → custom → template is not one-way");

  const orphan = m.applyMode({ ...filled, templateId: "gone" }, "template", null, true);
  assert.equal(orphan.body, filled.body, "a templateId that matches nothing leaves the draft alone");
  assert.equal(orphan.mode, "template", "…and still switches mode");

  // an untouched custom draft must survive its own no-op switch intact
  const typed = { mode: "custom", templateId: "", subject: "s", body: "מה שהמפעיל הקליד" };
  assert.equal(m.applyMode(typed, "template", null, true).body, typed.body,
    "with no template chosen, entering template mode keeps what the operator typed");

  // wiring: both buttons must go through applyMode, or the runtime proof above is decoration
  assert.doesNotMatch(CODE, /patch\(\{\s*mode:/,
    "no mode switch still patches `mode` on its own (that is the bug: it spread the old body through)");
  assert.match(CODE, /onClick=\{\(\) => switchMode\("template"\)\}/, 'the "בחירה מתבנית" button routes through the switch');
  assert.match(CODE, /onClick=\{\(\) => switchMode\("custom"\)\}/, 'the "כתיבת הודעה חדשה" button routes through it too');
  assert.match(CODE, /const switchMode = \(next: ComposerDraft\["mode"\]\) =>\s*onDraftChange\(applyMode\(/,
    "…and that switch is the pure applyMode, so this section's assertions are about live code");
  ok('switching to "כתיבת הודעה חדשה" clears the body, and switching back refills it from the template');
}

console.log(`\nAll ${n} send-message-drawer claim groups hold.`);
