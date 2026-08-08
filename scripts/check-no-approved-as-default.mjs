// check:no-approved-as-default — the paid marker must never be the import default.
//
// THE RULE (D89 + D139): the starred workflow status is what the Beds24
// importer stamps on every new OTA booking (booking-import.ts reads the star,
// creation-time only). The workflow key 'approved' IS the paid marker (D89),
// and the pay window's single exit is 'approved' (D139). Star 'approved' and
// every imported booking is born "paid" and invisible to the pay window — a
// silent failure that costs real money. setDefaultWorkflowStatusAction must
// therefore REJECT key='approved' — by key, never by UUID — before anything
// is written.
//
// HOW: the rejection block is FROZEN byte-for-byte inside the action's body,
// with comments stripped first so a commented-out rejection reads as a
// missing one. Two accomplice edits are pinned alongside it: the FOR UPDATE
// select must still fetch `key` (drop it and target.key is forever undefined
// — the check dies silently), and the rejection must precede the is_default
// write (a check after the write checks nothing).
//
// FAIL-CLOSED: if the action, the select, or the write cannot be located,
// the guard fails — a guard that cannot see its subject proves nothing.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN: the validator re-runs against
// semantic neutralizations of the REAL file that keep the structural markers
// (the function, the if, the select all remain recognizable). A validator
// that accepts any mutant is not a guard, and this run exits 1 saying so.
// Usage: node scripts/check-no-approved-as-default.mjs
import { readFileSync } from "node:fs";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✓ ${m}`);
};

const ACTIONS = "src/app/(dashboard)/settings/status-actions.ts";
const src = readFileSync(ACTIONS, "utf8");

// ---- the frozen shape ------------------------------------------------------
// Verbatim twins of the code in status-actions.ts. The duplication is the
// mechanism: none of the three can drift without editing this file too.
const REJECT = `if (target.key === "approved")
        throw new AuthorizationError(
          "סטטוס זה מסמן תשלום בפועל ואינו יכול לשמש כברירת מחדל לייבוא",
        );`;
const SELECT = "SELECT id, key, is_active FROM guesthub.lookup_items";
const WRITE = "SET metadata = jsonb_set(metadata, '{is_default}', 'true'::jsonb)";
const FN = "export async function setDefaultWorkflowStatusAction";

const occurrences = (hay, needle) => hay.split(needle).length - 1;
// block comments, then whole-line // comments — a rejection that survives
// only as documentation must not count as a rejection
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ---- the validator ---------------------------------------------------------
// Whole FILE → list of violations. Ran once on the real file, then once per
// mutant (where a clean result is itself the failure).
const validateFile = (source) => {
  const at = source.indexOf(FN);
  if (at < 0) return ["setDefaultWorkflowStatusAction not found — renamed or moved; the guard cannot see its subject"];
  const end = source.indexOf("export async function", at + 1);
  const body = stripComments(source.slice(at, end < 0 ? source.length : end));

  const errs = [];
  if (occurrences(body, SELECT) !== 1)
    errs.push("the FOR UPDATE select no longer fetches `key` — target.key is forever undefined and the rejection is dead");
  if (occurrences(body, REJECT) !== 1)
    errs.push("the approved rejection block is missing or altered (it is frozen byte-for-byte — a legitimate change updates REJECT here in the same commit)");
  const writeAt = body.indexOf(WRITE);
  if (writeAt < 0) errs.push("the is_default write is gone — the action no longer sets the star; re-point the guard");
  else if (body.indexOf(REJECT) > writeAt)
    errs.push("the rejection sits below the is_default write — the star is set before the key is checked");
  return errs;
};

// ---- 1. the real file passes ----------------------------------------------
const real = validateFile(src);
assert.equal(real.length, 0, `status-actions.ts violates the rule:\n  - ${real.join("\n  - ")}`);
ok("set-default rejects key='approved' by key, before the star is written (select fetches key, frozen block, order right)");

// ---- 2. the UI mirrors the server (courtesy, one signal) -------------------
// The server throw is THE fence; the disabled button is what tells the
// operator WHY. If the special-case vanishes the fence still holds, but the
// operator meets a raw error instead of an explanation.
const UI = "src/app/(dashboard)/settings/WorkflowStatusSection.tsx";
const ui = readFileSync(UI, "utf8");
assert.ok(
  ui.includes('row.key === "approved"'),
  "WorkflowStatusSection.tsx no longer special-cases the paid marker's star button",
);
ok("the star button special-cases the paid marker row (disabled + explanation)");

// ---- 3. B2 — semantic neutralizations must fall ----------------------------
// [label, old, new] over the FILE text. Every `old` must exist exactly once
// (a stale battery proves nothing), and every mutant must be REJECTED.
const IF_LINE = 'if (target.key === "approved")';
const MUTANTS = [
  ["dropped rejection: the if+throw deleted outright", REJECT, ""],
  ["operator flip: === 'approved' → !==", IF_LINE, 'if (target.key !== "approved")'],
  ["AND-false wrap: the comparison remains, vacuously", IF_LINE, 'if (target.key === "approved" && false)'],
  ["key starved: the select drops `key`, so target.key is forever undefined", SELECT, "SELECT id, is_active FROM guesthub.lookup_items"],
  ["defanged: the if remains, the throw becomes a log", REJECT, 'if (target.key === "approved")\n        console.error("approved as default");'],
  ["typo'd key: the structural check remains, catches nothing", 'target.key === "approved"', 'target.key === "aproved"'],
  ["commented out: the block survives as documentation only", REJECT, REJECT.split("\n").map((l) => `// ${l}`).join("\n")],
];

for (const [label, oldText, newText] of MUTANTS) {
  assert.equal(occurrences(src, oldText), 1,
    `B2 battery is stale: anchor for mutant "${label}" is not unique in ${ACTIONS} — rewrite it`);
  const mutant = src.replace(oldText, newText);
  assert.notEqual(mutant, src,
    `B2 battery is stale: mutant "${label}" no longer changes the file — rewrite it`);
  assert.ok(validateFile(mutant).length > 0,
    `B2: mutant "${label}" PASSED the validator — the guard is not a guard`);
}

// late-check mutant needs a two-step move, so it lives outside the table:
// the rejection is deleted from its place and re-planted after the write,
// inside the same function body. Every marker survives; only the order dies.
{
  const at = src.indexOf(FN);
  const end = src.indexOf("export async function", at + 1);
  const body = src.slice(at, end);
  const SET_TAIL = "WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;";
  assert.equal(occurrences(body, SET_TAIL), 1,
    "B2 battery is stale: the is_default write's tail is not unique inside the action body — rewrite the late-check mutant");
  const movedBody = body.replace(REJECT, "").replace(SET_TAIL, `${SET_TAIL}\n      ${REJECT}`);
  const mutant = src.slice(0, at) + movedBody + src.slice(end);
  assert.notEqual(mutant, src, "B2 battery is stale: the late-check mutant no longer changes the file");
  assert.ok(validateFile(mutant).length > 0,
    'B2: mutant "late check: rejection moved below the is_default write" PASSED the validator — the guard is not a guard');
}
ok(`B2: all ${MUTANTS.length + 1} mutants rejected — every semantic neutralization with intact structural markers falls`);

console.log(`\nall ${n} no-approved-as-default checks passed — the paid marker cannot become the import default (D89/D139)`);
