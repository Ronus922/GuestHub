import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = mkdtempSync(join(process.cwd(), "node_modules/.cache/check-guest-communications-"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
// A tsconfig (not CLI flags): the renderer imports the email palette through the
// "@/*" alias, and only a tsconfig can teach tsc that path.
const tsconfig = join(out, "tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    module: "esnext", target: "es2022", moduleResolution: "bundler", skipLibCheck: true,
    baseUrl: process.cwd(), paths: { "@/*": ["src/*"] },
    rootDir: join(process.cwd(), "src/lib"), outDir: out,
  },
  files: [
    "src/lib/communications/types.ts", "src/lib/communications/variables.ts",
    "src/lib/communications/schemas.ts", "src/lib/communications/renderer.ts",
    "src/lib/communications/styles.ts",
    "src/lib/colors.ts", "src/lib/auth/permission-check.ts",
    "src/lib/messaging/types.ts", "src/lib/messaging/email/headers.ts",
    "src/lib/messaging/email/gmail.ts",
  ].map((file) => join(process.cwd(), file)),
}));
execSync(`pnpm exec tsc --project ${tsconfig}`, { stdio: "inherit" });

const patchImports = (path, replacements) => {
  let source = readFileSync(path, "utf8");
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  writeFileSync(path, source);
};
patchImports(join(out, "communications/variables.js"), [['"./types"', '"./types.js"']]);
patchImports(join(out, "communications/schemas.js"), [['"./types"', '"./types.js"']]);
patchImports(join(out, "communications/styles.js"), [['"@/lib/colors"', '"../colors.js"']]);
patchImports(join(out, "communications/renderer.js"), [
  ['"./schemas"', '"./schemas.js"'],
  ['"./variables"', '"./variables.js"'],
  ['"./styles"', '"./styles.js"'],
  ['"./types"', '"./types.js"'],
  // the email palette is a TOKEN file (GUIDELINES §1) — the renderer consumes it
  ['"@/lib/colors"', '"../colors.js"'],
]);
patchImports(join(out, "messaging/email/gmail.js"), [
  ['import "server-only";\n', ""],
  ['"../types"', '"../types.js"'],
  ['"./headers"', '"./headers.js"'],
]);

const schemas = await import(join(out, "communications/schemas.js"));
const variables = await import(join(out, "communications/variables.js"));
const renderer = await import(join(out, "communications/renderer.js"));
const permissions = await import(join(out, "auth/permission-check.js"));
const gmail = await import(join(out, "messaging/email/gmail.js"));

let checks = 0;
const ok = (name) => {
  process.stdout.write(`  ✓ ${name}\n`);
  checks += 1;
};

const context = {
  bookingOrigin: "back_office",
  values: {
    "guest.first_name": "נועה <script>",
    "guest.email": "noa@example.test",
    "reservation.number": "GH-42",
    "reservation.source": "ידנית",
    "reservation.status": "confirmed",
    "reservation.created_at": "14.07.2026",
    "stay.arrival_date": "20.07.2026",
    "stay.departure_date": "22.07.2026",
    "stay.nights": 2,
    "stay.check_in_time": "15:00",
    "stay.check_out_time": "11:00",
    "stay.guests": "2 מבוגרים",
    "payment.total": 1200,
    "payment.paid": 200,
    "payment.balance": 1000,
    "payment.currency": "ILS",
    "property.name": "בית & ים",
    "property.address": "רחוב החוף 1",
    "property.map_url": "https://maps.example.test/property",
  },
};

assert.deepEqual(
  variables.extractVariableKeys("{{ guest.first_name }} / {{reservation.number}} / {{guest.first_name}}"),
  ["guest.first_name", "reservation.number", "guest.first_name"],
);
assert.equal(variables.getVariableDefinition("guest.first_name")?.required, true);
assert.equal(variables.getVariableDefinition("reservation.fake"), undefined);
ok("typed variable registry extracts canonical keys and rejects unknown definitions");

assert.equal(variables.resolveVariable("payment.balance", context).value.includes("1,000"), true);
assert.deepEqual(variables.resolveVariable("room.number", context).issue, { key: "room.number", kind: "missing_optional" });
assert.deepEqual(variables.resolveVariable("made.up", context).issue, { key: "made.up", kind: "unknown_variable" });
ok("variable resolution formats money and distinguishes optional from unknown values");

const validContent = {
  schemaVersion: 1,
  blocks: [
    { id: "title", type: "heading", enabled: true, condition: "always", data: { text: "שלום {{guest.first_name}}", level: 1 } },
    { id: "details", type: "reservation_details", enabled: true, condition: "always", data: {} },
    { id: "balance", type: "balance", enabled: true, condition: "balance_positive", data: {} },
    { id: "property", type: "signature", enabled: true, condition: "always", data: { text: "{{property.name}}" } },
    { id: "direct", type: "text", enabled: true, condition: "direct_reservation", data: { text: "הזמנה ישירה" } },
    { id: "button", type: "action_button", enabled: true, condition: "manage_url_exists", data: { label: "ניהול", urlVariable: "reservation.manage_url" } },
  ],
};
assert.equal(schemas.structuredTemplateContentSchema.safeParse(validContent).success, true);
assert.equal(schemas.structuredTemplateContentSchema.safeParse({ ...validContent, extra: true }).success, false);
assert.equal(schemas.structuredTemplateContentSchema.safeParse({ ...validContent, blocks: [validContent.blocks[0], validContent.blocks[0]] }).success, false);
assert.equal(schemas.structuredTemplateContentSchema.safeParse({ schemaVersion: 1, blocks: [{ id: "b", type: "action_button", enabled: true, condition: "always", data: {} }] }).success, false);
ok("structured template schema is strict and rejects duplicate IDs and incomplete buttons");

assert.equal(schemas.timingConfigSchema.safeParse({ mode: "delay", quietHours: "respect" }).success, false);
assert.equal(schemas.timingConfigSchema.safeParse({ mode: "immediate", quietHours: "bypass" }).success, true);
assert.equal(schemas.sourceFiltersSchema.safeParse({ include: ["back_office", "direct_website"] }).success, true);
assert.equal(schemas.sourceFiltersSchema.safeParse({ include: ["booking_com"] }).success, false);
assert.equal(schemas.failureNotificationSchema.safeParse({ enabled: true }).success, false);
ok("automation schemas enforce explicit origins, immediate bypass, and valid notification settings");

const rendered = renderer.renderStructuredCommunication(validContent, context, { preheader: "אישור {{reservation.number}}" });
assert.equal(rendered.html.includes("<script>"), false);
assert.equal(rendered.html.includes("נועה &lt;script&gt;"), true);
assert.equal(rendered.html.includes("בית &amp; ים"), true);
assert.equal(rendered.html.includes("הזמנה ישירה"), false);
assert.equal(rendered.html.includes("href="), false, "missing manage URL omits the button");
assert.equal(rendered.plainText.includes("GH-42"), true);
assert.equal(rendered.plainText.includes("יתרה לתשלום"), true);
assert.equal(rendered.canSend, true);
ok("canonical renderer escapes HTML, evaluates conditions, omits unavailable actions, and emits plain text");

const directRendered = renderer.renderStructuredCommunication(validContent, {
  ...context,
  bookingOrigin: "direct_website",
  values: { ...context.values, "reservation.manage_url": "javascript:alert(1)" },
});
assert.equal(directRendered.html.includes("הזמנה ישירה"), true);
assert.equal(directRendered.html.includes("javascript:"), false);
assert.equal(directRendered.canSend, false);
assert.deepEqual(directRendered.issues.find((issue) => issue.key === "reservation.manage_url"), { key: "reservation.manage_url", kind: "invalid_url" });
ok("direct-site conditions render while unsafe action URLs fail closed");

const subject = renderer.renderTemplateString("אישור {{reservation.number}} / {{not.real}}", context);
assert.equal(subject.value, "אישור GH-42 / ");
assert.equal(subject.canSend, false);
ok("subject interpolation blocks unknown variables before delivery");

// ---- builder v2: style tokens are a KEY→literal map; an unstyled block is unchanged ----
const styledHeading = { schemaVersion: 1, blocks: [
  { id: "h", type: "heading", enabled: true, condition: "always", data: { text: "שלום", fontSize: "xxl", fontWeight: "bold", textColor: "brand", background: "brandSoft", padding: "md", align: "end" } },
] };
const styledHtml = renderer.renderStructuredCommunication(styledHeading, context).html;
assert.match(styledHtml, /font-size:24px/);
assert.match(styledHtml, /font-weight:700/);
assert.match(styledHtml, /color:#2540C8/);
assert.match(styledHtml, /background:#EEF1FD/);
assert.match(styledHtml, /text-align:end/);
// an UNSTYLED heading must still render its canonical defaults (byte parity with the
// pre-control renderer) — else every existing template silently restyles on deploy
const plainHeading = { schemaVersion: 1, blocks: [{ id: "h", type: "heading", enabled: true, condition: "always", data: { text: "שלום" } }] };
const plainHtml = renderer.renderStructuredCommunication(plainHeading, context).html;
assert.match(plainHtml, /font-size:21px;font-weight:800;line-height:1\.3;text-align:start/);
ok("text/heading style tokens resolve to approved literals; an unstyled block is byte-identical");

// ---- builder v2: a button accepts a fixed URL or a {{variable}}, and its look is bounded ----
const fixedBtn = { schemaVersion: 1, blocks: [
  { id: "b", type: "action_button", enabled: true, condition: "always", data: { label: "לאתר", url: "https://example.test/x", buttonWidth: "full", buttonRadius: "pill", buttonBg: "ok", buttonText: "ink" } },
] };
const fixedHtml = renderer.renderStructuredCommunication(fixedBtn, context).html;
assert.match(fixedHtml, /href="https:\/\/example\.test\/x"/);
assert.match(fixedHtml, /border-radius:999px/);
assert.match(fixedHtml, /background:#16A34A/);
assert.match(fixedHtml, /display:block/);
const varBtn = { schemaVersion: 1, blocks: [
  { id: "b", type: "action_button", enabled: true, condition: "always", data: { label: "ניהול", url: "{{reservation.manage_url}}" } },
] };
const withUrl = { ...context, values: { ...context.values, "reservation.manage_url": "https://gh.test/manage" } };
assert.match(renderer.renderStructuredCommunication(varBtn, withUrl).html, /href="https:\/\/gh\.test\/manage"/);
// a token that resolves to nothing → the button is omitted, never a dead link
assert.equal(renderer.renderStructuredCommunication(varBtn, context).html.includes("<a "), false);
ok("button destination accepts a fixed URL or a variable, and an empty destination omits the button");

// ---- builder v2: structured-block field toggles ----
const resDetails = { schemaVersion: 1, blocks: [
  { id: "r", type: "reservation_details", enabled: true, condition: "always", data: { showSource: true, showGuests: true, showTimes: false, showNights: false } },
] };
const resHtml = renderer.renderStructuredCommunication(resDetails, context).html;
assert.match(resHtml, /מקור הזמנה/);
assert.match(resHtml, /אורחים/);
assert.equal(resHtml.includes("צ׳ק-אין"), false);
const payDetails = { schemaVersion: 1, blocks: [
  { id: "p", type: "payment_summary", enabled: true, condition: "always", data: { showPaid: false, showBalance: false } },
] };
const payHtml = renderer.renderStructuredCommunication(payDetails, context).html;
assert.match(payHtml, /סה״כ/);
assert.equal(payHtml.includes("שולם"), false);
ok("reservation and payment blocks honour per-field visibility toggles");

// schema accepts the new bounded fields and rejects out-of-enum values
assert.equal(schemas.structuredTemplateContentSchema.safeParse(styledHeading).success, true);
assert.equal(schemas.structuredTemplateContentSchema.safeParse({ schemaVersion: 1, blocks: [{ id: "h", type: "heading", enabled: true, condition: "always", data: { fontSize: "huge" } }] }).success, false);
assert.equal(schemas.structuredTemplateContentSchema.safeParse(fixedBtn).success, true);
ok("block schema accepts the new style tokens and rejects values outside the approved set");

assert.equal(permissions.hasPermission({ roleKey: "admin", permissions: new Set() }, "communications.templates.publish"), true);
assert.equal(permissions.hasPermission({ roleKey: "viewer", permissions: new Set(["communications.templates.view"]) }, "communications.templates.view"), true);
assert.throws(
  () => permissions.requirePermission({ roleKey: "viewer", permissions: new Set() }, "communications.messages.resend"),
  (error) => error?.name === "AuthorizationError" && /communications\.messages\.resend/.test(error.message),
);
ok("granular communication permissions remain server-enforceable");

const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), init });
  if (String(url).includes("oauth2.googleapis.com")) {
    return new Response(JSON.stringify({ access_token: "unit-token" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ id: "gmail-message", threadId: "gmail-thread" }), { status: 200, headers: { "content-type": "application/json" } });
};
try {
  const provider = new gmail.GmailOAuthProvider(
    { mode: "oauth", senderEmail: "property@example.test", senderName: "ברירת מחדל", replyTo: "default@example.test" },
    { clientId: "client", clientSecret: "secret", refreshToken: "refresh" },
  );
  const result = await provider.sendEmail({
    to: "guest@example.test",
    toName: "אורחת",
    fromName: "בית הים",
    replyTo: "reply@example.test",
    subject: "אישור הזמנה",
    body: "שלום בעברית",
    html: "<p dir=\"rtl\">שלום בעברית</p>",
  });
  assert.deepEqual(result, { status: "sent", providerMessageId: "gmail-message", providerThreadId: "gmail-thread" });
  assert.equal(requests.length, 2);
  const payload = JSON.parse(String(requests[1].init.body));
  const raw = Buffer.from(payload.raw.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(raw, /Content-Type: text\/html; charset="UTF-8"/);
  assert.match(raw, /Reply-To: reply@example\.test/);
  assert.equal(raw.includes(Buffer.from("שלום בעברית").toString("base64")), true);
  assert.equal(raw.includes(Buffer.from('<p dir="rtl">שלום בעברית</p>').toString("base64")), true);
  ok("Gmail OAuth builds safe multipart plain-text plus HTML without a real send");
} finally {
  globalThis.fetch = originalFetch;
}

const source = (path) => readFileSync(path, "utf8");
const automation = source("src/lib/communications/automation.ts");
const outbox = source("src/lib/communications/outbox.ts");
const delivery = source("src/lib/communications/delivery.ts");
const reservationAction = source("src/app/(dashboard)/reservations/actions.ts");
const bookingImport = source("src/lib/channel/booking-import.ts");
assert.match(outbox, /reservation:\$\{args\.reservationId\}:confirmed:v1/);
assert.match(outbox, /ON CONFLICT \(tenant_id, event_type, aggregate_type, occurrence_key\) DO NOTHING/);
assert.match(reservationAction, /enqueueReservationConfirmed\(tx/);
assert.match(automation, /reservation\.booking_origin !== event\.source/);
assert.match(automation, /OTA_ORIGINS\.has\(reservation\.booking_origin\)/);
assert.match(automation, /reservation\.external_booking_id/);
assert.match(automation, /reservation\.status !== "confirmed"/);
assert.match(automation, /reservation\.is_test/);
assert.match(automation, /guest_communication_opt_out/);
assert.match(automation, /!reservation\.guest_email \|\| !EMAIL_RE/);
assert.match(bookingImport, /booking_origin/);
assert.match(bookingImport, /'ota'/);
assert.match(delivery, /status = 'queued'/);
assert.match(delivery, /status = 'submitting'/);
assert.match(delivery, /ambiguous_provider_outcome/);
ok("durable outbox statically guards duplicate, OTA, non-confirmed, test, opt-out, missing-email, and crash branches");

for (const path of [
  "src/lib/channel/channex-ari.ts",
  "src/lib/channel/payments-admin.ts",
  "src/lib/rates/service.ts",
  "src/lib/inventory.ts",
]) {
  assert.equal(source(path).includes("communication_events"), false, `${path} must not own communication events`);
}
assert.equal(source("src/lib/communications/automation.ts").includes("UPDATE guesthub.payments"), false);
assert.equal(source("src/lib/communications/automation.ts").includes("channel_sync_jobs"), false);
ok("communications remain isolated from Channex ARI, rates, inventory, and payment semantics");

const shell = source("src/components/communications/CommunicationsShell.tsx");
const editor = source("src/components/communications/TemplateEditor.tsx");
const sectionPage = source("src/app/(dashboard)/communications/[section]/page.tsx");
const uiActions = source("src/app/(dashboard)/communications/actions.ts");
const uiData = source("src/app/(dashboard)/communications/data.ts");
for (const route of ["automations", "templates", "history", "channels", "archive"]) {
  assert.match(shell, new RegExp(`key: "${route}"`));
}
assert.match(shell, /href=\{`\/communications\/\$\{tab\.key\}`\}/);
assert.equal(sectionPage.includes('"communications.view"'), false);
assert.match(sectionPage, /communications\.templates\.view/);
assert.match(sectionPage, /communications\.deliveries\.view/);
ok("module navigation exposes stable routes and the granular permissions");

// GUIDELINES §7: there is ONE drawer. Neither surface may hand-roll a second
// overlay — every dialog here is the canonical <SidePanel>.
for (const [name, src] of [["shell", shell], ["editor", editor]]) {
  assert.match(src, /<SidePanel/, `${name} must use the canonical §7 drawer`);
  assert.equal(/className="[^"]*\bfixed inset-0\b/.test(src), false,
    `${name} must not hand-roll a second overlay shell`);
}
ok("template editor and delivery panel are the canonical §7 SidePanel, not a second drawer");

// The canvas must paint the EMAIL'S OWN BYTES. If the editor ever grows a
// private preview renderer, an operator could approve something that does not
// match what is actually sent — the exact failure this module exists to prevent.
assert.match(editor, /renderCommunicationBlocks\(content, context/);
assert.match(editor, /dangerouslySetInnerHTML=\{\{ __html: block\.html \}\}/);
assert.match(editor, /srcDoc=\{emailDoc\?\.html \?\? ""\}/);
// mid-edit content is briefly invalid; a strict parse inside useMemo would throw
// during render and take the unsaved template down with the editor
assert.match(editor, /structuredTemplateContentSchema\.safeParse\(content\)/);
assert.equal(/<h1|<table|pv-det|gc-details-card/.test(editor), false,
  "the editor must not re-implement the email's markup");
ok("editor canvas renders the renderer's own output — preview cannot diverge from the send");

// ---- builder v2 interactions live in the editor, not a parallel screen ----
// Block DnD: palette items and the canvas are real drop targets, dropping persists
// a structured block (insertBlockAt), and reorder moves it (moveBlockTo).
assert.match(editor, /draggable=\{canEdit\}/, "palette blocks must be draggable");
assert.match(editor, /const insertBlockAt/, "a dropped block must become a real persisted block");
assert.match(editor, /const moveBlockTo/, "blocks must reorder by drag");
assert.match(editor, /onDrop=\{canvasDrop\}/, "the canvas must accept block drops");
assert.match(editor, /data-blk=\{block\.id\}/);
assert.match(editor, /gc-dropline/, "a drop must show an insertion indicator");
// Variable DnD + click, and NEVER a silent no-op when nothing is focused.
assert.match(editor, /application\/x-gh-variable/, "variables must be draggable with a typed payload");
assert.match(editor, /setVarHint\(true\)/, "clicking a variable with no field focused must instruct, not no-op");
assert.match(editor, /בחרו שדה טקסט או בלוק/, "the no-target instruction must be shown");
assert.match(editor, /onFieldDrop/, "text fields must accept a dropped variable at the caret");
// Direct in-canvas editing of a text block (an input, not a second renderer).
assert.match(editor, /gc-inline/, "a text block must be editable directly in the canvas");
assert.match(editor, /setEditingId/);
// Button gets a free destination + a publish-time warning when it has none.
assert.match(editor, /kind: "url"/, "the button URL field must accept variable insertion");
assert.match(editor, /לכפתור אין יעד/, "a destination-less published button must warn");
ok("block drag-drop, variable drag+click with an instruction, direct editing, and button URL live in the one editor");

// ---- builder v2: the creation window collects a real, custom name (§1) ----
assert.match(shell, /function NewTemplateDialog/, "there must be a real creation window");
assert.match(shell, /setCreating\(true\)/, "the 'new template' action opens the creation flow");
assert.match(shell, /שכפול תבנית קיימת/, "creation supports blank or duplicate");
assert.equal(/name = "תודה ואישור הזמנה"|value="תודה ואישור/.test(shell + editor), false,
  "no template name may be hard-coded");
ok("template creation opens a real window with an editable name and blank/duplicate choice");

// A queued email is not a sent email: the booking can be cancelled during the
// retry backoff, and the send path only ever reads the frozen snapshot.
assert.match(delivery, /cancelIneligibleDeliveries/);
assert.match(delivery, /r\.status <> 'confirmed' OR r\.is_test OR r\.guest_communication_opt_out/);
assert.match(delivery, /status = 'cancelled'/);
// Assert the CALL inside drainDeliveries — not merely that the function exists.
// (A first cut of this check matched the declaration and happily passed with the
// call deleted; it was caught by mutating the source and watching it stay green.)
const drainBody = delivery.slice(delivery.indexOf("export async function drainDeliveries"));
assert.match(drainBody, /await cancelIneligibleDeliveries\(\)/,
  "drainDeliveries must re-check eligibility on every tick");
assert.equal(
  drainBody.indexOf("await cancelIneligibleDeliveries()") < drainBody.indexOf("await claimDeliveries("),
  true,
  "eligibility must be re-checked BEFORE the claim, not after",
);
assert.match(delivery, /delivery_type <> 'test'/, "the worker must not steal an operator's test send");
ok("a booking cancelled or opted-out after queueing has its delivery cancelled, never sent");

// A per-reservation data gap must not disable the automation for every OTHER guest.
const renderFailedBlock = automation.slice(
  automation.indexOf("!rendered.canSend"),
  automation.indexOf("!rendered.canSend") + 400,
);
assert.equal(/markNeedsAttention/.test(renderFailedBlock), false,
  "render_failed is a fact about ONE reservation — it must not disable the automation");
assert.match(automation, /render_context_failed/);
assert.match(automation, /t\.archived_at IS NULL AND t\.lifecycle_state <> 'archived'/);
ok("one unrenderable reservation never disables the automation; an archived template is never sent");

// A test send is a REAL send on the REAL path, but never guest history.
assert.match(uiActions, /claimDeliveryById/);
assert.match(uiActions, /deliverClaimedEmail/);
assert.match(uiActions, /'test'/);
assert.match(uiActions, /requirePermission\(actor, "communications\.test\.send"\)/);
assert.match(uiData, /delivery_type <> 'test'/);
ok("test send reuses the worker's delivery path and is excluded from guest history");

process.stdout.write(`\n✓ Guest Communications domain checks passed (${checks} groups)\n`);
