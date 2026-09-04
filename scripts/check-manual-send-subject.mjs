#!/usr/bin/env node
// ============================================================
// check:manual-send-subject — the booking composer's MANUAL send renders the
// email subject through the communications renderer (D172).
//
// Evidence that motivated it: outbound_messages 6518a028 (2026-09-04 20:46Z)
// went to Gmail with the literal subject
//   "אישור הזמנה {{reservation.number}} · {{property.name}}"
// because message-actions.ts rendered the subject with the legacy
// renderTemplate, whose regex never matches a dotted key.
//
// Part A (static): the send path and the composer preview use renderManualSubject,
//   and the legacy subject render calls are gone.
// Part B (runtime, no DB): the REAL compiled renderManualSubject
//   1. resolves {{reservation.number}} and {{property.name}} to their values;
//   2. never ships an unknown {{group.key}} literally — blanks it AND blocks,
//      naming the variable;
//   3. still resolves legacy {{snake_case}} keys (older templates / chips);
//   4. resolves a mixed legacy + dotted subject in one pass;
//   5. keeps D115: a known-but-missing optional value renders empty, send allowed.
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
assert.ok(/renderManualSubject\(/.test(actions), "sendBookingEmailAction renders the subject via renderManualSubject");
assert.ok(!/renderTemplate\(tpl\.subject/.test(actions) && !/subject = renderTemplate\(subject/.test(actions),
  "the legacy renderTemplate no longer renders the subject (its regex ignores dotted keys)");
assert.ok(/reservationRenderContext|safeRenderContext/.test(actions), "the send builds the reservation's communications render context");
assert.ok(/renderedSubject\.canSend/.test(actions), "a blocked subject refuses the send instead of shipping a token");
const composer = src("src/components/reservations/BookingActions.tsx");
assert.ok(/renderManualSubject\(/.test(composer), "the composer preview uses the same subject renderer as the send");
assert.ok(/subjectBlocked/.test(composer) && /!subjectBlocked/.test(composer), "the composer disables send while the subject is blocked");
const automation = src("src/lib/communications/automation.ts");
assert.ok(/export async function reservationRenderContext\(/.test(automation), "automation.ts exports the per-reservation render context");
const module_ = src("src/lib/messaging/render-manual.ts");
assert.ok(/renderTemplateString\(/.test(module_) && /renderTemplate\(/.test(module_), "renderManualSubject chains the legacy pass and the communications renderer");
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
  include: [join(ROOT, "src/lib/messaging/render-manual.ts")],
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
const { renderManualSubject } = req(join(out, "lib/messaging/render-manual.js"));

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

console.log("✓ Part B: 6 runtime scenarios passed on the compiled renderer");
console.log("check:manual-send-subject — PASS");
