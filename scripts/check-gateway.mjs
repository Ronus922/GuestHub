// Runnable checks for the PSP clearing seam (Cardcom/Tranzila, direct API).
// Asserts, at the source level, the invariants that make direct clearing safe:
//   * providers allow-list is EXACTLY cardcom+tranzila (mirrors migration 051,
//     owner decision: no Stripe);
//   * no/partial env config → getPaymentGateway() null → charge fails closed;
//   * adapters: success only on the provider's documented approval evidence
//     (Cardcom ResponseCode 0 + transaction id / Tranzila Response=000), a
//     network timeout is bounded, failures fail closed, nothing is console-logged,
//     and no PAN/CVV/token is ever interpolated into an error/log string;
//   * the charge action fails closed without a gateway, returns success only on
//     real provider evidence, and lands captures in the ledger idempotently.
// Usage: node scripts/check-gateway.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const gateway = src("src/lib/payments/gateway.ts");
const cardcom = src("src/lib/payments/providers/cardcom.ts");
const tranzila = src("src/lib/payments/providers/tranzila.ts");
const cardActions = src("src/app/(dashboard)/reservations/card-actions.ts");
const manifest = src("db/migrations/manifest.txt");
const migration = src("db/migrations/051_psp_readiness.sql");
const pkg = JSON.parse(src("package.json"));

// ---- seam: allow-list + env-keyed, fail-closed resolution ----
assert.ok(/PSP_PROVIDERS = \["cardcom", "tranzila"\] as const/.test(gateway),
  "provider allow-list is exactly cardcom+tranzila (no Stripe — owner decision)");
assert.ok(/if \(!provider\) return null;/.test(gateway),
  "no PSP_PROVIDER → null gateway → every charge fails closed");
assert.ok(/return misconfigured\(provider\)/.test(gateway),
  "partial/unknown provider config resolves to null, never guessed credentials");
assert.ok(/CARDCOM_TERMINAL/.test(gateway) && /CARDCOM_API_NAME/.test(gateway) &&
  /TRANZILA_TERMINAL/.test(gateway) && /TRANZILA_PASSWORD/.test(gateway),
  "credential env-var names are declared in the seam");

// ---- adapters: evidence-only success, fail-closed, no sensitive leakage ----
for (const [name, code] of [["cardcom", cardcom], ["tranzila", tranzila]]) {
  assert.ok(!/console\./.test(code), `${name}: never writes to the console`);
  assert.ok(!/\$\{(req\.)?(pan|cvv|ccno|providerRef|token)\b/i.test(code),
    `${name}: PAN/CVV/token are never interpolated into strings`);
  assert.ok(/AbortSignal\.timeout\(/.test(code), `${name}: provider call is time-bounded`);
  assert.ok(/success: false, error:/.test(code), `${name}: failures fail closed with an error`);
  assert.ok(/req\.currency !== "ILS"/.test(code), `${name}: ILS-only guard present`);
  assert.ok(/⚠️ UNVERIFIED WIRE FORMAT/.test(code),
    `${name}: carries the sandbox-verification warning until tested against a real terminal`);
}
assert.ok(/ResponseCode === 0 && json\.TranzactionId != null/.test(cardcom),
  "cardcom: success ONLY on ResponseCode 0 with a transaction id");
assert.ok(/out\.Response === "000"/.test(tranzila),
  "tranzila: success ONLY on Response=000");
assert.ok(/if \(!cfg\.password\)/.test(tranzila),
  "tranzila: token charge without TranzilaPW fails closed with a config error");

// ---- charge action: fail-closed + evidence-only + idempotent ledger ----
assert.ok(/if \(!gateway\) return fail\(NO_GATEWAY_MESSAGE\)/.test(cardActions),
  "charge action fails closed when no gateway is configured");
assert.ok(/if \(!result\.success\)/.test(cardActions),
  "charge action gates success on the provider result");
assert.ok(/psp:\$\{gateway\.id\}/.test(cardActions),
  "ledger idempotency key is derived from the provider transaction id");
assert.ok(/crypto\.randomUUID\(\)/.test(cardActions),
  "PSP-side reference is unique per attempt (double-submit cannot double-charge)");

// ---- DB + wiring ----
assert.ok(/^051_psp_readiness\.sql$/m.test(manifest), "migration 051 is registered in the manifest");
assert.ok(/CHECK \(provider IN \('cardcom', 'tranzila'\)\)/.test(migration),
  "DB allow-list mirrors the code allow-list");
assert.ok(/status IN \('active', 'expired', 'revoked'\)/.test(migration),
  "token lifecycle status exists");
assert.equal(pkg.scripts["check:gateway"], "node scripts/check-gateway.mjs",
  "check:gateway is wired into package.json");

console.log("check-gateway: PSP seam, adapters and charge path hold ✔");
