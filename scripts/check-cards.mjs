// Runnable checks for the protected card storage + tenant VAT setting (D41).
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
  `pnpm exec tsc src/lib/card-rules.ts src/lib/card-vault.ts src/lib/vat.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
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
assert.ok(/requirePermission\(actor, "payments\.card_reveal"\)/.test(cardActions),
  "reveal is permission-guarded server-side");
assert.ok(!/cvv/i.test(cardActions), "CVV has no field anywhere in the card actions");
assert.ok(/encryptPan\(/.test(cardActions), "PAN is encrypted before persistence");
assert.ok(/card_reveal/.test(cardActions) && /writeAudit/.test(cardActions), "reveal is audited");
assert.ok(!/console\.(log|info|debug)/.test(cardActions), "card actions never log request data");

const resActions = src("src/app/(dashboard)/reservations/actions.ts");
assert.ok(!/pan_encrypted/.test(resActions),
  "the normal reservation payload never selects the encrypted PAN");
assert.ok(/last4/.test(resActions), "the normal payload carries masked metadata only");

const cardFields = src("src/components/reservations/CardFields.tsx");
assert.ok(!/cvv/i.test(cardFields), "the card form collects no CVV at all");
assert.ok(/maskedPan/.test(cardFields), "the saved card renders masked by default");
assert.ok(/revealReservationCardAction/.test(cardFields), "full number requires the explicit reveal action");
assert.ok(/REVEAL_TIMEOUT_MS/.test(cardFields), "revealed number auto-masks after inactivity");

const booking = src("src/components/reservations/BookingPanel.tsx");
const editPanel = src("src/components/reservations/EditReservationPanel.tsx");
for (const [name, s] of [["BookingPanel", booking], ["EditReservationPanel", editPanel]]) {
  assert.ok(!/17\s*%|VAT_RATE|0\.17/.test(s), `${name}: no hardcoded VAT percentage`);
  assert.ok(/formatVatRate\(vatRate\)/.test(s), `${name}: VAT line reads the tenant setting`);
  assert.ok(!/cvv/i.test(s), `${name}: no CVV anywhere`);
}
assert.ok(/saveReservationCardAction/.test(booking) && /setCc\(EMPTY_CARD\)/.test(booking),
  "booking saves the card via the guarded action and clears client state");

const settingsActions = src("src/app/(dashboard)/settings/actions.ts");
assert.ok(/requirePermission\(actor, "settings\.edit"\)/.test(settingsActions),
  "VAT change requires the business-settings permission");
assert.ok(/parseVatRate/.test(settingsActions), "VAT input is validated server-side");
assert.ok(/writeAudit/.test(settingsActions), "VAT change is audited");
assert.ok(!/total_price|paid_amount|balance/.test(settingsActions),
  "changing the VAT setting never touches reservation totals");

console.log("check-cards: all card/VAT security and validation rules hold ✔");
