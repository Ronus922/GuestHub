// Runnable checks for the protected card storage + tenant VAT setting (D41/D52).
// D52: CVV/CVC is NEVER collected, stored, encrypted, revealed, logged or
// audited — anywhere. This suite asserts the CVV helpers are GONE from the pure
// rules and the vault, that no source path persists or reveals a CVV, and that
// the redaction guard still scrubs a CVV from a stored channel payload. The PAN
// contract (encrypted at rest, masked reads, audited reveal) is unchanged.
// Same pattern as check-guards.mjs: compiles the pure/server modules with
// tsc, imports them, and asserts the security + validation rules. Uses ONLY
// clearly fictional test-card numbers (industry test PANs). Also runs
// source-level assertions that the sensitive-data rules hold in the actual
// action/component sources. Usage: node scripts/check-cards.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "cards-"));
execSync(
  `pnpm exec tsc src/lib/card-rules.ts src/lib/card-vault.ts src/lib/vat.ts src/lib/channel/payloads.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
// card-vault imports the "server-only" marker package — stub it for node
mkdirSync(join(out, "node_modules", "server-only"), { recursive: true });
writeFileSync(join(out, "node_modules", "server-only", "package.json"), '{"name":"server-only","main":"index.js"}');
writeFileSync(join(out, "node_modules", "server-only", "index.js"), "");

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const rules = require(join(out, "card-rules.js"));
const vault = require(join(out, "card-vault.js"));
const vat = require(join(out, "vat.js"));
const payloads = require(join(out, "channel", "payloads.js"));

// ---- Luhn + PAN validation (fictional industry test numbers only) ----
const TEST_VISA = "4111111111111111";
const TEST_MC = "5555555555554444";
const TEST_AMEX = "378282246310005";
assert.equal(rules.luhnValid(TEST_VISA), true);
assert.equal(rules.luhnValid("4111111111111112"), false, "bad checksum rejected");
assert.equal(rules.panValid(TEST_VISA), true);
assert.equal(rules.panValid("411111111111"), false, "12 digits too short");
assert.equal(rules.panValid("41111111111111111111"), false, "20 digits too long");
assert.equal(rules.panValid("4111 1111 1111 1111"), false, "spaces must be normalized first");
assert.equal(rules.panValid(rules.normalizePan("4111 1111-1111 1111")), true, "normalize strips separators");

// ---- brand detection + masking ----
assert.equal(rules.detectBrand(TEST_VISA), "visa");
assert.equal(rules.detectBrand(TEST_MC), "mastercard");
assert.equal(rules.detectBrand(TEST_AMEX), "amex");
assert.equal(rules.detectBrand("30569309025904"), "diners");
assert.equal(rules.detectBrand("6011111111111117"), "other");
assert.equal(rules.maskedPan("1111"), "•••• •••• •••• 1111", "masked form shows last4 only");
assert.ok(!rules.maskedPan("1111").includes(TEST_VISA.slice(0, 6)), "mask never leaks a prefix");

// ---- expiry rules ----
assert.deepEqual(rules.parseExpiry("07/28"), { month: 7, year: 2028 });
assert.equal(rules.parseExpiry("13/28"), null, "month 13 invalid");
assert.equal(rules.parseExpiry("0728"), null, "must be MM/YY");
const NOW = new Date(2026, 6, 4); // 2026-07-04
assert.equal(rules.expiryInPast(6, 2026, NOW), true, "last month is expired");
assert.equal(rules.expiryInPast(7, 2026, NOW), false, "current month still valid");
assert.equal(rules.expiryInPast(1, 2027, NOW), false);

// ---- CVV helpers restored for the MANUAL-ENTRY card (D87) ----
assert.equal(typeof rules.cvvValid, "function", "cvvValid restored — the stored CVV is validated");
assert.equal(rules.cvvValid("123"), true, "3-digit CVV valid");
assert.equal(rules.cvvValid("1234"), true, "4-digit CVV (Amex) valid");
assert.equal(rules.cvvValid("12"), false, "2 digits too short");
assert.equal(rules.cvvValid("12a"), false, "non-numeric rejected");
assert.equal(rules.formatCvv("1a2b3"), "123", "formatCvv keeps digits, caps at 4");
assert.equal(rules.maskedCvv, undefined, "no maskedCvv — the CVV is shown in full, never masked (D87)");
assert.ok(!rules.MANUAL_CARD_SOURCES.includes("channel"), "manual entry can never set source=channel");

// ---- channel card extraction: PAN only, CVV STILL never carried from a channel
//      (D87 restored CVV only on the MANUAL path — the OTA ingest is untouched) ----
const vc = payloads.extractChannelCard({
  credit_card: {
    cardholder_name: "TEST GUEST",
    card_number: "4111 1111 1111 1111",
    expiration_date: "08/2029",
    is_virtual: true,
    card_type: "Visa",
    cvv: "123",
  },
});
assert.ok(vc, "a card object is extracted");
assert.equal(vc.isVirtual, true, "virtual card flagged");
assert.equal(vc.expMonth, 8);
assert.equal(vc.expYear, 2029);
assert.equal(rules.normalizePan(vc.pan), "4111111111111111");
assert.equal(vc.cvv, undefined, "channel extraction NEVER carries a CVV");
assert.equal(payloads.extractChannelCard({ guest: { name: "x" } }), null, "no card data → null (not an empty stub)");
// the STORED/LOGGED revision payload stays redacted — a CVV in the raw payload
// is scrubbed by the redaction guard (the last line of defence)
const red = payloads.redactPayload({ credit_card: { card_number: "4111111111111111", cvv: "123" }, guest_name: "ok" });
assert.equal(red.credit_card, "[redacted]", "card object still redacted from logs/persistence");
assert.equal(red.guest_name, "ok", "non-card fields survive redaction");
const redFlat = payloads.redactPayload({ cvv: "123", cvc: "999", security_code: "111", guest_name: "ok" });
assert.equal(redFlat.cvv, "[redacted]", "a top-level cvv key is redacted");
assert.equal(redFlat.cvc, "[redacted]", "a top-level cvc key is redacted");
assert.equal(redFlat.security_code, "[redacted]", "a security_code key is redacted");

// ---- vault: fail closed with no key (never plaintext fallback) ----
delete process.env.CARD_VAULT_KEY;
assert.equal(vault.cardVaultConfigured(), false);
assert.throws(() => vault.encryptPan(TEST_VISA), /CARD_VAULT_KEY/, "encrypt fails closed");
assert.throws(() => vault.decryptPan("v1.x.y.z"), /CARD_VAULT_KEY/, "decrypt fails closed");

// ---- vault: authenticated round-trip, unique IVs, version metadata ----
process.env.CARD_VAULT_KEY = "check-cards-test-key-not-production";
assert.equal(vault.cardVaultConfigured(), true);
const c1 = vault.encryptPan(TEST_VISA);
const c2 = vault.encryptPan(TEST_VISA);
assert.equal(vault.decryptPan(c1), TEST_VISA, "round-trip");
assert.notEqual(c1, c2, "same PAN never encrypts deterministically (fresh IV)");
assert.ok(c1.startsWith("v1."), "ciphertext carries the key/format version");
assert.ok(!c1.includes(TEST_VISA), "ciphertext never contains the plaintext PAN");
assert.ok(!Buffer.from(c1.split(".")[3], "base64").toString("latin1").includes(TEST_VISA),
  "payload is not base64-of-plaintext");
// tampering must fail the GCM auth tag
const parts = c1.split(".");
const flipped = Buffer.from(parts[3], "base64");
flipped[0] ^= 0xff;
assert.throws(
  () => vault.decryptPan([parts[0], parts[1], parts[2], flipped.toString("base64")].join(".")),
  "tampered ciphertext must not decrypt",
);
assert.throws(() => vault.decryptPan("v9." + parts.slice(1).join(".")), /version/, "unknown version rejected");

// ---- vault: CVV crypto wrappers restored (D87) — same AES-256-GCM as the PAN ----
assert.equal(typeof vault.encryptCvv, "function", "encryptCvv restored — the CVV is encrypted at rest");
assert.equal(typeof vault.decryptCvv, "function", "decryptCvv restored — the reveal decrypts it");
{
  const ct = vault.encryptCvv("123");
  assert.ok(/^v1\./.test(ct), "CVV ciphertext uses the versioned vault format");
  assert.notEqual(ct, "123", "the CVV is not stored in plaintext");
  assert.equal(vault.decryptCvv(ct), "123", "encrypt→decrypt round-trips the CVV");
}
delete process.env.CARD_VAULT_KEY;

// ---- VAT setting rules ----
assert.equal(vat.parseVatRate(18), 18);
assert.equal(vat.parseVatRate("17.5"), 17.5);
assert.equal(vat.parseVatRate("17.55"), 17.55, "two decimals allowed");
assert.equal(vat.parseVatRate("17.555"), null, "three decimals rejected");
assert.equal(vat.parseVatRate(-1), null, "negative rejected");
assert.equal(vat.parseVatRate(51), null, "excessively large rejected");
assert.equal(vat.parseVatRate("abc"), null, "malformed rejected");
assert.equal(vat.parseVatRate(""), null);
assert.equal(vat.parseVatRate(null), null);
assert.equal(vat.parseVatRate(0), 0, "zero VAT is a valid configuration");
assert.equal(vat.formatVatRate(18), "18", "no trailing zeros");
assert.equal(vat.formatVatRate(17.5), "17.5");
assert.equal(vat.includedVatAmount(1180, 18), 180, "included VAT of a gross total");
assert.equal(vat.includedVatAmount(1000, 0), 0);
assert.equal(vat.DEFAULT_VAT_RATE, 18);

// ============================================================
// Source-level rules: the sensitive-data contracts hold in the real files
// ============================================================
// comments stripped — the rules are about code, not the security notes
const src = (p) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const cardActions = src("src/app/(dashboard)/reservations/card-actions.ts");
assert.ok(/requirePermission\(actor, "payments\.card_manage"\)/.test(cardActions),
  "save/delete are permission-guarded server-side");
// reveal enforces the permission server-side, but via hasPermission so a
// rejected attempt can be audited before the refusal
assert.ok(/hasPermission\(actor, "payments\.card_reveal"\)/.test(cardActions),
  "reveal is permission-guarded server-side (audited on rejection)");
assert.ok(/requirePermission\(actor, "payments\.card_charge"\)/.test(cardActions),
  "charge is a separate permission-guarded action");
assert.ok(/encryptPan\(/.test(cardActions), "PAN is encrypted before persistence");
assert.ok(/card_reveal/.test(cardActions) && /writeAudit/.test(cardActions), "reveal is audited");
assert.ok(/card_reveal_denied/.test(cardActions), "rejected reveals are also audited (success or rejected)");
assert.ok(/auditRequestContext/.test(cardActions), "reveal/charge/edit capture IP + session for the audit");
assert.ok(!/console\.(log|info|debug)/.test(cardActions), "card actions never log request data");
// D87 — CVV is persisted ENCRYPTED on the manual-entry card (owner decision).
// It rides the same guarded save/reveal, encrypted at rest, never logged.
assert.ok(/cvv_encrypted/.test(cardActions), "save/reveal touch the cvv_encrypted column");
assert.ok(/encryptCvv\(/.test(cardActions), "the CVV is encrypted before persistence");
assert.ok(/decryptCvv\(/.test(cardActions), "the CVV is decrypted only inside the audited reveal");
assert.ok(/cvvValid\(/.test(cardActions), "the stored CVV is validated (3–4 digits)");
// still NEVER logged in plaintext through a console call
assert.ok(!/console\.(log|info|debug)/.test(cardActions), "card actions never log request data (incl. CVV)");

const resActions = src("src/app/(dashboard)/reservations/actions.ts");
assert.ok(!/pan_encrypted/.test(resActions),
  "the normal reservation payload never selects the encrypted PAN");
assert.ok(!/decryptPan|decryptCvv/.test(resActions),
  "the normal read never decrypts PAN or CVV");
assert.ok(!/cvv_encrypted|has_cvv|hasCvv/.test(resActions),
  "the normal read exposes no CVV column, flag or value");
assert.ok(/last4/.test(resActions), "the normal payload carries masked metadata only");

const cardFields = src("src/components/reservations/CardFields.tsx");
assert.ok(!/saveReservationCardAction/.test(cardFields),
  "the card form never calls save directly (panels do)");
// D87 — the manual form now collects a CVV and renders it through the view model
assert.ok(/formatCvv\(/.test(cardFields), "the entry form collects a CVV (formatCvv)");
assert.ok(/view\.cvv/.test(cardFields), "the CVV is rendered from the canonical view model");
// D86 — masking now lives in the pure view model (asserted at runtime below);
// the component must render the resolved view and never a raw PAN of its own
assert.ok(/resolveCardView\(/.test(cardFields),
  "the one card section renders the canonical view model");
assert.ok(/revealReservationCardAction/.test(cardFields), "full details come from the guarded reveal action");
// a stored card is MASKED by default; the PAN + CVV appear only on the explicit
// "הצגת פרטי אשראי" click (no auto-reveal) — the hide affordance returns to mask
assert.ok(/הצגת פרטי אשראי/.test(cardFields) && /הסתרת פרטי אשראי/.test(cardFields),
  "explicit show/hide of the full card details (masked by default)");
assert.ok(!/canReveal && storedId && !revealed/.test(cardFields),
  "no auto-reveal — the stored card stays masked until the operator clicks show");
assert.ok(/clipboard\.writeText/.test(cardFields), "revealed values are copyable");

const booking = src("src/components/reservations/BookingPanel.tsx");
const editPanel = src("src/components/reservations/EditReservationPanel.tsx");
for (const [name, s] of [["BookingPanel", booking], ["EditReservationPanel", editPanel]]) {
  assert.ok(!/17\s*%|VAT_RATE|0\.17/.test(s), `${name}: no hardcoded VAT percentage`);
  assert.ok(/formatVatRate\(vatRate\)/.test(s), `${name}: VAT line reads the tenant setting`);
  assert.ok(/cvv: cc\.cvv/.test(s), `${name}: the save payload forwards the entered CVV (D87)`);
}
assert.ok(/saveReservationCardAction/.test(booking) && /setCc\(EMPTY_CARD\)/.test(booking),
  "booking saves the card via the guarded action and clears client state");

// ---- channel card ingest: encrypt PAN on ingest, NEVER a CVV, never log ----
const cardIngest = src("src/lib/channel/card-ingest.ts");
assert.ok(/encryptPan\(/.test(cardIngest), "channel PAN is encrypted immediately on ingest");
assert.ok(!/encryptCvv|cvv_encrypted/.test(cardIngest), "channel ingest NEVER stores a CVV (D52 §2)");
assert.ok(!/console\.(log|info|debug)/.test(cardIngest), "channel ingest never logs card data");
assert.ok(/source_channel/.test(cardIngest) && /provider_reservation_ref/.test(cardIngest),
  "channel + original OTA reservation reference are retained");
assert.ok(/is_virtual/.test(cardIngest), "virtual cards are stored distinctly from regular cards");

// ---- channel revision seam: PAN encrypted-staged BEFORE the payload is
// redacted; the stored payload stays redacted; NO CVV is ever staged ----
const revisions = src("src/lib/channel/revisions.ts");
assert.ok(/extractChannelCard\(/.test(revisions), "persist extracts the card from the raw payload");
assert.ok(/encryptPan\(/.test(revisions), "the PAN is encrypted before it is staged on the revision");
assert.ok(!/encryptCvv|card_cvv_encrypted/.test(revisions), "no CVV is ever staged on the revision (D52 §2)");
assert.ok(/redactPayload\(rev\.payload\)/.test(revisions),
  "the stored/logged revision payload is always redacted");
assert.ok(/card_pan_encrypted/.test(revisions) && /attachStagedCard/.test(revisions),
  "the staged encrypted card is attached to the reservation on import");
assert.ok(!/console\.(log|info|debug)/.test(revisions), "the revision seam never logs card data");

// ---- audit log captures IP + session for the immutable trail ----
const auditLib = src("src/lib/audit.ts");
assert.ok(/ip_address/.test(auditLib) && /session_info/.test(auditLib),
  "the audit log records IP address + session information");

const settingsActions = src("src/app/(dashboard)/settings/actions.ts");
assert.ok(/requirePermission\(actor, "settings\.edit"\)/.test(settingsActions),
  "VAT change requires the business-settings permission");
assert.ok(/parseVatRate/.test(settingsActions), "VAT input is validated server-side");
assert.ok(/writeAudit/.test(settingsActions), "VAT change is audited");
assert.ok(!/total_price|paid_amount|balance/.test(settingsActions),
  "changing the VAT setting never touches reservation totals");

// ============================================================
// D46: manual card entry always available; live charge fails closed behind a
// gateway seam; a SEPARATE audited action records externally-collected payments
// (never described, or executed, as a GuestHub charge).
// ============================================================
const gatewaySrc = src("src/lib/payments/gateway.ts");
assert.ok(/getPaymentGateway\(\): PaymentGateway \| null/.test(gatewaySrc),
  "gateway seam exposes getPaymentGateway(): PaymentGateway | null");
assert.ok(/if \(!provider\) return null;/.test(gatewaySrc),
  "no PSP_PROVIDER configured — getPaymentGateway returns null (fail closed)");
assert.ok(/NO_GATEWAY_MESSAGE/.test(gatewaySrc), "a no-provider message is defined for the UI/action");

// charge routes through the seam; no gateway → fails closed; with a gateway,
// success is returned ONLY on real provider evidence, landed in the ledger
assert.ok(/getPaymentGateway\(\)/.test(cardActions), "charge consults the gateway seam");
const chargeFn = cardActions.match(/chargeReservationCardAction[\s\S]*?export async function recordExternalPaymentAction/);
assert.ok(chargeFn && /if \(!gateway\) return fail\(NO_GATEWAY_MESSAGE\)/.test(chargeFn[0]),
  "charge fails closed with the no-provider message");
assert.ok(chargeFn && /if \(!result\.success\)/.test(chargeFn[0]) &&
  chargeFn[0].indexOf("success: true") > chargeFn[0].indexOf("if (!result.success)"),
  "charge returns success only after the provider approved (real evidence, D46)");
assert.ok(chargeFn && /recomputePaymentAggregates\(/.test(chargeFn[0]) && /idempotency_key/.test(chargeFn[0]),
  "a captured charge lands in the ledger idempotently and paid/balance reconcile from it");

// external-payment recorder: guarded, confirmation-gated, audited as EXTERNAL
assert.ok(/export async function recordExternalPaymentAction/.test(cardActions),
  "a separate external-payment recorder exists");
const recFn = cardActions.match(/recordExternalPaymentAction[\s\S]*?export async function deleteReservationCardAction/);
assert.ok(recFn && /requirePermission\(actor, "payments\.card_charge"\)/.test(recFn[0]),
  "recording an external payment is permission-guarded");
assert.ok(recFn && /if \(!input\.confirmed\)/.test(recFn[0]),
  "recording requires explicit staff confirmation that money was collected");
assert.ok(recFn && /INSERT INTO guesthub\.payments/.test(recFn[0]) && /reference/.test(recFn[0]),
  "the payment is recorded with amount + method + reference");
// D51/D52: paid/balance are reconciled from the LEDGER (recomputePaymentAggregates),
// never an incremental in-place add that could drift.
assert.ok(recFn && /recomputePaymentAggregates\(/.test(recFn[0]),
  "paid/balance are reconciled from the ledger inside the guarded, confirmed action");
assert.ok(recFn && /payment_external_record/.test(recFn[0]) && /recorded_external/.test(recFn[0]),
  "it is audited as an EXTERNAL record, never as a GuestHub charge");

// D77 §15 (supersedes D46 here): the card-entry AREA is always visible but
// ACTIVATES only when the selected payment method is credit card — grey +
// disabled + unfocusable otherwise, and switching away destroys the unsaved
// draft (a stored card is never touched).
assert.ok(/disabled=\{method !== "credit_card"\}/.test(booking),
  "new-reservation card entry activates only for the credit-card method");
assert.ok(/setCc\(EMPTY_CARD\)/.test(booking),
  "leaving the credit-card method clears the unsaved card draft");
const editPanelD77 = src("src/components/reservations/EditReservationPanel.tsx");
// EDIT PANEL: card entry is FULLY decoupled from the payment-method selector.
// The selector registers payments (additionalPayment + paymentMethod); the
// card section's own mode (replacingCard / the empty state) is the ONLY thing
// that opens the fields. No gate, no save-block, no draft-wipe on the method —
// the duplicated "switch the method above to unlock the card form" flow is gone.
assert.ok(!/method !== "credit_card"/.test(editPanelD77),
  "edit panel: ZERO payment-method coupling — no entry gate, no save gate, no draft-clear effect");
const editCardJsx = editPanelD77.match(/<CardFields[\s\S]*?\/>/);
assert.ok(editCardJsx && !/\bdisabled=/.test(editCardJsx[0]),
  "edit panel passes NO disabled prop to CardFields — the fields are never method-locked");
assert.ok(/manualEntry=\{replacingCard\}/.test(editPanelD77),
  "manual-entry mode is driven solely by the card section's replacingCard state");
assert.ok(/disabled=\{cardBusy \|\| ccStateForSave !== "valid"\}/.test(editPanelD77),
  "the card save button is gated ONLY on validation + save state");
assert.ok(/שמירת כרטיס/.test(editPanelD77),
  "manual mode offers the שמירת כרטיס action");
// A background realtime reload (useRealtimeEvent → loadDetail without force)
// must NOT snap the operator out of manual mode: an empty manual draft is not
// "dirty", so the reload proceeds — and used to reset replacingCard, visibly
// reverting the section to the imported card right after the click.
assert.ok(/if \(opts\?\.force\) setReplacingCard\(false\)/.test(editPanelD77),
  "card-entry mode is reset ONLY on explicit (forced) loads — background refreshes preserve it");
assert.ok(!/^\s*setReplacingCard\(false\);\s*$/m.test(
    editPanelD77.slice(editPanelD77.indexOf("const loadDetail"), editPanelD77.indexOf("useEffect")),
  ),
  "no unconditional replacingCard reset remains inside loadDetail");
// Manual mode is scoped to ONE reservation editing session. The identity
// effect must reset the mode + the sensitive draft SYNCHRONOUSLY, BEFORE the
// null-id early return — so it runs on open, on switching reservations AND on
// close, regardless of whether any async response ever lands. (The async
// force-load reset alone proved lossy: a dropped load left the stale mode for
// the next realtime reload to paint as the initial view of ANOTHER reservation.)
assert.ok(
  /useEffect\(\(\) => \{\s*setReplacingCard\(false\);\s*setCc\(EMPTY_CARD\);\s*if \(!reservationId\)[\s\S]*?\[reservationId, loadDetail\]\);/.test(
    editPanelD77,
  ),
  "replacingCard + the manual draft reset synchronously on EVERY reservation-identity change (open / switch / close)");
// …while a SAME-reservation realtime refresh never touches the mode
const rtBlock = editPanelD77.match(/useRealtimeEvent\(\(event\) => \{[\s\S]*?\}\);/);
assert.ok(rtBlock, "the panel subscribes to same-reservation realtime events");
assert.ok(!/setReplacingCard/.test(rtBlock[0]),
  "a same-reservation realtime refresh never resets the card-entry mode");
assert.ok(!/force/.test(rtBlock[0]),
  "the realtime reload is a background (non-forced) load — it preserves the operator's mode");
// the footer actions are driven by the ONE explicit mode, not ad-hoc booleans
assert.ok(/const mode = resolveCardMode\(\{ stored, channel, manualEntry, externalSource \}\)/.test(cardFields),
  "CardFields derives the explicit CardMode from the one resolver (incl. the external flag)");
assert.ok(/\{\(mode === "existing" \|\| mode === "external_unavailable"\) && canManage && onToggleManual &&/.test(cardFields),
  "the initial external views (existing card/guarantee OR unavailable) offer ONLY the manual-entry opt-in");
assert.ok(/\{mode === "manual" && \(stored \|\| channel \|\| externalSource\) && onToggleManual &&/.test(cardFields),
  "the return action renders ONLY in explicit manual mode, and only when a previous state exists to return to");
// the edit panel wires the external flag from the canonical channel mapping +
// the OTA linkage, and gates the save row on the TWO editable modes only
assert.ok(/externalSource=\{externalReservation\}/.test(editPanelD77),
  "the edit panel passes the external-reservation flag into the card section");
assert.ok(/Boolean\(detail\?\.ota\) \|\| normalizeVisibleChannel\(detailSource\?\.key \?\? null\) !== null/.test(editPanelD77),
  "externality derives from the OTA linkage + the ONE canonical channel mapping (no parallel source list)");
assert.ok(/canManageCard && \(cardMode === "manual" \|\| cardMode === "fresh"\)/.test(editPanelD77),
  "the card-save action is reachable only from the two EDITABLE modes — never from a read-only external state");
// During explicit manual card entry, the payment-ADJUSTMENT row (method /
// additional payment / discount) is HIDDEN — removed from render, not merely
// disabled — so two payment interfaces never stack. Its values live in panel
// state and return intact when manual mode ends.
assert.ok(/\{canEditNow && !replacingCard && \([\s\S]{0,200}אמצעי תשלום/.test(editPanelD77),
  "the payment-adjustment row renders only while manual card entry is OFF");
assert.ok(!/disabled=\{replacingCard/.test(editPanelD77),
  "the row is hidden, never disabled-in-place, during manual card entry");
assert.ok(/bw-ccbox-off/.test(src("src/components/reservations/CardFields.tsx")),
  "the deactivated card area renders visibly grey/disabled (new-reservation flow)");
// The manual fields lock ONLY on entryOff (view.editable && disabled) — i.e. the
// fresh-entry grey-out — never on read-only/imported state. So once the panel
// lifts the gate, an editable (manual) view is fully writable.
assert.ok(/const entryOff = view\.editable && disabled;/.test(cardFields),
  "CardFields: the fieldset disable derives ONLY from the editable-entry grey-out");
assert.ok(/<fieldset disabled=\{entryOff\}/.test(cardFields),
  "CardFields: the parent fieldset is disabled solely by entryOff, nothing else");
assert.ok(/readOnly=\{ro\}/.test(cardFields) && /const ro = !view\.editable;/.test(cardFields),
  "CardFields: read-only styling tracks !editable, independent of the entry grey-out");
// the required back-to-existing action must be present verbatim (spec label)
assert.ok(/חזרה לפרטי הכרטיס הקיימים/.test(cardFields),
  "manual mode offers 'חזרה לפרטי הכרטיס הקיימים' to restore the imported/stored card");

// StoredCardBox: live charge visible-but-disabled + no-provider text; the
// external-payment recorder is confirmation-gated
assert.ok(/const NO_GATEWAY_MESSAGE = "לא מוגדר ספק סליקה פעיל"/.test(cardFields),
  "the no-provider message is shown by the charge control");
assert.ok(/disabled\s+onClick={charge}/.test(cardFields),
  "the live-charge button is rendered disabled");
assert.ok(/recordExternalPaymentAction/.test(cardFields) && /רישום תשלום שבוצע חיצונית/.test(cardFields),
  "the saved-card box offers the honestly-labelled external-payment recorder");
assert.ok(/confirmed: true/.test(cardFields) && /payConfirm/.test(cardFields),
  "recording requires an explicit in-UI confirmation step");

// ============================================================
// D47: the one-character input bug. The side-panel shell must NOT re-run its
// key/focus effect on every render — owners pass a fresh onClose closure each
// render, so listing it in the deps made panelRef.focus() steal focus off the
// field after a single keystroke. The effect must depend on [open] alone and
// read the latest onClose from a ref.
// ============================================================
const sidePanel = src("src/components/ui/SidePanel.tsx");
assert.ok(/onCloseRef\.current = onClose/.test(sidePanel),
  "SidePanel keeps the latest onClose in a ref (stable dep)");
assert.ok(/\},\s*\[open\]\);/.test(sidePanel),
  "the SidePanel key/focus effect depends on [open] alone");
assert.ok(!/\[open,\s*onClose\]/.test(sidePanel),
  "onClose is NOT an effect dep — it would re-run focus() and steal focus every keystroke");
assert.ok(/panelRef\.current\?\.focus\(\)/.test(sidePanel),
  "the panel still receives focus on open (focus trap / a11y preserved)");

// D47: card inputs stay strings with numeric keyboards, patched via a FUNCTIONAL
// updater so a keystroke can never clobber the previous draft.
assert.ok(!/type="number"/.test(cardFields),
  "no card field uses type=number");
assert.ok(/onChange: \(updater: \(prev: CardDraft\) => CardDraft\) => void/.test(cardFields),
  "CardFields.onChange is a functional-updater contract");
assert.ok(/onChange\(\(p\) => \(\{ \.\.\.p,/.test(cardFields),
  "card fields patch the previous draft, never a captured snapshot");
assert.ok(/number: formatCardNumber\(e\.target\.value\)/.test(cardFields),
  "PAN stays a string via formatCardNumber — never Number()/parseInt()");
for (const [name, s] of [["BookingPanel", booking], ["EditReservationPanel", editPanel]]) {
  // either the setter directly, or a functional-update wrapper (BookingPanel
  // wraps it to auto-fill the holder from the guest name) — both preserve the
  // functional-update contract, never a captured snapshot
  assert.ok(/onChange={setCc}/.test(s) || /setCc\(\(prev\) => \{/.test(s),
    `${name}: card draft uses a functional update (setter or wrapper)`);
}

// ---- ONE canonical card view model (D86) ----
// Stored card, masked channel guarantee, manual entry and the empty state all
// resolve into the SAME field set. Assert the precedence, the masking and the
// "never fabricate a missing value" rule at runtime, not by regex.
{
  const EMPTY_DRAFT = { holder: "", number: "", exp: "", cvv: "", idNum: "", billingNotes: "" };
  const DRAFT = { holder: "משה כהן", number: "4111 1111 1111 1111", exp: "05/30", cvv: "321", idNum: "123456789", billingNotes: "חיוב בצ׳ק-אין" };
  const STORED = {
    brand: "visa", last4: "4242", expMonth: 8, expYear: 2031, holderName: "רונן מ",
    source: "back_office", sourceChannel: null, isVirtual: false, availableUntil: null,
    billingNotes: null,
  };
  const CHANNEL = {
    brand: "visa", last4: "1111", expMonth: 2, expYear: 2029, holderName: "דני לוי",
    maskedDisplay: null, isVirtual: false, availableFrom: null, availableUntil: null,
  };

  // precedence: stored card outranks the channel guarantee
  const both = rules.resolveCardView({ stored: STORED, channel: CHANNEL, draft: EMPTY_DRAFT });
  assert.equal(both.origin, "stored", "a vaulted card outranks the masked channel guarantee");
  assert.equal(both.editable, false, "a stored card renders read-only in the canonical fields");
  assert.equal(both.number, "•••• •••• •••• 4242", "the stored PAN is MASKED by default");
  assert.equal(both.exp, "08/31", "expiry renders MM/YY — the format the manual field uses");
  assert.equal(both.idNumber, "", "the holder ID is not present until an authorized reveal");

  // an authorized reveal swaps the plaintext into the SAME fields
  const revealed = rules.resolveCardView({
    stored: STORED, draft: EMPTY_DRAFT,
    revealed: { pan: "4242424242424242", holderName: "רונן מ", holderIdNumber: "123456789", expMonth: 8, expYear: 2031, cvv: "737" },
  });
  assert.equal(revealed.number, "4242 4242 4242 4242", "reveal shows the full PAN in the number field");
  assert.equal(revealed.idNumber, "123456789", "reveal fills the ID field");
  assert.equal(revealed.cvv, "737", "reveal fills the CVV field (D87)");
  assert.equal(revealed.editable, false, "a revealed card is still not an editable form");

  // channel guarantee → the canonical fields, with the REAL source (never back-office)
  const ch = rules.resolveCardView({
    channel: CHANNEL, channelName: "Booking.com", stateLabel: "כרטיס ממוסך בלבד", draft: EMPTY_DRAFT,
  });
  assert.equal(ch.origin, "channel");
  assert.equal(ch.holder, "דני לוי", "the imported cardholder fills שם בעל הכרטיס");
  assert.equal(ch.number, "•••• •••• •••• 1111", "the imported last4 fills מספר כרטיס, masked");
  assert.equal(ch.exp, "02/29", "the imported expiry fills תוקף");
  assert.ok(/Booking\.com/.test(ch.sourceLabel), "מקור פרטי הכרטיס names the REAL origin");
  assert.ok(!/back_office|משרד/.test(ch.sourceLabel), "an imported card is never labelled back-office");
  assert.equal(ch.idNumber, "", "no channel supplies a cardholder ID — the field stays empty");
  assert.ok(/התקבלו מ־Booking\.com/.test(ch.helper), "an honest origin line, inside the same section");
  assert.equal(ch.brandLabel, "Visa", "a channel brand CODE (VI) displays as the brand name");
  const amex = rules.resolveCardView({ channel: { ...CHANNEL, brand: "AX" }, draft: EMPTY_DRAFT });
  assert.equal(amex.brandLabel, "American Express", "AX → American Express");
  const unknownBrand = rules.resolveCardView({ channel: { ...CHANNEL, brand: "ZZ" }, draft: EMPTY_DRAFT });
  assert.equal(unknownBrand.brandLabel, "ZZ", "an unknown brand code shows verbatim — never a wrong brand");

  // partial channel data: only brand + last4 → the rest stays EMPTY, never invented
  const partial = rules.resolveCardView({
    channel: { ...CHANNEL, holderName: null, expMonth: null, expYear: null },
    channelName: "Booking.com", draft: EMPTY_DRAFT,
  });
  assert.equal(partial.number, "•••• •••• •••• 1111", "the masked number still renders");
  assert.equal(partial.holder, "", "a missing cardholder stays empty");
  assert.equal(partial.exp, "", "a missing expiry stays empty — never fabricated");
  assert.ok(/חלקית/.test(partial.helper), "partial imported data says so honestly");
  assert.ok(!/\d{13,}/.test(partial.number.replace(/\D/g, "")),
    "masked fragments are never padded into a full card number");

  // ---- the explicit CardMode model:
  //      manual > stored > guarantee > external-unavailable > fresh ----
  assert.equal(rules.resolveCardMode({ stored: STORED, channel: CHANNEL, manualEntry: true }), "manual",
    "manual replacement OUTRANKS the stored card AND the imported guarantee");
  assert.equal(rules.resolveCardMode({ channel: CHANNEL, manualEntry: true }), "manual",
    "manual replacement outranks the imported Booking.com guarantee");
  assert.equal(rules.resolveCardMode({ stored: STORED, channel: CHANNEL }), "existing");
  assert.equal(rules.resolveCardMode({ channel: CHANNEL }), "existing",
    "guarantee-only reservations are the read-only existing mode");
  assert.equal(rules.resolveCardMode({}), "fresh",
    "no card + no guarantee + internal source = direct manual entry, no unlock step");
  // an external reservation NEVER falls through to the editable fresh form
  assert.equal(rules.resolveCardMode({ externalSource: true }), "external_unavailable",
    "an OTA/external reservation without usable card data is NOT fresh manual entry");
  assert.equal(rules.resolveCardMode({ externalSource: true, manualEntry: true }), "manual",
    "explicit manual replacement outranks the external-unavailable state");
  assert.equal(rules.resolveCardMode({ stored: STORED, externalSource: true }), "existing",
    "a stored card outranks the external-unavailable state");
  assert.equal(rules.resolveCardMode({ channel: CHANNEL, externalSource: true }), "existing",
    "an imported guarantee outranks the external-unavailable state");

  // the external-unavailable VIEW: read-only, nothing fabricated, honest text
  const unavailable = rules.resolveCardView({
    externalSource: true, channelName: "Booking.com", stateLabel: "בערוץ", draft: EMPTY_DRAFT,
  });
  assert.equal(unavailable.editable, false,
    "external-unavailable is READ-ONLY — never an automatically-open manual form");
  assert.equal(unavailable.holder, "", "no cardholder is fabricated");
  assert.equal(unavailable.number, "", "no card number is fabricated");
  assert.equal(unavailable.exp, "", "no expiry is fabricated");
  assert.equal(unavailable.idNumber, "", "no holder ID is fabricated");
  assert.ok(/ערוץ חיצוני · Booking\.com/.test(unavailable.sourceLabel),
    "the source line names the external channel");
  assert.ok(/לא התקבלו מהערוץ פרטי כרטיס זמינים/.test(unavailable.helper),
    "the honest 'no usable card fields were received' message is shown");
  // …and the explicit opt-in from that state is a CLEAN editable draft
  const manualFromUnavailable = rules.resolveCardView({
    externalSource: true, manualEntry: true, channelName: "Booking.com", draft: EMPTY_DRAFT,
  });
  assert.equal(manualFromUnavailable.editable, true, "opt-in manual entry is fully editable");
  assert.equal(manualFromUnavailable.holder, "", "the manual draft starts blank");
  assert.equal(manualFromUnavailable.number, "", "the manual draft starts blank");

  // manual opt-in wins over both, and the empty state is the editable draft
  const manual = rules.resolveCardView({ stored: STORED, channel: CHANNEL, draft: DRAFT, manualEntry: true });
  assert.equal(manual.origin, "manual");
  assert.equal(manual.editable, true, "manual entry is the ONLY editable mode");
  assert.equal(manual.number, DRAFT.number, "the manual draft owns its own value");
  assert.equal(manual.sourceLabel, "", "the editable mode carries no source label (the source field was removed from the UI; value defaults to back_office)");
  // entering manual mode with a CLEAN draft: the editable inputs start BLANK —
  // the masked OTA/stored values are never copied into the manual form
  const manualClean = rules.resolveCardView({ stored: STORED, channel: CHANNEL, draft: EMPTY_DRAFT, manualEntry: true });
  assert.equal(manualClean.editable, true, "clean manual mode is editable immediately");
  assert.equal(manualClean.holder, "", "the imported holder is not copied into the manual input");
  assert.equal(manualClean.number, "", "the masked PAN is not copied into the manual input");
  assert.equal(manualClean.exp, "", "the imported expiry is not copied into the manual input");
  const empty = rules.resolveCardView({ draft: EMPTY_DRAFT });
  assert.equal(empty.origin, "empty");
  assert.equal(empty.editable, true, "the empty state is the normal entry form");
  assert.equal(empty.number, "", "nothing is invented out of nothing");

  // D87 — the view model carries a cvv field in every mode: the manual draft's
  // value when editable, the revealed value on a stored card, and "" for a
  // read-only card with nothing revealed (a channel guarantee never has one).
  assert.equal(manual.cvv, "321", "the manual draft owns its CVV value");
  assert.equal(ch.cvv, "", "a channel guarantee never carries a CVV");
  assert.equal(both.cvv, "", "a stored card shows no CVV until the audited reveal");
  for (const v of [both, revealed, ch, partial, manual, empty, unavailable, manualFromUnavailable]) {
    assert.equal(typeof v.cvv, "string", "every view mode exposes a string cvv field");
  }
}

// exactly ONE credit-card interface: the editor must not re-grow a second one
assert.ok(!/StoredCardBox/.test(editPanel) && !/StoredCardBox/.test(cardFields),
  "the separate stored-card box is gone — one card section only (D86)");
assert.ok((editPanel.match(/<CardFields/g) ?? []).length === 1,
  "the editor renders the card section exactly once");
assert.ok(!/כרטיס ערבות/.test(editPanel),
  "the duplicate OTA card summary (brand/last4/expiry/holder) no longer exists");
// the card BOX class belongs to the card section alone — non-card metadata uses
// .bw-metabox, so a second card interface cannot re-grow by reusing the styling
assert.ok(!/bw-ccbox/.test(editPanel),
  "the editor never hand-rolls a card box — only <CardFields> owns .bw-ccbox");
assert.ok((cardFields.match(/className={`bw-ccbox/g) ?? []).length === 1,
  "CardFields renders exactly one .bw-ccbox");

console.log("check-cards: all card/VAT security and validation rules hold ✔");
