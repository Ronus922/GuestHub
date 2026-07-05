// Runnable checks for the protected card storage + tenant VAT setting (D41/D42).
// D42 adds: CVV collected only for charge and NEVER stored/encrypted/logged;
// channel card data encrypted on ingest yet still redacted from logs; a separate
// charge permission; reveal audits success AND rejection with IP + session.
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

// ---- CVV rules (shape only; the value is stored ENCRYPTED, never plaintext) ----
assert.equal(rules.cvvValid("123"), true);
assert.equal(rules.cvvValid("1234"), true, "4-digit amex CVV allowed");
assert.equal(rules.cvvValid("12"), false, "2 digits rejected");
assert.equal(rules.cvvValid("12a"), false, "non-digits rejected");
assert.equal(rules.formatCvv("1a2b3c4d5"), "1234", "formatCvv keeps ≤4 digits");
assert.equal(rules.maskedCvv(), "•••", "default CVV display is masked");
assert.ok(!rules.MANUAL_CARD_SOURCES.includes("channel"), "manual entry can never set source=channel");

// ---- channel card extraction (pure; runs on RAW payload; carries CVV for the
// ingest to ENCRYPT — never persisted plaintext) ----
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
assert.equal(vc.cvv, "123", "channel CVV is extracted so the ingest can encrypt it");
assert.equal(payloads.extractChannelCard({ guest: { name: "x" } }), null, "no card data → null (not an empty stub)");
// even after extraction, the STORED/LOGGED revision payload stays redacted
const red = payloads.redactPayload({ credit_card: { card_number: "4111111111111111", cvv: "123" }, guest_name: "ok" });
assert.equal(red.credit_card, "[redacted]", "card object still redacted from logs/persistence");
assert.equal(red.guest_name, "ok", "non-card fields survive redaction");

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

// ---- vault: CVV round-trips through the SAME authenticated envelope ----
const cvvCipher = vault.encryptCvv("123");
assert.notEqual(cvvCipher, "123", "CVV is never stored plaintext");
assert.ok(cvvCipher.startsWith("v1."), "CVV ciphertext carries the version");
assert.ok(!cvvCipher.includes("123"), "CVV ciphertext never contains the plaintext");
assert.equal(vault.decryptCvv(cvvCipher), "123", "CVV round-trip via the reveal path");
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
// CVV IS persisted now — but ONLY encrypted at rest (D43). Assert it is
// encrypted in the INSERT, decrypted only by the reveal, and that an empty
// incoming CVV never overwrites a stored one.
const cardInsert = cardActions.match(/INSERT INTO guesthub\.reservation_cards[\s\S]*?RETURNING/);
assert.ok(cardInsert && /cvv_encrypted/.test(cardInsert[0]), "CVV is stored in the encrypted column");
assert.ok(/encryptCvv\(/.test(cardActions), "CVV is encrypted before persistence");
assert.ok(/decryptCvv\(/.test(cardActions), "the reveal action decrypts the CVV for the authorized request");
assert.ok(/COALESCE\(EXCLUDED\.cvv_encrypted/.test(cardActions), "an empty incoming CVV never overwrites a stored one");
// the audit payload never carries the plaintext PAN/CVV — only masked metadata
assert.ok(!/after:\s*\{[^}]*\bcvv:\s*cvv\b/.test(cardActions), "the reveal/save audit never puts the CVV value in the payload");

const resActions = src("src/app/(dashboard)/reservations/actions.ts");
assert.ok(!/pan_encrypted/.test(resActions),
  "the normal reservation payload never selects the encrypted PAN");
assert.ok(!/decryptPan|decryptCvv/.test(resActions),
  "the normal read never decrypts PAN or CVV");
assert.ok(/cvv_encrypted IS NOT NULL/.test(resActions),
  "the normal read exposes only a has-CVV boolean, never the value");
assert.ok(/last4/.test(resActions), "the normal payload carries masked metadata only");

const cardFields = src("src/components/reservations/CardFields.tsx");
assert.ok(!/saveReservationCardAction/.test(cardFields),
  "the card form never calls save directly (panels do)");
assert.ok(/formatCvv/.test(cardFields), "the entry form collects a CVV");
assert.ok(/maskedPan/.test(cardFields) && /maskedCvv/.test(cardFields),
  "the saved card renders masked PAN and masked CVV by default");
assert.ok(/revealReservationCardAction/.test(cardFields), "full details require the explicit reveal action");
assert.ok(/הצגת פרטי אשראי/.test(cardFields) && /הסתרת פרטי אשראי/.test(cardFields),
  "explicit show/hide of the full card details");
assert.ok(/REVEAL_TIMEOUT_MS/.test(cardFields), "revealed details auto-mask after inactivity");
assert.ok(/clipboard\.writeText/.test(cardFields), "revealed values are copyable");

const booking = src("src/components/reservations/BookingPanel.tsx");
const editPanel = src("src/components/reservations/EditReservationPanel.tsx");
for (const [name, s] of [["BookingPanel", booking], ["EditReservationPanel", editPanel]]) {
  assert.ok(!/17\s*%|VAT_RATE|0\.17/.test(s), `${name}: no hardcoded VAT percentage`);
  assert.ok(/formatVatRate\(vatRate\)/.test(s), `${name}: VAT line reads the tenant setting`);
  assert.ok(/cvv: cc\.cvv/.test(s), `${name}: CVV reaches the guarded encrypted save`);
}
assert.ok(/saveReservationCardAction/.test(booking) && /setCc\(EMPTY_CARD\)/.test(booking),
  "booking saves the card via the guarded action and clears client state");

// ---- channel card ingest: encrypt PAN+CVV on ingest, never log ----
const cardIngest = src("src/lib/channel/card-ingest.ts");
assert.ok(/encryptPan\(/.test(cardIngest), "channel PAN is encrypted immediately on ingest");
assert.ok(/encryptCvv\(/.test(cardIngest), "channel CVV is encrypted immediately on ingest");
assert.ok(!/console\.(log|info|debug)/.test(cardIngest), "channel ingest never logs card data");
assert.ok(/source_channel/.test(cardIngest) && /provider_reservation_ref/.test(cardIngest),
  "channel + original OTA reservation reference are retained");
assert.ok(/is_virtual/.test(cardIngest), "virtual cards are stored distinctly from regular cards");

// ---- channel revision seam: card encrypted-staged BEFORE the payload is
// redacted; the stored payload stays redacted (no raw card in logs) ----
const revisions = src("src/lib/channel/revisions.ts");
assert.ok(/extractChannelCard\(/.test(revisions), "persist extracts the card from the raw payload");
assert.ok(/encryptPan\(/.test(revisions) && /encryptCvv\(/.test(revisions),
  "the card is encrypted before it is staged on the revision");
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
assert.ok(/return null;/.test(gatewaySrc), "no PSP wired yet — getPaymentGateway returns null");
assert.ok(/NO_GATEWAY_MESSAGE/.test(gatewaySrc), "a no-provider message is defined for the UI/action");

// charge routes through the seam and fails closed — never fabricates a success
assert.ok(/getPaymentGateway\(\)/.test(cardActions), "charge consults the gateway seam");
const chargeFn = cardActions.match(/chargeReservationCardAction[\s\S]*?export async function recordExternalPaymentAction/);
assert.ok(chargeFn && /return fail\(NO_GATEWAY_MESSAGE\)/.test(chargeFn[0]),
  "charge fails closed with the no-provider message");
assert.ok(chargeFn && !/success:\s*true/.test(chargeFn[0]),
  "charge never returns success while no gateway exists");

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
assert.ok(recFn && /UPDATE guesthub\.reservations[\s\S]*?paid_amount/.test(recFn[0]),
  "paid/balance move forward only inside the guarded, confirmed action");
assert.ok(recFn && /payment_external_record/.test(recFn[0]) && /recorded_external/.test(recFn[0]),
  "it is audited as an EXTERNAL record, never as a GuestHub charge");

// BookingPanel: manual card entry is NOT gated on the payment method (D46)
assert.ok(!/method === "credit_card"/.test(booking),
  "new-reservation card entry is no longer hidden behind method === credit_card");
assert.ok(/הוסף כרטיס אשראי/.test(booking), "an always-available add-card affordance is present");

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
  assert.ok(/onChange={setCc}/.test(s), `${name}: card draft uses the state setter directly (functional-update capable)`);
}

console.log("check-cards: all card/VAT security and validation rules hold ✔");
