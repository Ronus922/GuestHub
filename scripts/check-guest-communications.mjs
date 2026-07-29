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
    "src/lib/communications/styles.ts", "src/lib/communications/triggers.ts",
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
patchImports(join(out, "communications/schemas.js"), [['"./types"', '"./types.js"'], ['"./triggers"', '"./triggers.js"']]);
patchImports(join(out, "communications/triggers.js"), [['"./types"', '"./types.js"']]);
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
const triggers = await import(join(out, "communications/triggers.js"));
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
// the scheduled arm is new; the stored event-timing rows above must keep parsing untouched
assert.equal(schemas.timingConfigSchema.safeParse({ mode: "scheduled", offsetDays: 3, sendTime: "10:00", quietHours: "bypass" }).success, true);
assert.equal(schemas.timingConfigSchema.safeParse({ mode: "scheduled", offsetDays: 3, quietHours: "bypass" }).success, false);
assert.equal(schemas.timingConfigSchema.safeParse({ mode: "scheduled", offsetDays: 99, sendTime: "10:00", quietHours: "bypass" }).success, false);
assert.equal(schemas.sourceFiltersSchema.safeParse({ include: ["back_office", "direct_website"] }).success, true);
assert.equal(schemas.sourceFiltersSchema.safeParse({ include: ["booking_com"] }).success, false);
assert.equal(schemas.failureNotificationSchema.safeParse({ enabled: true }).success, false);
// a scheduled trigger must carry scheduled timing, an event trigger must not
assert.equal(schemas.automationConfigSchema.safeParse({
  triggerType: "reservation.pre_arrival",
  timing: { mode: "immediate", quietHours: "bypass" },
  sources: { include: ["back_office"] },
  conditions: { logic: "all", items: [] },
  exclusions: {}, recipient: { type: "primary_guest" }, channel: "email",
}).success, false);
assert.equal(schemas.automationConfigSchema.safeParse({
  triggerType: "reservation.pre_arrival",
  timing: { mode: "scheduled", offsetDays: 3, sendTime: "10:00", quietHours: "bypass" },
  sources: { include: ["back_office"] },
  conditions: { logic: "all", items: [] },
  exclusions: {}, recipient: { type: "primary_guest" }, channel: "whatsapp",
}).success, true);
assert.equal(schemas.automationConfigSchema.safeParse({
  triggerType: "reservation.made_up",
  timing: { mode: "immediate", quietHours: "bypass" },
  sources: { include: ["back_office"] },
  conditions: { logic: "all", items: [] },
  exclusions: {}, recipient: { type: "primary_guest" }, channel: "email",
}).success, false);
ok("automation schemas enforce explicit origins, per-kind timing, and the closed trigger registry");

// ---- trigger registry invariants the pipeline relies on ----
assert.deepEqual(triggers.TRIGGERS["reservation.confirmed"].eligibleStatuses, ["confirmed"]);
assert.equal(triggers.TRIGGERS["reservation.confirmed"].otaHardSkip, true, "the OTA hard-skip on confirmations must never be dropped");
assert.deepEqual(triggers.TRIGGERS["reservation.cancelled"].eligibleStatuses, ["cancelled"]);
assert.equal(
  triggers.TRIGGERS["reservation.cancelled"].defaultConditions.items.some(
    (item) => item.field === "reservation.status" && item.value === "confirmed",
  ),
  false,
  "a cancellation automation must not require status=confirmed",
);
for (const def of triggers.TRIGGER_LIST) {
  assert.equal(def.defaultExclusions.ota, true, `${def.id} must default to excluding OTA bookings`);
  if (def.kind === "scheduled") assert.match(def.defaultSendTime ?? "", /^([01]\d|2[0-3]):[0-5]\d$/);
}
ok("trigger registry keeps confirmed semantics byte-compatible and cancellation conditions sane");

// ---- quiet hours clamp is pure and handles the over-midnight window ----
{
  const at = (h, m) => { const d = new Date(2026, 6, 27); d.setHours(h, m, 0, 0); return d; };
  const window = { enabled: true, start: "22:00", end: "07:00" };
  assert.equal(triggers.applyQuietHours(at(12, 0), window).getTime(), at(12, 0).getTime());
  const evening = triggers.applyQuietHours(at(23, 30), window);
  assert.equal(evening.getHours(), 7);
  assert.equal(evening.getDate(), at(0, 0).getDate() + 1, "an evening quiet-hours hit must clamp to TOMORROW morning");
  const night = triggers.applyQuietHours(at(3, 0), window);
  assert.equal(night.getHours(), 7);
  assert.equal(night.getDate(), at(0, 0).getDate());
  assert.equal(triggers.applyQuietHours(at(23, 30), { enabled: false, start: "22:00", end: "07:00" }).getHours(), 23);
  const sameDay = triggers.applyQuietHours(at(14, 0), { enabled: true, start: "13:00", end: "15:00" });
  assert.equal(sameDay.getHours(), 15);
}
ok("applyQuietHours clamps into the window's end and survives midnight-crossing windows");

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

// ---- content kinds: a missing `kind` is a legacy block tree, forever ----
assert.equal(schemas.templateContentKind(schemas.parseTemplateContent(validContent)), "blocks");
assert.equal(schemas.templateContentKind(schemas.parseTemplateContent({ schemaVersion: 1, kind: "html", html: "<p>שלום</p>" })), "html");
assert.equal(schemas.templateContentKind(schemas.parseTemplateContent({ schemaVersion: 1, kind: "whatsapp_text", text: "שלום" })), "whatsapp_text");
assert.throws(() => schemas.parseTemplateContent({ schemaVersion: 1, kind: "html", html: "<script>alert(1)</script>" }),
  undefined, "script tags must be rejected in html templates");
assert.equal(schemas.htmlTemplateContentSchema.safeParse({ schemaVersion: 1, kind: "html", html: "" }).success, true,
  "an empty draft is a legal draft — publish is where completeness is enforced");
assert.equal(schemas.whatsappTemplateContentSchema.safeParse({ schemaVersion: 1, kind: "whatsapp_text", text: "x".repeat(5000) }).success, false);
ok("parseTemplateContent dispatches on kind, keeps legacy trees parsing, and rejects scripts");

// ---- html-kind rendering: interpolated VALUES are escaped, author markup is not ----
{
  const htmlContent = { schemaVersion: 1, kind: "html", html: "<p>שלום {{guest.first_name}} — {{property.name}}</p>" };
  const renderedHtml = renderer.renderHtmlCommunication(htmlContent, context);
  assert.equal(renderedHtml.html.includes("<p>שלום"), true, "the author's markup IS the markup");
  assert.equal(renderedHtml.html.includes("נועה &lt;script&gt;"), true, "a guest value can never become markup");
  assert.equal(/<script>alert/.test(renderedHtml.html), false);
  assert.match(renderedHtml.html, /<html lang="he" dir="rtl">/, "a fragment gets an RTL document shell");
  assert.equal(renderedHtml.canSend, true);
  const full = renderer.renderHtmlCommunication({ schemaVersion: 1, kind: "html", html: "<html><body>{{guest.first_name}}</body></html>" }, context);
  assert.equal((full.html.match(/<html/g) ?? []).length, 1, "a full document must not be double-wrapped");
  const unknown = renderer.renderHtmlCommunication({ schemaVersion: 1, kind: "html", html: "{{not.real}}" }, context);
  assert.equal(unknown.canSend, false);
  const missing = renderer.renderHtmlCommunication({ schemaVersion: 1, kind: "html", html: "{{payment.total}}" }, { ...context, values: {} });
  assert.equal(missing.canSend, false, "a missing required variable must block the send");
}
ok("html templates interpolate with escaped values, wrap fragments RTL, and fail closed on bad variables");

// ---- GAP 1: an unquoted attribute must not be escapable into a NEW attribute ----
// Escaping <>&"' is not enough there: `x onerror=alert(1)` needs no angle bracket
// and no quote, only a space and an `=`. Reverting escapeHtml's `=` entity makes
// this fail while every other assertion in this file still passes.
{
  const attrCtx = { ...context, values: { ...context.values, "guest.first_name": "x onerror=alert(1)" } };
  const unquoted = renderer.renderHtmlCommunication(
    { schemaVersion: 1, kind: "html", html: "<img alt={{guest.first_name}}>" }, attrCtx,
  ).html;
  assert.equal(/onerror\s*=/.test(unquoted), false,
    "a guest value in an unquoted attribute must not be able to introduce onerror=");
  assert.match(unquoted, /onerror&#61;alert\(1\)/, "the '=' must be entity-encoded");
  // the same payload in the blocks renderer (quoted/text contexts) stays inert too
  const blockAttr = renderer.renderStructuredCommunication(
    { schemaVersion: 1, blocks: [{ id: "t", type: "text", enabled: true, condition: "always", data: { text: "{{guest.first_name}}" } }] },
    attrCtx,
  ).html;
  assert.equal(/onerror\s*=/.test(blockAttr), false);
  // …and a NORMAL value is untouched: a space is still a space, never an entity
  const normal = renderer.renderStructuredCommunication(
    { schemaVersion: 1, blocks: [{ id: "t", type: "text", enabled: true, condition: "always", data: { text: "{{property.name}} · {{stay.guests}}" } }] },
    context,
  );
  assert.match(normal.html, /2 מבוגרים/, "a space inside a rendered value must stay a literal space");
  assert.equal(normal.html.includes("&#32;"), false, "whitespace must never be entity-encoded");
  assert.equal(normal.canSend, true);
}
ok("an unquoted-attribute payload cannot introduce a new attribute, and normal values keep their spaces");

// ---- GAP 2: the html path gates URL schemes through the SAME safeHttpUrl ----
// The blocks renderer already refuses javascript:; the html path had no href of
// its own to guard, so the guard travels with the value. Reverting guardUrlValue
// makes this fail while the rest of the suite stays green.
{
  const jsCtx = { ...context, values: { ...context.values, "reservation.manage_url": "javascript:alert(1)" } };
  const injected = renderer.renderHtmlCommunication(
    { schemaVersion: 1, kind: "html", html: '<a href="{{reservation.manage_url}}">x</a>' }, jsCtx,
  );
  assert.equal(injected.html.includes("javascript:"), false, "javascript: must never reach the outbound href");
  assert.match(injected.html, /href=""/, "a rejected URL is emitted EMPTY, exactly like the blocks path");
  assert.deepEqual(
    injected.issues.find((issue) => issue.key === "reservation.manage_url"),
    { key: "reservation.manage_url", kind: "invalid_url" },
  );
  assert.equal(injected.canSend, false, "an invalid URL must block the send");

  // data: and vbscript: are refused on the same path
  for (const scheme of ["data:text/html,<b>x</b>", "vbscript:msgbox(1)", "file:///etc/passwd"]) {
    const out = renderer.renderHtmlCommunication(
      { schemaVersion: 1, kind: "html", html: '<a href="{{reservation.manage_url}}">x</a>' },
      { ...context, values: { ...context.values, "reservation.manage_url": scheme } },
    );
    assert.match(out.html, /href=""/, `${scheme} must be rejected`);
    assert.equal(out.canSend, false);
  }
  // a legitimate https URL still renders (the guard must not over-block)
  const good = renderer.renderHtmlCommunication(
    { schemaVersion: 1, kind: "html", html: '<a href="{{reservation.manage_url}}">x</a>' },
    { ...context, values: { ...context.values, "reservation.manage_url": "https://gh.test/manage?a=1" } },
  );
  assert.match(good.html, /href="https:\/\/gh\.test\/manage\?a&#61;1"/,
    "a valid https URL survives; its '=' is entity-encoded and decodes back before the URL is read");
  assert.equal(good.canSend, true);
  // mailto:/tel: are legitimate in an email and must pass untouched
  for (const safe of ["mailto:property@example.test", "tel:+972500000000"]) {
    const out = renderer.renderHtmlCommunication(
      { schemaVersion: 1, kind: "html", html: '<a href="{{property.email}}">x</a>' },
      { ...context, values: { ...context.values, "property.email": safe } },
    );
    assert.equal(out.html.includes(safe), true, `${safe} must pass through`);
    assert.equal(out.canSend, true);
  }
}
ok("the html path refuses javascript:/data:/vbscript:/file: through safeHttpUrl and keeps http(s)/mailto/tel");

// ---- GAP 2b: scheme detection must see what the CLIENT resolves ----
// Every browser/mail client strips leading C0 controls and removes ASCII
// tab/CR/LF from ANYWHERE in a URL before resolving it. A naive `^[a-z]…:`
// test on the raw value therefore misses `java\tscript:` and `\0javascript:` —
// both were measured reaching the outbound href live. Reverting urlProbe (or
// dropping its .trim()) makes these fail while the rest of the suite passes.
{
  const obfuscated = [
    ["leading newline", "\njavascript:alert(1)"],
    ["leading space", " javascript:alert(1)"],
    ["tab inside the scheme", "java\tscript:alert(1)"],
    ["CR inside the scheme", "java\rscript:alert(1)"],
    ["LF inside the scheme", "java\nscript:alert(1)"],
    ["mixed case", "JaVaScRiPt:alert(1)"],
    ["leading NUL", "\u0000javascript:alert(1)"],
    ["trailing control", "javascript:alert(1)\u0001"],
    ["NUL inside the scheme", "java\u0000script:alert(1)"],
  ];
  for (const [name, payload] of obfuscated) {
    // a NON-url-kind variable: the guest's own name, the realistic carrier
    const out = renderer.renderHtmlCommunication(
      { schemaVersion: 1, kind: "html", html: '<a href="{{guest.first_name}}">x</a>' },
      { ...context, values: { ...context.values, "guest.first_name": payload } },
    );
    const href = out.html.match(/href="([^"]*)"/)[1];
    assert.equal(/javascript\s*:/i.test(href.replace(/[\u0000-\u001F\u007F]/g, "")), false,
      `${name}: a javascript: URL must not survive into the href`);
    assert.equal(href, "", `${name}: a rejected URL is emitted EMPTY`);
    assert.deepEqual(
      out.issues.find((issue) => issue.key === "guest.first_name"),
      { key: "guest.first_name", kind: "invalid_url" },
      `${name}: must be recorded as invalid_url`,
    );
    assert.equal(out.canSend, false, `${name}: must block the send`);
  }
  // …and the probe must NOT mangle an ordinary multi-line value: a guest note
  // carrying newlines is not a URL and keeps its own bytes.
  const note = renderer.renderHtmlCommunication(
    { schemaVersion: 1, kind: "html", html: "<p>{{reservation.cancellation_policy}}</p>" },
    { ...context, values: { ...context.values, "reservation.cancellation_policy": "שורה א\nשורה ב" } },
  );
  assert.match(note.html, /שורה א\nשורה ב/, "a non-URL value keeps its newlines untouched");
  assert.equal(note.canSend, true);
  // a real https URL carrying a stray tab is cleaned, not dropped
  const messyOk = renderer.renderHtmlCommunication(
    { schemaVersion: 1, kind: "html", html: '<a href="{{reservation.manage_url}}">x</a>' },
    { ...context, values: { ...context.values, "reservation.manage_url": " https://gh.test/manage\t" } },
  );
  assert.match(messyOk.html, /href="https:\/\/gh\.test\/manage"/);
  assert.equal(messyOk.canSend, true);
}
ok("obfuscated schemes (leading/embedded control chars, NUL, case) are detected exactly as a client would resolve them");

// ---- GAP 3: URL safety belongs to the WHOLE attribute, not to one token ----
// guardUrlValue judges each {{variable}} alone, so a scheme split across two of
// them slips through both checks: "javascript" carries no colon, ":alert(1)"
// does not start with a letter — joined they are a live javascript: URL. Only a
// post-interpolation scan of the finished document can see it. Reverting
// scanDocumentUrls makes every case here fail while the rest of the file passes.
{
  const split = (a, b, markup = '<a href="{{guest.first_name}}{{guest.last_name}}">x</a>') =>
    renderer.renderHtmlCommunication(
      { schemaVersion: 1, kind: "html", html: markup },
      { ...context, values: { ...context.values, "guest.first_name": a, "guest.last_name": b } },
    );

  // the premise: neither half is refused on its own — the join is what is unsafe
  const lone = (key, value) => renderer.renderHtmlCommunication(
    { schemaVersion: 1, kind: "html", html: `<a href="{{${key}}}">x</a>` },
    { ...context, values: { ...context.values, [key]: value } },
  );
  assert.equal(lone("guest.first_name", "javascript").canSend, true, "'javascript' alone carries no colon and is a legal value");
  assert.equal(lone("guest.last_name", ":alert(1)").canSend, true, "':alert(1)' alone starts with no letter and is a legal value");

  for (const [name, a, b] of [
    ["javascript", "javascript", ":alert(1)"],
    ["data", "data", ":text/html,<b>x</b>"],
    ["vbscript", "vbscript", ":msgbox(1)"],
  ]) {
    const out = split(a, b);
    assert.equal(out.canSend, false, `${name}: a scheme split across two variables must block the send`);
    const issue = out.issues.find((entry) => entry.kind === "invalid_url");
    assert.equal(issue.key, "html.href", `${name}: the document scan must record invalid_url on the attribute`);
    assert.equal(typeof issue.detail === "string" && issue.detail.startsWith(`href="${name}:`), true,
      `${name}: the finding must name the attribute and the value`);
  }
  // …and with no quotes around the attribute at all
  const bare = split("javascript", ":alert(1)", "<a href={{guest.first_name}}{{guest.last_name}}>x</a>");
  assert.equal(bare.canSend, false, "an unquoted split payload must block the send too");
  // …and on the other URL-bearing attributes
  for (const markup of [
    "<img src={{guest.first_name}}{{guest.last_name}}>",
    "<form action='{{guest.first_name}}{{guest.last_name}}'></form>",
    '<button formaction="{{guest.first_name}}{{guest.last_name}}">x</button>',
    '<use xlink:href="{{guest.first_name}}{{guest.last_name}}"/>',
  ]) {
    assert.equal(split("javascript", ":alert(1)", markup).canSend, false, `${markup} must be scanned too`);
  }

  // over-blocking guard: a normal document of legitimate links must still send,
  // byte-for-byte unchanged — the scan reads the document, it never edits it.
  const safeDoc = '<a href="https://gh.test/manage?a=1#top">ניהול</a>'
    + '<a href="mailto:hi@gh.test">מייל</a>'
    + '<a href="tel:+972500000000">טלפון</a>'
    + '<img src="/static/logo.png" alt="">'
    + '<img src="//cdn.example.com/logo.png" alt="">'
    + '<img src="cid:logo@guesthub" alt="">'
    + '<a href="#top">למעלה</a>'
    + "<p>שלום {{guest.first_name}}</p>";
  const safe = renderer.renderHtmlCommunication({ schemaVersion: 1, kind: "html", html: safeDoc }, context);
  assert.equal(safe.issues.some((issue) => issue.kind === "invalid_url"), false,
    "https/mailto/tel/cid, relative, scheme-relative and anchors must all pass");
  assert.equal(safe.canSend, true);
  assert.equal(
    safe.html.endsWith(`${safeDoc.replace("{{guest.first_name}}", "נועה &lt;script&gt;")}</body></html>`),
    true,
    "a normal template renders byte-identically — the scan must not rewrite the document",
  );
}
ok("a scheme split across two variables is caught by the document scan, and normal documents render byte-identically");

// ---- GAP 3a: inline images — RASTER only, and only in a src ----
// Pasted newsletters carry base64 images by the dozen, so refusing every data:
// URI blocks real templates. svg+xml is NOT one of them: an SVG is a document
// and can carry <script>. Reverting ALLOWED_DATA_IMAGE fails the raster cases;
// loosening it to a `data:image/` prefix fails the svg+xml case.
{
  const doc = (markup) => renderer.renderHtmlCommunication({ schemaVersion: 1, kind: "html", html: markup }, context);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==";

  for (const [name, uri] of [
    ["png", png],
    ["jpeg", "data:image/jpeg;base64,/9j/4AAQSkZJRg=="],
    ["jpg", "data:image/jpg;base64,/9j/4AAQSkZJRg=="],
    ["gif", "data:image/gif;base64,R0lGODlhAQABAAAAACw="],
    ["webp", "data:image/webp;base64,UklGRhIAAABXRUJQ"],
    ["png, not base64", "data:image/png,rawbytes"],
  ]) {
    const out = doc(`<img src="${uri}" alt="">`);
    assert.equal(out.canSend, true, `an inline ${name} image must pass in a src`);
    assert.equal(out.issues.some((issue) => issue.kind === "invalid_url"), false, `${name} must raise no issue`);
  }

  for (const [name, uri] of [
    ["svg+xml base64", "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+"],
    ["svg+xml plain", "data:image/svg+xml,<svg onload=alert(1)></svg>"],
    ["text/html", "data:text/html,<script>alert(1)</script>"],
    ["bmp — outside the allowlist", "data:image/bmp;base64,Qk0="],
    ["image/pngx — the media type is matched WHOLE", "data:image/pngx;base64,AAAA"],
  ]) {
    const out = doc(`<img src="${uri}" alt="">`);
    assert.equal(out.canSend, false, `${name} must stay blocked in a src`);
    assert.equal(out.issues.find((issue) => issue.kind === "invalid_url").key, "html.src");
  }

  // …and a data: URI is never navigable: the raster allowance is src-only
  for (const attr of ["href", "action", "formaction"]) {
    const out = doc(`<a ${attr}="${png}">x</a>`);
    assert.equal(out.canSend, false, `an inline image in ${attr} has nothing to navigate to and must be refused`);
  }
}
ok("inline raster images pass in a src while svg+xml, text/html and any data: in href stay refused");

// ---- GAP 3b: a refused URL must say WHICH attribute and WHICH value ----
// "html.href" alone sends the author hunting through the document. Reverting
// the detail field fails here and nowhere else.
{
  const doc = (markup) => renderer.renderHtmlCommunication({ schemaVersion: 1, kind: "html", html: markup }, context);
  const dead = doc('<a href="javascript:void(0)">x</a>');
  assert.equal(dead.canSend, false, "javascript:void(0) stays blocked");
  assert.deepEqual(
    dead.issues.find((issue) => issue.kind === "invalid_url"),
    { key: "html.href", kind: "invalid_url", detail: 'href="javascript:void(0)"' },
    "the finding must carry the attribute name and the offending value",
  );
  // a long value is truncated so the message stays one readable line
  const long = doc(`<a href="ftp://gh.test/${"x".repeat(200)}">x</a>`);
  const detail = long.issues.find((issue) => issue.kind === "invalid_url").detail;
  assert.match(detail, /^href="ftp:\/\/gh\.test\/x+…"$/, "a long value is truncated with an ellipsis");
  assert.equal(detail.length, 68, "attribute + 60 chars + ellipsis + quotes");
  // two DIFFERENT bad links are two findings — dedupe keys on the value too
  const two = doc('<a href="ftp://gh.test/1">x</a><a href="ftp://gh.test/2">y</a>');
  assert.equal(two.issues.filter((issue) => issue.kind === "invalid_url").length, 2,
    "two different bad links must not collapse into one finding");
  // …while the SAME bad link twice is still one finding
  const same = doc('<a href="ftp://gh.test/1">x</a><a href="ftp://gh.test/1">y</a>');
  assert.equal(same.issues.filter((issue) => issue.kind === "invalid_url").length, 1);
  // a variable issue carries no detail — nothing else in the render changed
  const unknownVar = renderer.renderHtmlCommunication({ schemaVersion: 1, kind: "html", html: "{{not.real}}" }, context);
  assert.deepEqual(unknownVar.issues, [{ key: "not.real", kind: "unknown_variable" }]);
}
ok("a document-scan rejection names its attribute and value, truncated, without changing kind or canSend");

// ---- whatsapp rendering: plain text, NO escaping — "&amp;" must never reach a guest ----
{
  const wa = renderer.renderWhatsAppCommunication({ schemaVersion: 1, kind: "whatsapp_text", text: "שלום {{guest.first_name}} — {{property.name}}" }, context);
  assert.equal(wa.text.includes("בית & ים"), true, "WhatsApp is a text medium — no HTML entities");
  assert.equal(wa.text.includes("&amp;"), false);
  assert.equal(wa.canSend, true);
  const waBad = renderer.renderWhatsAppCommunication({ schemaVersion: 1, kind: "whatsapp_text", text: "{{not.real}}" }, context);
  assert.equal(waBad.canSend, false);
  // the ONE dispatch routes whatsapp text into plainText and never into html
  const dispatched = renderer.renderTemplateContent({ schemaVersion: 1, kind: "whatsapp_text", text: "שלום" }, context);
  assert.equal(dispatched.html, "");
  assert.equal(dispatched.plainText, "שלום");
}
ok("whatsapp rendering never HTML-escapes and the unified dispatch keeps it out of the html path");

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
assert.match(outbox, /reservation:\$\{args\.reservationId\}:cancelled:v1/);
assert.match(outbox, /ON CONFLICT \(tenant_id, event_type, aggregate_type, occurrence_key\) DO NOTHING/);
assert.match(reservationAction, /enqueueReservationConfirmed\(tx/);
assert.match(reservationAction, /enqueueReservationCancelled\(tx/);
assert.match(bookingImport, /enqueueReservationCancelled\(tx/);
assert.match(automation, /reservation\.booking_origin !== event\.source/);
assert.match(automation, /OTA_ORIGINS\.has\(reservation\.booking_origin\)/);
assert.match(automation, /reservation\.external_booking_id/);
// eligibility is registry-driven now; the runtime assert above pins
// TRIGGERS["reservation.confirmed"].eligibleStatuses to exactly ['confirmed']
assert.match(automation, /trigger\.eligibleStatuses\.includes\(reservation\.status\)/);
assert.match(automation, /trigger\.otaHardSkip/);
assert.match(automation, /reservation\.is_test/);
assert.match(automation, /guest_communication_opt_out/);
assert.match(automation, /reservation\.guest_email && EMAIL_RE\.test/);
assert.match(automation, /missing_guest_email/);
assert.match(automation, /missing_guest_phone/);
assert.match(bookingImport, /booking_origin/);
assert.match(bookingImport, /'ota'/);
assert.match(delivery, /status = 'queued'/);
assert.match(delivery, /status = 'submitting'/);
assert.match(delivery, /ambiguous_provider_outcome/);
ok("durable outbox statically guards duplicate, OTA, ineligible, test, opt-out, missing-recipient, and crash branches");

// ---- scheduler: idempotent set-based emission, per-automation occurrence keys ----
const scheduler = source("src/lib/communications/scheduler.ts");
const workerSrc = source("src/lib/communications/worker.ts");
assert.match(scheduler, /ON CONFLICT \(tenant_id, event_type, aggregate_type, occurrence_key\) DO NOTHING/);
assert.match(scheduler, /'reservation:' \|\| r\.id \|\| ':' \|\| \$\{trigger\.shortName\} \|\| ':' \|\| a\.id \|\| ':'/,
  "a scheduled occurrence key must embed the automation id AND the anchor date");
assert.match(scheduler, /AT TIME ZONE 'Asia\/Jerusalem'/, "scheduling is Israel-local like the rest of the stack");
assert.match(scheduler, /a\.status = 'active' AND a\.archived_at IS NULL/);
assert.match(workerSrc, /runScheduledTriggerScan/, "the tick must run the scheduled scan");
assert.equal(
  workerSrc.indexOf("runScheduledTriggerScan") < workerSrc.indexOf("claimCommunicationEvents(workerId"),
  true,
  "the scan must run BEFORE the claim so fresh events ride the same tick",
);
assert.match(automation, /scheduledAutomationId/,
  "a scheduled event must target ONLY its own automation, not every trigger match");
ok("time-based triggers emit idempotently per automation and ride the same worker tick");

// ---- whatsapp delivery: real provider path, honest failure taxonomy ----
assert.match(delivery, /deliverClaimedWhatsApp/);
assert.match(delivery, /resolveWhatsAppProvider/);
assert.match(delivery, /classifyWhatsAppFailure/);
assert.match(delivery, /validation_failed/,
  "green-api reports an invalid number as validation_failed — it must never be recorded as sent");
assert.equal(/from "@\/lib\/messaging\/service"/.test(delivery), false,
  "the delivery path must use the provider adapter directly, not the legacy actor-bound service");
// both queued INSERT paths (email + whatsapp) must stamp the trigger's statuses
assert.equal((automation.match(/eligible_statuses/g) ?? []).length >= 2, true,
  "both the email and whatsapp INSERTs must carry eligible_statuses");
ok("whatsapp deliveries ride the same lease pipeline with their own provider and error taxonomy");

for (const path of [
  "src/lib/channel/beds24-ari-sync.ts",
  "src/lib/rates/service.ts",
  "src/lib/inventory.ts",
]) {
  assert.equal(source(path).includes("communication_events"), false, `${path} must not own communication events`);
}
assert.equal(source("src/lib/communications/automation.ts").includes("UPDATE guesthub.payments"), false);
assert.equal(source("src/lib/communications/automation.ts").includes("channel_sync_jobs"), false);
ok("communications remain isolated from channel ARI, rates, inventory, and payment semantics");

const shell = source("src/components/communications/CommunicationsShell.tsx");
const editor = source("src/components/communications/TemplateEditor.tsx");
const htmlEditor = source("src/components/communications/HtmlTemplateEditor.tsx");
const waEditor = source("src/components/communications/WhatsAppTemplateEditor.tsx");
const editorShared = source("src/components/communications/editorShared.tsx");
const gallery = source("src/lib/communications/gallery.ts");
const blocksLib = source("src/lib/communications/blocks.ts");
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
for (const [name, src] of [["shell", shell], ["editor", editor], ["htmlEditor", htmlEditor], ["waEditor", waEditor]]) {
  assert.match(src, /<SidePanel/, `${name} must use the canonical §7 drawer`);
  assert.equal(/className="[^"]*\bfixed inset-0\b/.test(src), false,
    `${name} must not hand-roll a second overlay shell`);
}
assert.equal(/className="[^"]*\bfixed inset-0\b/.test(editorShared), false,
  "editorShared must not hand-roll a second overlay shell");
ok("all three template editors and the delivery panel are the canonical §7 SidePanel");

// ---- html editor: the pasted HTML NEVER touches the dashboard DOM ----
assert.match(htmlEditor, /sandbox=""/, "the HTML preview must be a sandboxed iframe");
assert.equal(/dangerouslySetInnerHTML=/.test(htmlEditor), false,
  "operator HTML must never be injected into the dashboard DOM");
assert.match(htmlEditor, /renderHtmlCommunication/, "preview must render the REAL send bytes");
assert.match(htmlEditor, /application\/x-gh-variable/, "the HTML editor must accept variable drops");
assert.match(htmlEditor, /issue\.detail \?\? `\{\{\$\{issue\.key\}\}\}`/,
  "a refused URL must show its attribute and value, not a {{token}} that does not exist");
ok("the HTML editor previews only through a sandboxed iframe of the real bytes");

// ---- whatsapp editor: text-only, no email concepts, text-node preview ----
assert.equal(/dangerouslySetInnerHTML/.test(waEditor), false);
assert.equal(/setPreheader|setReplyTo|setSubject|senderDisplayName/.test(waEditor), false,
  "a WhatsApp template has no subject/preheader/sender — email concepts must not leak in");
assert.match(waEditor, /renderWhatsAppCommunication/);
assert.match(waEditor, /gc-wa-bubble/, "the preview is a chat bubble");
assert.match(waEditor, /4096/, "the WhatsApp length cap must be enforced in the editor");
assert.match(waEditor, /sendTestWhatsAppAction/);
ok("the WhatsApp editor is plain text + variables with a bubble preview, not an email form");

// ---- blank means BLANK: the forced 13-block seed is gone ----
assert.equal(/defaultTemplateContent/.test(blocksLib), false,
  "the forced booking-confirmation seed must stay deleted from blocks.ts");
assert.match(gallery, /blocks: \[\]|blocks:\[\]/, "the blank starting point must have zero blocks");
assert.match(gallery, /TEMPLATE_GALLERY/);
assert.match(gallery, /kind: "whatsapp_text"/, "the gallery must carry WhatsApp examples");
assert.match(editor, /schemaVersion: 1, blocks: \[\]/, "a new blocks template must start empty");
assert.equal(/\?\? "תבנית חדשה"|\?\? "ההזמנה שלכם אושרה/.test(editor + htmlEditor + waEditor), false,
  "no editor may hard-code a default name or subject");
ok("a new template is truly blank; examples live in the opt-in gallery only");

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
// eligibility is per-row now (eligible_statuses stamped at preparation): a queued
// CANCELLATION message must survive status='cancelled' while a confirmation dies
assert.match(delivery, /NOT \(r\.status = ANY\(o\.eligible_statuses\)\) OR r\.is_test OR r\.guest_communication_opt_out/);
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
