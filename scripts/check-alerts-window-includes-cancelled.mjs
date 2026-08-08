// check:alerts-window-includes-cancelled — a cancelled reservation with a debt
// stays in the alerts window's money list.
//
// THE RULE (#187, D139's law applied to the alerts window): the "דורש טיפול"
// money query lists EVERY reservation with total_price > 0 and
// paid_amount < total_price whose workflow key is not 'approved'. cancelled is
// in DELIBERATELY — a no-cancellation policy entitles full payment, and a
// cancelled booking's debt is the debt easiest to miss. #187 DELETED
// `res.status <> 'cancelled'` from this query and added the בוטלה tag instead
// (a tag, never a filter). Nothing else stood between a future edit and that
// line quietly coming back — this guard is that fence. The ONLY exclusion is
// 'approved'; there is NO status whitelist, so a future lifecycle status is in
// by construction.
//
// HOW — FULL FREEZE, the check:pay-widget-no-status-whitelist mechanism: the
// ENTIRE money template (interpolations included, whitespace collapsed) must
// equal CANONICAL_TEMPLATE, and the money rows must feed the alerts loop
// bare — no .filter() between the query and the window. A filter re-added in
// ANY phrasing — `<>`, `!=`, `NOT IN`, a derived table, a JOIN's ON, a JS
// post-filter — changes the text or the loop, and neither may change. A
// legitimate change updates CANONICAL_TEMPLATE here in the SAME commit. The
// clause-level checks are kept for their precise error messages; the freeze
// is the fence.
//
// FAIL-CLOSED: if the money query or its loop cannot be located, the guard
// fails — a guard that cannot see its subject proves nothing.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN: the validator re-runs against
// mutants of the REAL file, including the original deleted line re-added in
// DIFFERENT phrasings (a guard that catches only the original string is not a
// guard). Every mutant's rejection is printed. A validator that accepts any
// mutant exits 1 saying so.
// Usage: node scripts/check-alerts-window-includes-cancelled.mjs
import { readFileSync } from "node:fs";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const DATA = "src/app/(dashboard)/dashboard/data.ts";
const src = readFileSync(DATA, "utf8");

// Whitespace is not shape; EVERYTHING else is — including the `${...}`
// interpolation text (collapsing it to a placeholder is what would let an
// sql`` fragment smuggle a filter through a "param").
const norm = (s) => s.replace(/\s+/g, " ").trim();

// ---- the frozen shape ------------------------------------------------------
// Verbatim twin of the money template in dashboardAlerts. That duplication is
// the mechanism: the query cannot drift without editing this file too.
const CANONICAL_TEMPLATE = `
      SELECT res.id, res.reservation_number, COALESCE(g.full_name, 'אורח') AS guest_name,
             res.total_price::float8 AS total_price, res.paid_amount::float8 AS paid_amount,
             (res.status = 'cancelled') AS cancelled
        FROM guesthub.reservations res
        LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id AND g.tenant_id = res.tenant_id
        LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
       WHERE res.tenant_id = \${tenantId}
         AND res.total_price > 0
         AND res.paid_amount < res.total_price
         AND COALESCE(wf.key, '') <> 'approved'
       ORDER BY res.check_in
       LIMIT 20`;

const CANONICAL_WHERE = [
  "res.tenant_id = ${tenantId}",
  "res.total_price > 0",
  "res.paid_amount < res.total_price",
  "COALESCE(wf.key, '') <> 'approved'",
];

// ---- locate the money query (fail-closed) ----------------------------------
const extractMoneyQuery = (source) => {
  const templates = [...source.matchAll(/sql<[^`]{0,200}`([\s\S]*?)`/g)].map((m) => m[1]);
  const found = templates.filter(
    (t) => t.includes("res.paid_amount < res.total_price") && t.includes("guesthub.reservations"),
  );
  return found.length === 1 ? found[0] : null;
};

// ---- the validator ---------------------------------------------------------
// Whole FILE → list of violations. Ran once on the real file, then once per
// mutant (where a clean result is itself the failure).
const validateFile = (source) => {
  const errs = [];

  const q = extractMoneyQuery(source);
  if (q == null) {
    errs.push("cannot locate the alerts money query (exactly one sql template with res.paid_amount < res.total_price over guesthub.reservations)");
    return errs;
  }

  // A. 'cancelled' may appear exactly once — as the SELECTed tag flag. A
  //    second appearance in ANY phrasing is a filter (or feeds one).
  const cancelledCount = (q.match(/cancelled/g) ?? []).length;
  if (!q.includes("(res.status = 'cancelled') AS cancelled"))
    errs.push("the money query no longer SELECTs the cancelled flag — #187's בוטלה tag has no source");
  if (cancelledCount !== 2) // the flag line: `(res.status = 'cancelled') AS cancelled` — one match per word
    errs.push(`'cancelled' must appear exactly twice in the money query (the flag expression and its alias), found ${cancelledCount} — an extra appearance is a filter coming back`);

  // B. res.status may be touched exactly once — inside the flag. A comparison
  //    in the WHERE, a JOIN's ON or a derived table adds a second touch.
  const statusCount = (q.match(/\bstatus\b/g) ?? []).length;
  if (statusCount !== 1)
    errs.push(`the lifecycle axis (status) must be touched exactly once (the tag flag), found ${statusCount} touches — cancelled rows must be tagged, never filtered (#187)`);

  // C. no IN-list anywhere, any case — a whitelist is the other door.
  if (/\bIN\s*\(/i.test(q) || /\bNOT\s+IN\b/i.test(q))
    errs.push("an IN-list is present in the money query — no status enumeration, present or future statuses are in by construction");

  // D. the workflow JOIN is the bare id equality; wf.key touched exactly once.
  const join = q.match(/LEFT JOIN guesthub\.lookup_items wf ON([\s\S]*?)(?=\n\s*(?:LEFT JOIN|JOIN|WHERE)\b)/);
  if (!join) errs.push("cannot locate the workflow JOIN (LEFT JOIN guesthub.lookup_items wf ON …)");
  else if (norm(join[1]) !== "wf.id = res.workflow_status_id")
    errs.push(`the workflow JOIN must be the bare id equality, found "${norm(join[1])}"`);
  if ((q.match(/wf\.key/g) ?? []).length !== 1)
    errs.push("wf.key must appear exactly once (the single 'approved' comparison)");

  // E. the main WHERE is VERBATIM the four conditions — precise diagnostics
  //    for the common regression before the freeze verdict below.
  const wIdx = q.lastIndexOf("WHERE");
  if (wIdx === -1) errs.push("the money query has no WHERE clause");
  else {
    let where = q.slice(wIdx + "WHERE".length);
    const oIdx = where.lastIndexOf("ORDER BY");
    if (oIdx !== -1) where = where.slice(0, oIdx);
    const conds = where.split(/\n\s*AND\s/).map(norm).filter(Boolean);
    if (conds.length !== CANONICAL_WHERE.length)
      errs.push(`the money WHERE must hold exactly ${CANONICAL_WHERE.length} conditions, found ${conds.length}`);
    for (const c of CANONICAL_WHERE)
      if (!conds.includes(c)) errs.push(`missing canonical condition: ${c}`);
    for (const c of conds)
      if (!CANONICAL_WHERE.includes(c))
        errs.push(`extra/altered condition in the money WHERE: "${c}" — the only exclusion is <> 'approved'; cancelled stays in (#187)`);
  }

  // F. THE FREEZE — the whole template, verbatim. Closes the derived-table /
  //    CTE / inner-join / `${}` routes: they all change the text, and the
  //    text may not change.
  const got = norm(q);
  const want = norm(CANONICAL_TEMPLATE);
  if (got !== want) {
    let i = 0;
    while (i < Math.min(got.length, want.length) && got[i] === want[i]) i++;
    errs.push(
      "the money query text diverges from the frozen canonical shape (#187); a legitimate change must update CANONICAL_TEMPLATE in scripts/check-alerts-window-includes-cancelled.mjs in the SAME commit.\n" +
      `      first divergence: …${got.slice(Math.max(0, i - 40), i + 40)}…\n` +
      `      canonical reads:  …${want.slice(Math.max(0, i - 40), i + 40)}…`,
    );
  }

  // G. the rows reach the window bare — a JS .filter() after a frozen query
  //    is the cheapest bypass of all.
  const loopAt = source.indexOf("for (const r of money)");
  if (loopAt < 0)
    errs.push("the money rows no longer feed the alerts loop bare (`for (const r of money)`) — a wrapper is where a filter hides");
  else {
    const cardsAt = source.indexOf("for (const r of cards)", loopAt);
    const block = source.slice(loopAt, cardsAt < 0 ? source.length : cardsAt);
    if (!block.includes("cancelled: r.cancelled === true"))
      errs.push("the money mapping no longer carries the cancelled flag — the בוטלה tag (#187) is dead and a cancelled debt is unmarked");
  }
  // counted with comments stripped — prose may say "money rows" freely; CODE
  // may touch the identifier only thrice.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const moneyRefs = (codeOnly.match(/\bmoney\b/g) ?? []).length;
  if (moneyRefs !== 3)
    errs.push(`\`money\` must appear exactly 3 times in code (destructure, bare loop, row-id prefix), found ${moneyRefs} — an intermediate variable is where a filter hides`);

  return errs;
};

// ---- 1. the live file honours the shape ------------------------------------
const liveErrs = validateFile(src);
assert.equal(liveErrs.length, 0,
  `${DATA} violates the #187 rule:\n    - ${liveErrs.join("\n    - ")}`);
ok("money template is verbatim the frozen shape; WHERE is tenant · debt · <> 'approved' — cancelled is IN, tagged via the flag");
ok("workflow axis touched once outside the bare-id JOIN; lifecycle axis touched once (the tag); rows reach the window unfiltered");

// ---- 2. B2 — the guard falls when the filter comes back, in ANY phrasing ---
// [label, old, new] over the FILE text. Every `old` must exist exactly once
// (a stale battery proves nothing), and every mutant must be REJECTED.
const TAIL = "AND COALESCE(wf.key, '') <> 'approved'\n       ORDER BY res.check_in\n       LIMIT 20";
const MONEY_JOIN = "LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id\n       WHERE res.tenant_id = ${tenantId}\n         AND res.total_price > 0";
const FLAG_FROM = "(res.status = 'cancelled') AS cancelled\n        FROM guesthub.reservations res";
const refilter = (cond) => `AND COALESCE(wf.key, '') <> 'approved'\n         ${cond}\n       ORDER BY res.check_in\n       LIMIT 20`;

const MUTANTS = [
  ["original filter re-added: AND res.status <> 'cancelled'", TAIL, refilter("AND res.status <> 'cancelled'")],
  ["rephrased: AND res.status NOT IN ('cancelled')", TAIL, refilter("AND res.status NOT IN ('cancelled')")],
  ["rephrased: AND res.status != 'cancelled'", TAIL, refilter("AND res.status != 'cancelled'")],
  ["rephrased, lowercase: and res.status not in ('cancelled')", TAIL, refilter("and res.status not in ('cancelled')")],
  ["rephrased via the flag: AND NOT (res.status = 'cancelled')", TAIL, refilter("AND NOT (res.status = 'cancelled')")],
  ["whitelist regression: AND res.status IN ('confirmed', 'checked_in')", TAIL, refilter("AND res.status IN ('confirmed', 'checked_in')")],
  ["approved exclusion dropped: the single exit vanishes", TAIL, "ORDER BY res.check_in\n       LIMIT 20"],
  ["JOIN smuggle: the wf ON grows AND res.status <> 'cancelled'",
    MONEY_JOIN,
    "LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id AND res.status <> 'cancelled'\n       WHERE res.tenant_id = ${tenantId}\n         AND res.total_price > 0"],
  ["derived table: res is already a filtered relation",
    FLAG_FROM,
    "(res.status = 'cancelled') AS cancelled\n        FROM (SELECT r0.* FROM guesthub.reservations r0 WHERE r0.status <> 'cancelled') res"],
  ["JS post-filter: the SQL is untouched, the row still vanishes",
    "for (const r of money)", "for (const r of money.filter((x) => x.cancelled !== true))"],
  ["tag starved: the mapping drops the cancelled flag",
    "approveReservationId: null,\n      cancelled: r.cancelled === true,", "approveReservationId: null,"],
];

const occurrences = (hay, needle) => hay.split(needle).length - 1;
for (const [label, oldText, newText] of MUTANTS) {
  assert.equal(occurrences(src, oldText), 1,
    `B2 battery is stale: anchor for mutant "${label}" is not unique in ${DATA} — rewrite it`);
  const mutant = src.replace(oldText, newText);
  assert.notEqual(mutant, src,
    `B2 battery is stale: mutant "${label}" no longer changes the file — rewrite it`);
  const verdicts = validateFile(mutant);
  assert.ok(verdicts.length > 0,
    `B2: mutant "${label}" PASSED the validator — the guard is not a guard`);
  if (verdicts.length > 0) console.log(`  ✓ B2 mutant rejected: ${label}`);
}
ok(`B2: all ${MUTANTS.length} mutants rejected — the deleted filter cannot come back in any phrasing, and the tag cannot be starved`);

console.log(`\nall ${n} alerts-window checks passed — a cancelled debt stays visible and tagged, never filtered (#187)`);
