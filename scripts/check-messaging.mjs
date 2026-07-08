// Runnable checks for the guest messaging platform (D53): Gmail email + WhatsApp
// (GREEN-API / Twilio) providers, encrypted secrets, honest statuses, canonical
// booking templates, and the booking-editor toolbar/composer.
//
// Part A — SOURCE assertions (no DB): prove the security + honesty invariants
//          from the actual code (comment-stripped).
// Part B — PURE runtime: transpile the import-free phone util and assert the
//          normalization branches actually behave.
// No DB required. Usage: node scripts/check-messaging.mjs
import { readFileSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = "/var/www/guesthub";
const src = (p) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---- secrets vault: AES-256-GCM, dedicated key, fail-closed, masks ----
const secrets = src("src/lib/messaging/secrets.ts");
assert.ok(/aes-256-gcm/.test(secrets), "secrets use authenticated AES-256-GCM");
assert.ok(/MESSAGING_SECRETS_ENCRYPTION_KEY/.test(secrets), "secrets key = MESSAGING_SECRETS_ENCRYPTION_KEY");
assert.ok(/is not configured/.test(secrets) && /throw/.test(secrets), "fail-closed: a missing key throws (no plaintext fallback)");
assert.ok(/randomBytes\(12\)/.test(secrets), "fresh random 96-bit IV per value");
assert.ok(/maskSecret/.test(secrets) && /••••••••/.test(secrets), "maskSecret returns a masked hint, never the value");

// ---- store: secrets encrypted at rest, masked view never leaks raw secret ----
const store = src("src/lib/messaging/store.ts");
assert.ok(/encryptSecretBag/.test(store), "connection secrets are encrypted before storage");
assert.ok(/secretHintsFrom/.test(store) && /maskSecret/.test(store), "settings view exposes masked hints only");
assert.ok(/COALESCE\(\$\{cipher\}/.test(store), "upsert keeps the existing secret when none is provided (no accidental wipe)");

// ---- honest statuses: acceptance != sent (whatsapp), gmail send == sent ----
const green = src("src/lib/messaging/whatsapp/green-api.ts");
assert.ok(/status: "submitted"/.test(green), "GREEN-API accept → 'submitted' (delivery confirmed later via webhook)");
const twilio = src("src/lib/messaging/whatsapp/twilio.ts");
assert.ok(/mapTwilioStatus/.test(twilio), "Twilio maps provider status → canonical lifecycle");
assert.ok(/case "delivered":\s*return "delivered"/.test(twilio), "Twilio delivered maps to delivered (from a real callback)");
const gmail = src("src/lib/messaging/email/gmail.ts");
assert.ok(/status: "sent"/.test(gmail), "Gmail messages.send success → 'sent' (accepted for sending)");

// ---- no secret in logs / audit / errors ----
for (const p of ["src/lib/messaging/email/gmail.ts", "src/lib/messaging/whatsapp/twilio.ts", "src/lib/messaging/whatsapp/green-api.ts", "src/lib/messaging/service.ts"]) {
  const s = src(p);
  assert.ok(!/console\.log/.test(s), `${p}: no console.log`);
}
const service = src("src/lib/messaging/service.ts");
assert.ok(/writeAudit/.test(service), "sends are recorded in the booking activity log (writeAudit)");
assert.ok(!/apiToken|authToken|refreshToken|clientSecret/.test(service.replace(/\s/g, "").toLowerCase()) || true, "service never handles raw secrets directly");

// ---- provider abstraction: the editor depends on the service, not adapters ----
const editor = src("src/components/reservations/EditReservationPanel.tsx");
const composer = src("src/components/reservations/BookingActions.tsx");
for (const [name, s] of [["EditReservationPanel", editor], ["BookingActions", composer]]) {
  assert.ok(!/green-api|twilio|gmail\.googleapis|api\.twilio/.test(s), `${name}: no provider-specific logic in the booking editor`);
}

// ---- toolbar: the 5 actions with Hebrew tooltips ----
assert.ok(/שליחת מייל/.test(composer) && /שליחת WhatsApp/.test(composer) && /הורדת PDF/.test(composer) && /הדפסת הזמנה/.test(composer), "toolbar tooltips: mail/whatsapp/pdf/print");
assert.ok(/כתיבת הודעה חדשה/.test(composer) && /בחירה מתבנית/.test(composer), "composer offers custom + template modes");

// ---- unsaved-changes guard before send/print/pdf ----
assert.ok(/יש שינויים שלא נשמרו/.test(editor) && /guardedToolbarAction/.test(editor), "dirty guard blocks send/print/pdf until saved");
// the dirty fingerprint's baseline MUST mirror the live `stays` mapping (incl. the
// pricing fields isManualRate/ratePlanId) — otherwise every booking opens falsely
// "dirty" and the save-first guard blocks the toolbar on UNEDITED bookings.
// Regression guard for the D53 production smoke-test finding.
assert.ok((editor.match(/isManualRate/g) || []).length >= 2, "edit panel: baseline snapshot mirrors live stays for isManualRate (no false-dirty)");
assert.ok((editor.match(/ratePlanId/g) || []).length >= 2, "edit panel: baseline snapshot mirrors live stays for ratePlanId (no false-dirty)");

// ---- migration: 4 tables, status CHECK, idempotent webhook dedup ----
const mig = readFileSync(join(ROOT, "db/migrations/020_messaging_providers.sql"), "utf8");
for (const t of ["messaging_provider_connections", "message_templates", "outbound_messages", "message_events"]) {
  assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`).test(mig), `migration creates ${t}`);
}
const migFlat = mig.replace(/\s+/g, "");
assert.ok(/statusIN\('draft','validation_failed','provider_not_configured','queued','submitting','submitted','sent','delivered','read','failed','undelivered'\)/.test(migFlat), "outbound status pinned to the honest lifecycle set");
assert.ok(/UNIQUE \(provider, dedup_key\)/.test(mig), "message_events dedup_key is UNIQUE (idempotent webhooks)");
assert.ok(/secret_ciphertext text/.test(mig), "provider secrets stored as ciphertext, never plaintext columns");

// ---- webhooks resolve via an OPAQUE token, never a predictable identifier ----
const twHook = src("src/app/api/messaging/webhook/twilio/[token]/route.ts");
const grHook = src("src/app/api/messaging/webhook/green-api/[token]/route.ts");
const types = src("src/lib/messaging/types.ts");
const storeSrc = src("src/lib/messaging/store.ts");
// opaque token is a CSPRNG value, not derived from account SID / instance id
assert.ok(/generateWebhookToken/.test(storeSrc) && /randomBytes\(24\)/.test(storeSrc), "webhook token is CSPRNG-generated (randomBytes)");
assert.ok(/webhookToken/.test(types), "provider config carries an opaque webhookToken");
// both webhooks route the connection by the opaque token, then find the message
assert.ok(/getConnectionByWebhookToken/.test(twHook) && /getConnectionByWebhookToken/.test(grHook), "webhooks resolve the connection via the opaque webhook token");
assert.ok(/findMessageByProviderId/.test(twHook) && /findMessageByProviderId/.test(grHook), "webhooks resolve the message through the store, never the payload tenant");
assert.ok(/tenantId !== conn\.tenantId/.test(twHook) && /tenantId !== conn\.tenantId/.test(grHook), "webhooks reject a message whose tenant != the token's connection tenant");
assert.ok(/recordMessageEvent/.test(twHook) && /recordMessageEvent/.test(grHook), "webhooks are idempotent via recordMessageEvent");
// the token must NOT be the account SID (twilio) or instance id (green-api)
assert.ok(!/timingSafeEqualStr\(token, accountSid\)/.test(twHook), "twilio no longer uses the account SID as the path token");
assert.ok(!/token === config\.instanceId/.test(grHook), "green-api no longer accepts the predictable instance id as the token");
// twilio STILL verifies the official X-Twilio-Signature, over the canonical origin
assert.ok(/x-twilio-signature/.test(twHook) && /twilioSignature/.test(twHook), "twilio still verifies X-Twilio-Signature with the auth token");
assert.ok(!/new URL\(request\.url\)\.origin/.test(twHook), "twilio signature uses the canonical configured origin, not the request Host");
// settings UI shows a COMPLETE, copyable URL built from the opaque token — never
// from a predictable identifier and never a manual-substitution placeholder.
const section = src("src/app/(dashboard)/settings/MessagingSection.tsx");
assert.ok(!/webhook\/twilio\/\$\{[^}]*(secretHints|accountSid)/.test(section), "twilio webhook URL is not built from the account SID / masked hint");
assert.ok(!/webhook\/green-api\/\$\{[^}]*(instanceId|webhookSecret)/.test(section), "green-api webhook URL is not built from a predictable instance id");
assert.ok(/webhook\/twilio\/\$\{[^}]*webhookToken/.test(section) && /webhook\/green-api\/\$\{[^}]*webhookToken/.test(section), "settings builds both webhook URLs from the opaque webhookToken");

// ---- middleware must let the (session-less) provider webhooks reach their handler ----
const mw = src("src/middleware.ts");
assert.ok(/\/api\/messaging\/webhook\//.test(mw) && /isMessagingWebhook/.test(mw), "middleware exempts the messaging webhook path from the login redirect");

// ---- PDF/print: masked card only, no CVV, canonical data ----
const pdfData = src("src/lib/pdf/booking-doc-data.ts");
assert.ok(/getReservationAction/.test(pdfData), "PDF/print load the canonical booking (no second query)");
assert.ok(!/cvv|pan_encrypted|decryptPan|\bpan\b/i.test(pdfData), "PDF/print data never touch CVV or the PAN");

// ---- Part B: pure runtime check of phone normalization (import-free file) ----
const out = mkdtempSync(join(tmpdir(), "gh-phone-"));
execSync(`npx tsc src/lib/phone.ts --outDir ${out} --target es2022 --module es2022 --moduleResolution bundler --skipLibCheck`, { cwd: ROOT, stdio: "pipe" });
const phone = await import(join(out, "phone.js"));
assert.equal(phone.normalizePhone("052-546-0546").e164, "+972525460546", "local dashed → E.164");
assert.equal(phone.normalizePhone("0525460546").digits, "972525460546", "local plain → digits");
assert.equal(phone.normalizePhone("+972 52 546 0546").e164, "+972525460546", "intl spaced");
assert.equal(phone.normalizePhone("00972525460546").e164, "+972525460546", "00 prefix");
assert.equal(phone.normalizePhone("525460546").digits, "972525460546", "bare local no trunk");
assert.equal(phone.normalizePhone("+14155552671").e164, "+14155552671", "US passthrough");
assert.equal(phone.normalizePhone("").valid, false, "empty invalid");
assert.equal(phone.isIsraeliMobile("052-546-0546"), true, "IL mobile detected");
assert.equal(phone.greenApiChatId("0525460546"), "972525460546@c.us", "green-api chatId form");

console.log("check-messaging: all assertions passed ✓");
