// check:pay-charged-write-path — the "חויב" button's failure paths cannot be
// swallowed, and its write has exactly one home.
//
// THE DEFECT (diagnosed 2026-08-08): markCharged set the optimistic
// "חויב ✓" chip BEFORE awaiting setWorkflowStatusAction and handled only the
// {success:false} return shape. A THROWN rejection — a deploy that replaced
// the server-action id ("Failed to find Server Action", 28 occurrences in
// the prod log on a three-deploy day), a dropped connection — hit neither
// branch: the chip stayed, lying, with no write, no toast, no revert and no
// log. The operator read "charged" on a reservation that was never charged.
//
// THE RULE: both failure shapes — returned AND thrown — revert the chip,
// surface a toast the operator sees, and (for throws) console.error so the
// failure is recorded. The write stays setWorkflowStatusAction, the SAME
// action the edit panel's status select calls (D89: one paid marker, one
// writer, one audit trail) — never a second writer.
//
// HOW: markCharged is FROZEN (comments stripped, whitespace collapsed) —
// any semantic edit updates the canonical copy here in the SAME commit.
// Clause-level checks are kept for precise diagnostics; the freeze is the
// fence.
//
// FAIL-CLOSED: if the component, the handler or the import cannot be
// located, the guard fails — a guard that cannot see its subject proves
// nothing.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN, on in-memory copies (the work
// tree is never touched). Every rejection is printed.
// Usage: node scripts/check-pay-charged-write-path.mjs
import { readFileSync } from "node:fs";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const FILE = "src/app/(dashboard)/dashboard/windows/PayWindow.tsx";
const src = readFileSync(FILE, "utf8");

const occurrences = (hay, needle) => hay.split(needle).length - 1;
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const norm = (s) => s.replace(/\s+/g, " ").trim();

// ---- the frozen shape ------------------------------------------------------
// Verbatim twin of markCharged (comments stripped, whitespace collapsed at
// compare time). The duplication is the mechanism: the handler cannot drift
// without editing this file too.
const CANONICAL_MARK_CHARGED = `
  const markCharged = (r: PayRow) => {
    if (!approvedId) return;
    const revert = () =>
      setCharged((d) => {
        const next = { ...d };
        delete next[r.reservationId];
        return next;
      });
    setCharged((d) => ({ ...d, [r.reservationId]: true }));
    start(async () => {
      try {
        const res = await setWorkflowStatusAction({
          reservationId: r.reservationId,
          workflowStatusId: approvedId,
        });
        if (res.success) toast.success(\`ההזמנה של \${r.guestName} סומנה כחויבה\`);
        else {
          revert();
          toast.error(res.error);
        }
      } catch (e) {
        revert();
        console.error("[pay] markCharged failed", e);
        toast.error("הסימון לא נשמר — רענן את הדף ונסה שוב");
      }
    });
  };`;

const HANDLER_START = "const markCharged = (r: PayRow) => {";
const NEXT_ANCHOR = "if (rows.length === 0)";
const IMPORT_LINE = 'import { setWorkflowStatusAction } from "@/app/(dashboard)/reservations/actions";';

// ---- the validator ---------------------------------------------------------
// Whole FILE → list of violations. Ran once on the real file, then once per
// mutant (where a clean result is itself the failure).
const validateFile = (source) => {
  const errs = [];

  if (!source.includes(IMPORT_LINE))
    errs.push("PayWindow no longer writes through setWorkflowStatusAction from reservations/actions — D89 demands the one shared writer, one audit trail");

  const at = source.indexOf(HANDLER_START);
  if (at < 0) {
    errs.push("markCharged not found — renamed or moved; the guard cannot see its subject");
    return errs;
  }
  const end = source.indexOf(NEXT_ANCHOR, at);
  const body = stripComments(source.slice(at, end < 0 ? source.length : end));

  // precise diagnostics before the freeze verdict
  if (!/try\s*\{/.test(body))
    errs.push("markCharged has no try around the awaited action — a THROWN rejection (deploy skew, network) leaves the optimistic chip lying");
  if (!/catch\s*\(e\)\s*\{/.test(body))
    errs.push("markCharged has no catch — the thrown failure shape is unhandled");
  const catchAt = body.indexOf("catch");
  const catchBody = catchAt >= 0 ? body.slice(catchAt) : "";
  if (catchAt >= 0) {
    if (!catchBody.includes("revert();"))
      errs.push("the catch no longer reverts the optimistic chip — a failed click keeps showing חויב ✓");
    if (!catchBody.includes('console.error("[pay] markCharged failed", e);'))
      errs.push("the catch no longer records the failure — a thrown click failure leaves no trace");
    if (!catchBody.includes("toast.error("))
      errs.push("the catch no longer shows the operator an error — the failure is invisible");
  }
  const elseAt = body.indexOf("else {");
  if (elseAt < 0 || !body.slice(elseAt, catchAt < 0 ? body.length : catchAt).includes("revert();"))
    errs.push("the {success:false} branch no longer reverts the optimistic chip");

  // THE FREEZE — comments stripped, whitespace collapsed
  const got = norm(body);
  const want = norm(stripComments(CANONICAL_MARK_CHARGED));
  if (got !== want) {
    let i = 0;
    while (i < Math.min(got.length, want.length) && got[i] === want[i]) i++;
    errs.push(
      "markCharged diverges from the frozen canonical shape; a legitimate change must update CANONICAL_MARK_CHARGED in scripts/check-pay-charged-write-path.mjs in the SAME commit.\n" +
      `      first divergence: …${got.slice(Math.max(0, i - 40), i + 40)}…\n` +
      `      canonical reads:  …${want.slice(Math.max(0, i - 40), i + 40)}…`,
    );
  }
  return errs;
};

// ---- 1. the real file passes ----------------------------------------------
const real = validateFile(src);
assert.equal(real.length, 0, `${FILE} violates the write-path rule:\n  - ${real.join("\n  - ")}`);
ok("markCharged: one shared writer (D89), optimistic chip reverts on BOTH failure shapes, thrown failures are logged and toasted");

// ---- 2. B2 — semantic neutralizations must fall ----------------------------
const CATCH_BODY = `revert();
        console.error("[pay] markCharged failed", e);
        toast.error("הסימון לא נשמר — רענן את הדף ונסה שוב");`;
const TRY_WRAP = `try {
        const res = await setWorkflowStatusAction({
          reservationId: r.reservationId,
          workflowStatusId: approvedId,
        });
        if (res.success) toast.success(\`ההזמנה של \${r.guestName} סומנה כחויבה\`);
        else {
          revert();
          toast.error(res.error);
        }
      } catch (e) {
        ${CATCH_BODY}
      }`;
const MUTANTS = [
  ["semantic neutralization: the catch stays, its body is emptied — a throw is swallowed again",
    CATCH_BODY, ""],
  ["regression: try/catch removed outright — the original bug restored",
    TRY_WRAP, `const res = await setWorkflowStatusAction({
          reservationId: r.reservationId,
          workflowStatusId: approvedId,
        });
        if (res.success) toast.success(\`ההזמנה של \${r.guestName} סומנה כחויבה\`);
        else {
          revert();
          toast.error(res.error);
        }`],
  ["catch loses the revert — the chip keeps lying on a throw",
    CATCH_BODY, `console.error("[pay] markCharged failed", e);
        toast.error("הסימון לא נשמר — רענן את הדף ונסה שוב");`],
  ["catch loses the toast — the operator sees nothing",
    CATCH_BODY, `revert();
        console.error("[pay] markCharged failed", e);`],
  ["catch loses the log — the failure leaves no trace",
    CATCH_BODY, `revert();
        toast.error("הסימון לא נשמר — רענן את הדף ונסה שוב");`],
  ["the {success:false} branch loses its revert",
    `else {
          revert();
          toast.error(res.error);
        }`, `else {
          toast.error(res.error);
        }`],
  ["second writer smuggled in: the shared action import is dropped",
    IMPORT_LINE, 'import { setWorkflowStatusAction } from "./local-writer";'],
];

for (const [label, oldText, newText] of MUTANTS) {
  assert.equal(occurrences(src, oldText), 1,
    `B2 battery is stale: anchor for mutant "${label}" is not unique in ${FILE} — rewrite it`);
  const mutant = src.replace(oldText, newText);
  assert.notEqual(mutant, src, `B2 battery is stale: mutant "${label}" no longer changes the file — rewrite it`);
  const verdicts = validateFile(mutant);
  assert.ok(verdicts.length > 0,
    `B2: mutant "${label}" PASSED the validator — the guard is not a guard`);
  if (verdicts.length > 0) console.log(`  ✓ B2 mutant rejected: ${label}`);
}
ok(`B2: all ${MUTANTS.length} mutants rejected — neither failure shape can be silenced without this guard failing`);

console.log(`\nall ${n} pay-charged-write-path checks passed — a failed 'חויב' click can no longer lie (D89)`);
