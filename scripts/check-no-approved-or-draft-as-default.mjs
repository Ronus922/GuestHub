// check:no-approved-or-draft-as-default — no pay-window-exempt key may be the
// import default.
//
// THE RULE (D89 + D139 + D140): the starred workflow status is what the Beds24
// importer stamps on every new OTA booking (booking-import.ts reads the star,
// creation-time only). The pay window exempts exactly TWO things: the workflow
// key 'approved' (D89: it IS the paid marker; D139: it is the window's single
// exit) and the lifecycle status 'draft' (D140: a draft is not an unpaid
// booking, it is a booking not yet made). Star either key and every imported
// booking is born invisible to the pay window — the same silent failure
// through either door. setDefaultWorkflowStatusAction must therefore REJECT
// key='approved' AND key='draft' — by key, never by UUID — before anything is
// written.
//
// SEMANTIC LINK (documented on purpose): the rejection list here is the MIRROR
// of the pay widget's exclusion list in dashboard/data.ts (frozen verbatim by
// check:pay-widget-no-status-whitelist). If D140 is ever revisited and the
// widget's exclusions change, the WIDGET-LINK section below fails and points
// at the mismatch: re-align the action's rejection list, this guard, and the
// pay-widget freeze in the SAME commit. Neither side may drift alone.
//
// HOW: the rejection blocks are FROZEN byte-for-byte inside the action's body,
// with comments stripped first so a commented-out rejection reads as a
// missing one. Two accomplice edits are pinned alongside them: the FOR UPDATE
// select must still fetch `key` (drop it and target.key is forever undefined
// — the check dies silently), and the rejections must precede the is_default
// write (a check after the write checks nothing).
//
// FAIL-CLOSED: if the action, the select, the write, the UI special-case or
// the widget's exclusions cannot be located, the guard fails — a guard that
// cannot see its subject proves nothing.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN: the validator re-runs against
// semantic neutralizations of the REAL files that keep the structural markers
// (the function, the ifs, the select all remain recognizable). A validator
// that accepts any mutant is not a guard, and this run exits 1 saying so.
// Usage: node scripts/check-no-approved-or-draft-as-default.mjs
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
          "הסטטוס 'approved' נדחה: הוא מסמן תשלום בפועל (D89), וקביעתו כברירת מחדל תסמן כל ייבוא כשולם ותסתיר אותו מחלון התשלומים (D139)",
        );
      if (target.key === "draft")
        throw new AuthorizationError(
          "הסטטוס 'draft' נדחה: חלון התשלומים מחריג טיוטות (D140), וקביעתו כברירת מחדל תסתיר כל ייבוא מחלון התשלומים",
        );`;
const APPROVED_BLOCK = `if (target.key === "approved")
        throw new AuthorizationError(
          "הסטטוס 'approved' נדחה: הוא מסמן תשלום בפועל (D89), וקביעתו כברירת מחדל תסמן כל ייבוא כשולם ותסתיר אותו מחלון התשלומים (D139)",
        );`;
const DRAFT_BLOCK = `if (target.key === "draft")
        throw new AuthorizationError(
          "הסטטוס 'draft' נדחה: חלון התשלומים מחריג טיוטות (D140), וקביעתו כברירת מחדל תסתיר כל ייבוא מחלון התשלומים",
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
    errs.push("the FOR UPDATE select no longer fetches `key` — target.key is forever undefined and the rejections are dead");
  if (occurrences(body, REJECT) !== 1)
    errs.push("the approved+draft rejection blocks are missing or altered (frozen byte-for-byte — a legitimate change updates REJECT here in the same commit); D139 needs 'approved' refused and D140 needs 'draft' refused, both by key");
  const writeAt = body.indexOf(WRITE);
  if (writeAt < 0) errs.push("the is_default write is gone — the action no longer sets the star; re-point the guard");
  else if (body.indexOf(REJECT) > writeAt)
    errs.push("the rejections sit below the is_default write — the star is set before the key is checked");
  return errs;
};

// ---- 1. the real file passes ----------------------------------------------
const real = validateFile(src);
assert.equal(real.length, 0, `status-actions.ts violates the rule:\n  - ${real.join("\n  - ")}`);
ok("set-default rejects key='approved' AND key='draft' by key, before the star is written (select fetches key, frozen blocks, order right)");

// ---- 2. the UI mirrors the server (courtesy, one signal per key) -----------
// The server throws are THE fence; the disabled button is what tells the
// operator WHY. If a special-case vanishes the fence still holds, but the
// operator meets a raw error instead of an explanation.
const UI = "src/app/(dashboard)/settings/WorkflowStatusSection.tsx";
const ui = readFileSync(UI, "utf8");
assert.ok(
  ui.includes('row.key === "approved"'),
  "WorkflowStatusSection.tsx no longer special-cases the paid marker's star button",
);
assert.ok(
  ui.includes('row.key === "draft"'),
  "WorkflowStatusSection.tsx no longer special-cases the draft row's star button (D140)",
);
ok("the star button special-cases both exempt rows (disabled + explanation)");

// ---- 3. WIDGET-LINK — the rejection list mirrors the pay widget ------------
// The pay widget (dashboard/data.ts) exempts exactly 'approved' (workflow key,
// D139) and 'draft' (lifecycle status, D140). The action's rejection list
// exists BECAUSE of those exemptions. If either exclusion disappears from the
// widget — a D140 revision, say — this section fails, pointing at the
// mismatch between the two files instead of letting them drift apart.
// (check:pay-widget-no-status-whitelist freezes the widget's full template;
// this is the cross-file tie, not a second freeze.)
const DATA = "src/app/(dashboard)/dashboard/data.ts";
const dataSrc = readFileSync(DATA, "utf8");
const WIDGET_EXCLUSIONS = {
  approved: "AND COALESCE(wf.key, '') <> 'approved'",
  draft: "AND res.status <> 'draft'",
};
// same locator as check:pay-widget-no-status-whitelist — the link is measured
// on the pay template itself, not on the whole file (the '<> approved'
// comparison legitimately appears in other queries too).
const extractPayQuery = (source) => {
  const templates = [...source.matchAll(/sql<[^`]{0,200}`([\s\S]*?)`/g)].map((m) => m[1]);
  const found = templates.filter(
    (t) => t.includes("days_since") && t.includes("guesthub.reservations"),
  );
  return found.length === 1 ? found[0] : null;
};
const validateWidgetLink = (source) => {
  const q = extractPayQuery(source);
  if (q == null)
    return ["cannot locate the pay query (exactly one sql template with days_since over guesthub.reservations) — the widget moved; re-point this guard"];
  const errs = [];
  for (const [key, marker] of Object.entries(WIDGET_EXCLUSIONS)) {
    if (!q.includes(marker))
      errs.push(
        `the pay widget no longer carries its '${key}' exclusion (\`${marker}\`) — the widget's exclusion list (D139/D140) and the action's rejection list have diverged; re-align both and update this guard in the same commit`,
      );
  }
  return errs;
};
const linkErrs = validateWidgetLink(dataSrc);
assert.equal(linkErrs.length, 0, `widget link broken:\n  - ${linkErrs.join("\n  - ")}`);
ok("the pay widget still exempts exactly the two keys the action rejects — the lists are aligned (D139/D140)");

// ---- 4. B2 — semantic neutralizations must fall ----------------------------
// [label, old, new] over the FILE text. Every `old` must exist exactly once
// (a stale battery proves nothing), and every mutant must be REJECTED.
const IF_APPROVED = 'if (target.key === "approved")';
const IF_DRAFT = 'if (target.key === "draft")';
const MUTANTS = [
  ["dropped rejection: both if+throw blocks deleted outright", REJECT, ""],
  ["draft dropped from the list: only the approved block remains", REJECT, APPROVED_BLOCK],
  ["approved dropped from the list: only the draft block remains", REJECT, DRAFT_BLOCK],
  ["operator flip: === 'approved' → !==", IF_APPROVED, 'if (target.key !== "approved")'],
  ["operator flip: === 'draft' → !==", IF_DRAFT, 'if (target.key !== "draft")'],
  ["AND-false wrap: the approved comparison remains, vacuously", IF_APPROVED, 'if (target.key === "approved" && false)'],
  ["AND-false wrap: the draft comparison remains, vacuously", IF_DRAFT, 'if (target.key === "draft" && false)'],
  ["key starved: the select drops `key`, so target.key is forever undefined", SELECT, "SELECT id, is_active FROM guesthub.lookup_items"],
  ["defanged: the ifs remain, the throws become a log", REJECT, 'if (target.key === "approved" || target.key === "draft")\n        console.error("exempt key as default");'],
  ["typo'd key: the structural check remains, catches nothing", 'target.key === "approved"', 'target.key === "aproved"'],
  ["typo'd key: draft misspelled, catches nothing", 'target.key === "draft"', 'target.key === "darft"'],
  ["commented out: both blocks survive as documentation only", REJECT, REJECT.split("\n").map((l) => `// ${l}`).join("\n")],
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
// the rejections are deleted from their place and re-planted after the write,
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
    'B2: mutant "late check: rejections moved below the is_default write" PASSED the validator — the guard is not a guard');
}

// widget-link mutants: each exclusion vanishing from the pay template must be
// caught — this is exactly the "D140 changed and nobody re-aligned" scenario.
// Anchors carry pay-query-local context because '<> approved' legitimately
// appears in other queries in the same file.
const LINK_MUTANTS = [
  ["widget drops the draft exclusion (D140 revised, lists diverge)",
    "AND COALESCE(wf.key, '') <> 'approved'\n         AND res.status <> 'draft'",
    "AND COALESCE(wf.key, '') <> 'approved'"],
  ["widget drops the approved exclusion (D139 revised, lists diverge)",
    "AND res.check_in <= ${today}\n         AND COALESCE(wf.key, '') <> 'approved'",
    "AND res.check_in <= ${today}"],
];
for (const [label, oldText, newText] of LINK_MUTANTS) {
  assert.equal(occurrences(dataSrc, oldText), 1,
    `B2 battery is stale: anchor for widget-link mutant "${label}" is not unique in ${DATA} — rewrite it`);
  const mutant = dataSrc.replace(oldText, newText);
  assert.notEqual(mutant, dataSrc,
    `B2 battery is stale: widget-link mutant "${label}" no longer changes the file — rewrite it`);
  assert.ok(validateWidgetLink(mutant).length > 0,
    `B2: widget-link mutant "${label}" PASSED the validator — the cross-file tie is not a tie`);
}
ok(`B2: all ${MUTANTS.length + 1 + LINK_MUTANTS.length} mutants rejected — every semantic neutralization with intact structural markers falls, on both files`);

console.log(`\nall ${n} no-approved-or-draft-as-default checks passed — no pay-window-exempt key can become the import default (D89/D139/D140)`);
