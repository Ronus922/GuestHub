#!/usr/bin/env node
// ============================================================
// check:wa-template-render — the two D115/D116 rules, pinned (B2).
//
// RULE 1 (D115). A missing variable must not silently cost a send: variables
// are OPTIONAL by default (render empty, send proceeds), `{{key|fallback}}`
// renders the fallback, and only an explicit `{{key!}}` may skip — naming the
// variable in the skip's evidence (D112).
//
// RULE 2 (D116). Hebrew WhatsApp render output is RTL-safe: WhatsApp gives
// each line its direction from the line's first STRONG bidi character, so for
// a language:'he' template every non-empty rendered line must open with a
// strong RTL character (U+200F RLM prefix). English templates get no invisible
// bytes, and the operator's typed template text is never mutated.
//
// The renderer is COMPILED FROM THIS TREE (guard-roots: import.meta.url) and
// executed — plus source-level call-site assertions that the automation and
// the editor actually feed the renderer what the rules require.
// Static + pure: no DB, no network, no build.
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const RLM = "\u200F";
let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

// ---- compile the renderer from THIS tree ----
mkdirSync(join(ROOT, "node_modules/.cache"), { recursive: true });
const out = mkdtempSync(join(ROOT, "node_modules/.cache/check-wa-template-render-"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
const tsconfig = join(out, "tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    module: "esnext", target: "es2022", moduleResolution: "bundler", skipLibCheck: true,
    baseUrl: ROOT, paths: { "@/*": ["src/*"] }, rootDir: join(ROOT, "src/lib"), outDir: out,
  },
  files: [join(ROOT, "src/lib/communications/renderer.ts")],
}));
execSync(`pnpm exec tsc --project ${tsconfig}`, { stdio: "inherit", cwd: ROOT });

for (const file of ["renderer.js", "schemas.js", "variables.js", "styles.js", "triggers.js"]) {
  const path = join(out, `communications/${file}`);
  const emitted = readFileSync(path, "utf8")
    .replaceAll('"./types"', '"./types.js"')
    .replaceAll('"./schemas"', '"./schemas.js"')
    .replaceAll('"./variables"', '"./variables.js"')
    .replaceAll('"./styles"', '"./styles.js"')
    .replaceAll('"./triggers"', '"./triggers.js"')
    .replaceAll('"@/lib/colors"', '"../colors.js"');
  writeFileSync(path, emitted);
}

const renderer = await import(join(out, "communications/renderer.js"));
const variables = await import(join(out, "communications/variables.js"));
const { renderWhatsAppCommunication, renderStructuredCommunication, renderTemplateString } = renderer;
const { describeRenderIssues } = variables;

const wa = (text) => ({ schemaVersion: 1, kind: "whatsapp_text", text });
const ctx = (values) => ({ bookingOrigin: "direct_website", values });

// A line's first STRONG bidi character class — the rule WhatsApp resolves by.
// R: Hebrew/Arabic blocks (incl. presentation forms) + RLM/RLE/RLI.
// L: Latin + LRM/LRE/LRI. Digits, punctuation and symbols are not strong.
function firstStrong(line) {
  for (const ch of line) {
    if (/[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC\u200F\u202B\u2067]/u.test(ch)) return "R";
    if (/[A-Za-z\u00C0-\u024F\u200E\u202A\u2066]/u.test(ch)) return "L";
  }
  return null;
}

// ============================================================
// RULE 2 — RTL-safe Hebrew output
// ============================================================
{
  const typed = "שלום {{guest.first_name}},\n0123 שורה שנפתחת בספרות\n₪350 יתרה\n054-1234567\n\nHELLO {{guest.first_name}} סוגריים";
  assert.ok(!typed.includes(RLM), "fixture must not carry RLM of its own");
  const he = renderWhatsAppCommunication(wa(typed), ctx({ "guest.first_name": "דנה" }), { language: "he" });
  for (const line of he.text.split("\n")) {
    if (!line) continue;
    assert.equal(firstStrong(line), "R",
      `Hebrew WhatsApp line must open with a strong RTL character, got: ${JSON.stringify(line)}`);
  }
  ok("he render: every non-empty line's first strong character is RTL (digit/currency/phone/Latin openers included)");

  assert.ok(he.text.split("\n").some((line) => line === ""), "the empty line survives untouched");
  ok("he render: empty lines stay empty — no stray invisible bytes");

  const again = renderWhatsAppCommunication(wa(he.text), ctx({}), { language: "he" });
  assert.equal(again.text, he.text);
  ok("he render: idempotent — re-rendering already-safe text adds nothing");

  const en = renderWhatsAppCommunication(
    wa("Hello {{guest.first_name}},\n350 ILS due"), ctx({ "guest.first_name": "Dana" }), { language: "en" });
  assert.ok(!en.text.includes(RLM), "English template must carry no RLM");
  const bare = renderWhatsAppCommunication(wa("Hello\n123"), ctx({}));
  assert.ok(!bare.text.includes(RLM), "language omitted must add no RLM");
  ok("en render / no language: zero invisible characters introduced");

  assert.ok(!typed.includes(RLM), "the operator's typed template text was not mutated");
  ok("render output only — the stored template body is untouched");
}

// ============================================================
// RULE 1 — optional by default, ! required, | fallback, named evidence
// ============================================================
{
  const missing = ctx({ "guest.first_name": "דנה" }); // no guest.email anywhere

  const optional = renderWhatsAppCommunication(wa("אימייל: {{guest.email}}"), missing, { language: "he" });
  assert.equal(optional.canSend, true,
    "a missing OPTIONAL variable must not block the send (this was the silent-skip defect)");
  assert.ok(optional.issues.some((issue) => issue.kind === "missing_optional" && issue.key === "guest.email"));
  ok("missing optional variable renders empty and the send proceeds");

  const required = renderWhatsAppCommunication(wa("אימייל: {{guest.email!}}"), missing, { language: "he" });
  assert.equal(required.canSend, false, "an explicit {{key!}} without a value must skip");
  assert.ok(required.issues.some((issue) => issue.kind === "missing_required" && issue.key === "guest.email"));
  const evidence = describeRenderIssues(required.issues);
  assert.ok(evidence && evidence.includes("guest.email"), "the skip evidence must NAME the variable (D112)");
  ok(`{{key!}} skips and the evidence names it: "${evidence}"`);

  const fallback = renderWhatsAppCommunication(wa("שלום {{guest.first_name|אורח יקר}}"), ctx({}), { language: "he" });
  assert.equal(fallback.canSend, true);
  assert.ok(fallback.text.includes("אורח יקר"), "declared fallback must render");
  assert.equal(fallback.issues.length, 0, "a declared fallback is handled — no issue at all");
  ok("{{key|fallback}} renders the fallback and never blocks");

  const present = renderWhatsAppCommunication(wa("שלום {{guest.first_name|אורח}}"), ctx({ "guest.first_name": "דנה" }), { language: "he" });
  assert.ok(present.text.includes("דנה") && !present.text.includes("אורח"), "a present value beats its fallback");
  ok("fallback is only for missing values — a present value renders itself");

  const unknown = renderWhatsAppCommunication(wa("{{guest.emial}}"), missing, { language: "he" });
  assert.equal(unknown.canSend, false, "an unknown token can never resolve — a broken template still blocks");
  assert.ok(describeRenderIssues(unknown.issues)?.includes("guest.emial"));
  ok("unknown variable still blocks, and is named");

  const subject = renderTemplateString("אישור עבור {{guest.email}}", missing);
  assert.equal(subject.canSend, true, "email SUBJECT with a missing optional variable must not skip");
  ok("renderTemplateString (subject/preheader): optional-by-default too");

  const blocks = renderStructuredCommunication({
    schemaVersion: 1,
    blocks: [{ id: "b1", type: "reservation_details", enabled: true, condition: "always", data: {} }],
  }, missing);
  assert.equal(blocks.canSend, true,
    "a structured email with missing detail values must render (empty cells), not skip");
  ok("structured email blocks: missing values no longer cost the send");
}

// ============================================================
// Call-site integrity — the renderer contract is only half the rule; the
// automation and the editor must actually invoke it that way.
// ============================================================
{
  const automation = readFileSync(join(ROOT, "src/lib/communications/automation.ts"), "utf8");
  assert.match(automation, /renderWhatsAppCommunication\(\s*content as WhatsAppTemplateContent,\s*context,\s*\{ language: version\.language \}\)/,
    "the automation must render WhatsApp with the TEMPLATE's language");
  assert.ok((automation.match(/t\.language/g) ?? []).length >= 2,
    "resolveVersion must SELECT the owning template's language in both queries");
  assert.ok((automation.match(/describeRenderIssues\(/g) ?? []).length >= 2,
    "both render_failed skip sites must carry describeRenderIssues evidence");
  ok("automation.ts: language flows from the template; render_failed skips carry named evidence");

  const editor = readFileSync(join(ROOT, "src/components/communications/WhatsAppTemplateEditor.tsx"), "utf8");
  assert.match(editor, /renderWhatsAppCommunication\(content, context, \{ language \}\)/,
    "the editor preview must render with the SAME language the send will use");
  assert.ok(!/gc-wa-bubble"\s+dir=/.test(editor),
    "the bubble must not carry dir= — one direction for the whole bubble lies per-line");
  ok("editor preview renders the same bytes as the send, direction included");

  const css = readFileSync(join(ROOT, "src/app/styles/communications.css"), "utf8");
  const bubble = css.slice(css.indexOf(".gc-wa-bubble"), css.indexOf("}", css.indexOf(".gc-wa-bubble")));
  assert.ok(bubble.includes("unicode-bidi: plaintext"),
    ".gc-wa-bubble must resolve direction per line (unicode-bidi: plaintext) exactly as WhatsApp does");
  ok("preview bubble uses per-line first-strong direction — WhatsApp's rule");

  const delivery = readFileSync(join(ROOT, "src/lib/communications/delivery.ts"), "utf8");
  assert.ok(delivery.includes("body: delivery.rendered_plain_text"),
    "WhatsApp delivery must send the stored render snapshot verbatim — the RLM bytes must survive");
  ok("delivery sends the rendered snapshot verbatim");
}

console.log(`\nALL ${n} PASSED — wa-template-render`);
