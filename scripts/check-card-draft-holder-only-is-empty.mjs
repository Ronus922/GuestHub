#!/usr/bin/env node
// ============================================================
// check:card-draft-holder-only-is-empty — a card draft that carries NOTHING
// but an auto-filled holder name is "empty", never "invalid".
//
// THE DEFECT (P0, production). BookingPanel auto-fills שם בעל הכרטיס from the
// guest's name the moment step 0 is typed:
//
//   useEffect(() => {
//     if (holderTouched.current) return;
//     setCc((p) => (p.holder === guestFullName ? p : { ...p, holder: guestFullName }));
//   }, [guestFullName]);
//
// cardDraftState() used to return "empty" only when EVERY field — holder
// included — was blank. So the auto-fill alone pushed the draft past the empty
// gate, into a validation it could never satisfy (no PAN, no expiry) → "invalid"
// → handleCreate() aborted with "פרטי הכרטיס אינם תקינים — השלימו אותם או נקו
// את השדות" for EVERY payment method, cash included. The card box only renders
// while אמצעי תשלום = כרטיס אשראי, so the operator could not clear the fields
// the toast told them to clear: no reservation could be created at all.
//
// THE RULE. Only fields an operator actually typed AS A CARD — number / exp /
// cvv / idNum — take a draft out of "empty". holder is derived state, so it can
// never, on its own, arm a validation. Nothing else is relaxed: "valid" still
// demands holder ≥ 2 chars, a Luhn-valid PAN and a future expiry, and every
// partially-typed card still blocks the save.
//
// BEHAVIORAL, not textual: the real cardDraftState() body is lifted out of the
// shipped component, transpiled, and executed against the real card-rules
// module compiled from this tree. Check 4 re-runs the SAME cases against a
// mutant with holder restored to the emptiness test and requires them to fail —
// so check 1 can never pass vacuously.
//
// Static only: no DB, no network, no browser.
// Usage: node scripts/check-card-draft-holder-only-is-empty.mjs
// ============================================================
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const CARD_FIELDS = "src/components/reservations/CardFields.tsx";
const cardFields = read(CARD_FIELDS);
const bookPanel = read("src/components/reservations/BookingPanel.tsx");

// ---- the real rules module, compiled from THIS tree ----
const out = mkdtempSync(join(tmpdir(), "card-draft-"));
execFileSync(
  "pnpm",
  ["exec", "tsc", "src/lib/card-rules.ts", "--outDir", out,
   "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node10", "--skipLibCheck"],
  { cwd: ROOT, stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const rules = require(join(out, "card-rules.js"));
const ts = require("typescript");

// ---- lift cardDraftState() out of the component and make it callable ----
// The component itself cannot be imported here (JSX + server actions + the
// whole Next graph), but its predicate is pure — so the exact shipped source of
// the function is extracted, type-erased and closed over the real rules.
const extractFn = (src, name) => {
  const at = src.indexOf(`export function ${name}`);
  assert.notEqual(at, -1, `${CARD_FIELDS} must export ${name}()`);
  if (at === -1) return null;
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  assert.fail(`${name}() body is unbalanced — extraction failed`);
  return null;
};

const compile = (tsSource) => {
  const js = ts.transpileModule(tsSource.replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(
    "normalizePan", "parseExpiry", "panValid", "expiryInPast", "cvvValid",
    `${js}\nreturn cardDraftState;`,
  )(rules.normalizePan, rules.parseExpiry, rules.panValid, rules.expiryInPast, rules.cvvValid);
};

const fnSource = extractFn(cardFields, "cardDraftState");
assert.match(fnSource ?? "", /return ok \? "valid" : "invalid";/, "the extracted body must be the real predicate");
const cardDraftState = compile(fnSource);

// ---- fixtures ----
const TEST_VISA = "4111 1111 1111 1111"; // industry test PAN, Luhn-valid
const HOLDER = "ישראל ישראלי";
// The spec fixture is the literal "12/30". Assert it is still a FUTURE expiry
// so this guard fails loudly with an actionable message rather than mysteriously
// once 2030 passes.
assert.equal(rules.expiryInPast(12, 2030, new Date()), false,
  'fixture "12/30" has expired — bump the expiry fixtures in this guard');
const FUTURE = `12/${String((new Date().getFullYear() + 4) % 100).padStart(2, "0")}`;
const draft = (o) => ({ holder: "", number: "", exp: "", cvv: "", idNum: "", source: "back_office", billingNotes: "", ...o });

// The five spec cases, plus the auto-fill sequence they exist for.
const CASES = [
  ["holder-only (auto-filled from the guest name) is EMPTY — the P0",
    draft({ holder: HOLDER }), "empty"],
  ["a completely blank draft is EMPTY",
    draft({}), "empty"],
  ["holder + Luhn-valid PAN + future expiry is VALID",
    draft({ holder: HOLDER, number: TEST_VISA, exp: "12/30", cvv: "123", idNum: "123456789" }), "valid"],
  ["a partially typed PAN is INVALID — partial entry still blocks the save",
    draft({ holder: HOLDER, number: "4111" }), "invalid"],
  ["a one-character holder on a full card is INVALID — holder ≥ 2 still required",
    draft({ holder: "א", number: TEST_VISA, exp: "12/30" }), "invalid"],
  // nothing else was relaxed:
  ["holder + future expiry with NO number is INVALID (exp is real card input)",
    draft({ holder: HOLDER, exp: FUTURE }), "invalid"],
  ["holder + cvv with no card is INVALID (cvv is real card input)",
    draft({ holder: HOLDER, cvv: "123" }), "invalid"],
  ["holder + id number with no card is INVALID (idNum is real card input)",
    draft({ holder: HOLDER, idNum: "123456789" }), "invalid"],
  ["a full card with a PAST expiry is INVALID",
    draft({ holder: HOLDER, number: TEST_VISA, exp: "01/20" }), "invalid"],
  ["a full card with a bad Luhn checksum is INVALID",
    draft({ holder: HOLDER, number: "4111 1111 1111 1112", exp: FUTURE }), "invalid"],
  ["a full card with a malformed cvv is INVALID",
    draft({ holder: HOLDER, number: TEST_VISA, exp: FUTURE, cvv: "12" }), "invalid"],
  ["a full card with a malformed id number is INVALID",
    draft({ holder: HOLDER, number: TEST_VISA, exp: FUTURE, idNum: "1234" }), "invalid"],
  ["a full card with NO holder is INVALID — a card is never saved unnamed",
    draft({ number: TEST_VISA, exp: FUTURE }), "invalid"],
  ["source / billingNotes alone never make a draft non-empty",
    draft({ source: "guest_portal", billingNotes: "לחייב בצ׳ק-אין" }), "empty"],
];

// ---- 1. the predicate, executed ----
for (const [msg, value, want] of CASES) {
  assert.equal(cardDraftState(value), want, msg);
}
ok(`cardDraftState() executed on ${CASES.length} drafts — holder-only is "empty", every partial card still "invalid"`);

// ---- 2. the exact production sequence that was dead ----
// step 0 types a guest name → the auto-fill effect writes holder → אמצעי תשלום
// stays מזומן → handleCreate() must NOT see "invalid".
{
  let cc = draft({});
  const holderTouched = false; // the operator never edited the holder field
  const guestFullName = `${"ישראל"} ${"ישראלי"}`.trim();
  if (!holderTouched) cc = { ...cc, holder: guestFullName }; // the effect, verbatim in behaviour
  const ccState = cardDraftState(cc); // canSaveCard === true — the permitted operator
  assert.notEqual(ccState, "invalid",
    'the cash-payment create flow must not land in "invalid" — that was the P0 deadlock');
  assert.equal(ccState, "empty", "no card was typed, so nothing is saved and nothing blocks");
  ok('create flow: guest name → auto-filled holder → מזומן ends "empty" — "צור הזמנה" is not blocked');
}

// ---- 3. the coupling this rule protects is still the one in the panel ----
{
  assert.match(bookPanel, /if \(holderTouched\.current\) return;[\s\S]{0,200}holder: guestFullName/,
    "BookingPanel still auto-fills the holder from the guest name — the reason for this rule");
  assert.match(bookPanel, /if \(ccState === "invalid"\)/,
    'creation is still gated on ccState === "invalid" (the toast path this guard keeps unreachable)');
  assert.match(bookPanel, /ccState === "valid"/,
    "the card is still saved only from a fully valid draft");
  ok("the panel coupling is intact: auto-filled holder, create blocked only by \"invalid\", card saved only when \"valid\"");
}

// ---- 4. CANARY: the same cases, run against the pre-fix predicate ----
// Restore holder to the emptiness test and require check 1's holder-only cases
// to break. A guard that cannot fail is not a guard.
{
  const mutated = fnSource.replace(
    /if \(([\s\S]*?)\) return "empty";/,
    'if (!c.holder.trim() && $1) return "empty";',
  );
  assert.notEqual(mutated, fnSource, "the canary mutation must actually change the predicate");
  const mutant = compile(mutated);
  assert.equal(mutant(draft({ holder: HOLDER })), "invalid",
    "canary: with holder back in the emptiness test, a holder-only draft is the old P0 'invalid'");
  assert.equal(mutant(draft({})), "empty", "canary: a blank draft stays empty either way");
  const broken = CASES.filter(([, value, want]) => mutant(value) !== want);
  assert.ok(broken.length > 0,
    "canary: the pre-fix predicate must FAIL at least one asserted case, otherwise check 1 proves nothing");
  ok(`canary: the pre-fix predicate breaks ${broken.length} of the ${CASES.length} asserted cases `
     + `(first: ${broken[0]?.[0]})`);
}

console.log(`\ncheck:card-draft-holder-only-is-empty PASSED (${n} checks)`);
