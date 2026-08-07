// check:pay-widget-no-status-whitelist — D139 is a SHAPE, not a sentence.
//
// THE RULE (D139/D140): the pay window lists EVERY reservation whose check-in
// has arrived and whose deal is not approved. The workflow axis may be
// filtered by exactly ONE comparison — `COALESCE(wf.key, '') <> 'approved'` —
// and the lifecycle axis by exactly ONE exception — `res.status <> 'draft'`
// (a draft is not an unpaid booking, it is a booking not yet made). No status
// whitelist ANYWHERE, so a future status is in by construction, never by
// remembering to add it to a list. 'approved' is the single way out.
//
// HOW — FULL FREEZE, not clause inspection. A first draft validated only the
// main WHERE and the wf JOIN; a red-team pass produced ten verified bypasses,
// all one family: move the filter where the inspector does not look — a
// derived table in FROM, a filtering CTE, an inner join's ON, a LATERAL
// gate, an sql`` fragment smuggled through `${...}`, a lowercase `not in`,
// or a plain JS .filter() after the query. The answer is to stop inspecting
// and freeze: the ENTIRE pay template (interpolations included, whitespace
// collapsed) must equal CANONICAL_TEMPLATE byte-for-byte, and the payRows
// mapping must be a bare `payRowsRaw.map(...)`. Any textual change anywhere
// in the query — legitimate or not — fails, and a legitimate change updates
// CANONICAL_TEMPLATE here in the SAME commit. The clause-level checks are
// kept for their precise error messages; the freeze is the fence.
//
// FAIL-CLOSED: if the query cannot be located, the guard fails — a guard
// that cannot see its subject proves nothing.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN: the validator re-runs against a
// battery of mutants of the REAL file — the spec's semantic neutralizations
// of the 'approved' comparison (structural markers kept) plus every bypass
// class the red-team verified against the first draft. A validator that
// accepts any mutant is not a guard, and this run exits 1 saying so.
//
// KNOWN LIMIT (documented, not defended): a static text guard cannot stop a
// determined author who plants a verbatim decoy template while renaming the
// live query's marker column AND keeps the stale mapping line — that needs a
// runtime probe against a DB. The mapping-tie assertions below make that
// cost three deliberate edits; honest regressions do not look like that.
// Usage: node scripts/check-pay-widget-no-status-whitelist.mjs
import { readFileSync } from "node:fs";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const DATA = "src/app/(dashboard)/dashboard/data.ts";
const src = readFileSync(DATA, "utf8");

// Whitespace is not shape; EVERYTHING else is — including the `${...}`
// interpolation text (collapsing it to a placeholder is what let an sql``
// fragment smuggle `AND res.status <> 'cancelled'` through a "param").
const norm = (s) => s.replace(/\s+/g, " ").trim();

// ---- the frozen shape ------------------------------------------------------
// Verbatim twin of the pay template in data.ts. That duplication is the
// mechanism: the query cannot drift without editing this file too.
const CANONICAL_TEMPLATE = `
      WITH src_rank AS (
        SELECT id, color,
               (row_number() OVER (ORDER BY sort_order, key) - 1)::int AS rank
          FROM guesthub.lookup_items
         WHERE tenant_id = \${tenantId} AND category = 'booking_sources'
      )
      SELECT res.id, COALESCE(g.full_name, 'אורח') AS guest_name,
             res.check_in::text AS check_in,
             (\${today}::date - res.check_in)::int AS days_since,
             res.balance::float8 AS balance,
             (res.status = 'cancelled') AS cancelled,
             sr.color AS source_color, sr.rank AS source_rank,
             (SELECT count(*)::int FROM src_rank) AS source_total,
             room.room_number
        FROM guesthub.reservations res
        LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id AND g.tenant_id = res.tenant_id
        LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
        LEFT JOIN src_rank sr ON sr.id = res.source_id
        LEFT JOIN LATERAL (
          SELECT rm.room_number
            FROM guesthub.reservation_rooms rr
            JOIN guesthub.rooms rm ON rm.id = rr.room_id AND rm.tenant_id = rr.tenant_id
           WHERE rr.tenant_id = res.tenant_id AND rr.reservation_id = res.id
           ORDER BY rm.room_number
           LIMIT 1) room ON true
       WHERE res.tenant_id = \${tenantId}
         AND res.check_in <= \${today}
         AND COALESCE(wf.key, '') <> 'approved'
         AND res.status <> 'draft'
       ORDER BY res.check_in`;

const CANONICAL_WHERE = [
  "res.tenant_id = ${tenantId}",
  "res.check_in <= ${today}",
  "COALESCE(wf.key, '') <> 'approved'",
  "res.status <> 'draft'",
];

// ---- locate the pay query (fail-closed) -----------------------------------
const extractPayQuery = (source) => {
  const templates = [...source.matchAll(/sql<[^`]{0,200}`([\s\S]*?)`/g)].map((m) => m[1]);
  const found = templates.filter(
    (t) => t.includes("days_since") && t.includes("guesthub.reservations"),
  );
  return found.length === 1 ? found[0] : null;
};

// ---- the validator ---------------------------------------------------------
// Whole FILE → list of violations. Ran twice: once on the real file, once per
// mutant (where a clean result is itself the failure).
const validateFile = (source) => {
  const errs = [];

  // A. the result reaches the window unfiltered — D139 lives in SQL, and a
  //    JS .filter() after a frozen query is the cheapest bypass of all.
  if (!/payRows:\s*payRowsRaw\.map\(\(r\) => \(\{/.test(source))
    errs.push("payRows must be a bare payRowsRaw.map(...) — no filter/slice between the query and the window");
  const rawRefs = (source.match(/payRowsRaw/g) ?? []).length;
  if (rawRefs !== 2)
    errs.push(`payRowsRaw must appear exactly twice (destructuring + map), found ${rawRefs} — an intermediate variable is where a filter hides`);
  // the mapping must read the SAME columns the frozen template emits — ties
  // the validated shape to the executed query
  if (!source.includes("daysSince: Number(r.days_since ?? 0)"))
    errs.push("the mapping no longer reads r.days_since — the validated template and the executed query may have diverged");
  if (!source.includes("cancelled: r.cancelled === true"))
    errs.push("the mapping no longer carries the cancelled flag (D139: cancelled rows get a tag, never a filter)");

  const q = extractPayQuery(source);
  if (q == null) {
    errs.push("cannot locate the pay query (exactly one sql template with days_since over guesthub.reservations)");
    return errs;
  }

  // B. no IN-list anywhere, any case — a whitelist in a CTE, a JOIN or a
  //    subquery is still a whitelist.
  if (/\bIN\s*\(/i.test(q) || /\bNOT\s+IN\b/i.test(q))
    errs.push("an IN-list is present somewhere in the pay query — D139 forbids any status enumeration");

  // C. the workflow JOIN is the bare id equality; the axis is touched exactly
  //    once beyond it (the WHERE comparison).
  const join = q.match(/LEFT JOIN guesthub\.lookup_items wf ON([\s\S]*?)(?=\n\s*(?:LEFT JOIN|JOIN|WHERE)\b)/);
  if (!join) errs.push("cannot locate the workflow JOIN (LEFT JOIN guesthub.lookup_items wf ON …)");
  else if (norm(join[1]) !== "wf.id = res.workflow_status_id")
    errs.push(`the workflow JOIN must be the bare id equality, found "${norm(join[1])}"`);
  const count = (re) => (q.match(re) ?? []).length;
  if (count(/wf\.key/g) !== 1)
    errs.push(`wf.key must appear exactly once (the single 'approved' comparison), found ${count(/wf\.key/g)}`);
  if (count(/workflow_status_id/g) !== 1)
    errs.push(`workflow_status_id must appear exactly once (the join), found ${count(/workflow_status_id/g)}`);

  // D. the main WHERE is VERBATIM the four conditions — precise diagnostics
  //    for the common regression before the freeze verdict below.
  const wIdx = q.lastIndexOf("WHERE");
  if (wIdx === -1) errs.push("the pay query has no WHERE clause");
  else {
    let where = q.slice(wIdx + "WHERE".length);
    const oIdx = where.lastIndexOf("ORDER BY");
    if (oIdx !== -1) where = where.slice(0, oIdx);
    const conds = where.split(/\n\s*AND\s/).map(norm).filter(Boolean);
    if (conds.length !== CANONICAL_WHERE.length)
      errs.push(`the pay WHERE must hold exactly ${CANONICAL_WHERE.length} conditions, found ${conds.length}`);
    for (const c of CANONICAL_WHERE)
      if (!conds.includes(c)) errs.push(`missing canonical condition: ${c}`);
    for (const c of conds)
      if (!CANONICAL_WHERE.includes(c))
        errs.push(`extra/altered condition in the pay WHERE: "${c}" — the only workflow filter is <> 'approved' and the only status exception is draft (D139/D140)`);
  }

  // E. THE FREEZE — the whole template, verbatim. This is what actually
  //    closes the derived-table / CTE / inner-join / LATERAL / `${}` routes:
  //    they all change the text, and the text may not change.
  const got = norm(q);
  const want = norm(CANONICAL_TEMPLATE);
  if (got !== want) {
    let i = 0;
    while (i < Math.min(got.length, want.length) && got[i] === want[i]) i++;
    errs.push(
      "the pay query text diverges from the frozen canonical shape (D139); a legitimate change must update CANONICAL_TEMPLATE in scripts/check-pay-widget-no-status-whitelist.mjs in the SAME commit.\n" +
      `      first divergence: …${got.slice(Math.max(0, i - 40), i + 40)}…\n` +
      `      canonical reads:  …${want.slice(Math.max(0, i - 40), i + 40)}…`,
    );
  }
  return errs;
};

// ---- 1. the live file honours the shape ------------------------------------
const liveErrs = validateFile(src);
assert.equal(liveErrs.length, 0,
  `${DATA} violates D139:\n    - ${liveErrs.join("\n    - ")}`);
ok("pay template is verbatim the frozen shape; WHERE is tenant · due · <> 'approved' · <> 'draft' — nothing else");
ok("workflow axis touched exactly once outside the bare-id JOIN; no IN-list (any case); payRows reaches the window unfiltered");

// ---- 2. B2 — the guard falls when the comparison is neutralized ------------
// [label, old, new] over the FILE text. Every `old` must exist exactly once
// (a stale battery proves nothing), and every mutant must be REJECTED.
// Mutants 1-4 are the spec's mandated neutralizations (structural markers
// kept); the rest are the red-team's verified bypasses of the first draft.
const PAIR = "AND COALESCE(wf.key, '') <> 'approved'\n         AND res.status <> 'draft'";
const TAIL = "AND res.status <> 'draft'\n       ORDER BY res.check_in`";
const FROMLINE = "room.room_number\n        FROM guesthub.reservations res";
const WHERETOP = "WHERE res.tenant_id = ${tenantId}\n         AND res.check_in <= ${today}\n         AND COALESCE";

const MUTANTS = [
  ["operator flip: <> 'approved' → = 'approved'",
    PAIR, PAIR.replace("<>", "=")],
  ["OR-true wrap: the comparison remains, vacuously",
    PAIR, "AND (COALESCE(wf.key, '') <> 'approved' OR true)\n         AND res.status <> 'draft'"],
  ["COALESCE default flip: NULL-workflow rows read as approved and vanish",
    PAIR, PAIR.replace("COALESCE(wf.key, '')", "COALESCE(wf.key, 'approved')")],
  ["dropped comparison: the 'approved' line deleted outright",
    PAIR, "AND res.status <> 'draft'"],
  ["whitelist regression: res.status NOT IN ('cancelled', 'draft')",
    TAIL, "AND res.status NOT IN ('cancelled', 'draft')\n       ORDER BY res.check_in`"],
  ["lowercase whitelist: res.status not in (…) — keywords are case-insensitive in SQL",
    TAIL, "AND res.status not in ('cancelled', 'draft')\n       ORDER BY res.check_in`"],
  ["second workflow filter appended to the WHERE",
    TAIL, "AND res.status <> 'draft'\n         AND wf.key IS DISTINCT FROM 'pending'\n       ORDER BY res.check_in`"],
  ["JOIN smuggle: the wf ON grows AND wf.key <> 'pending'",
    "LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id\n        LEFT JOIN src_rank sr",
    "LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id AND wf.key <> 'pending'\n        LEFT JOIN src_rank sr"],
  ["lower bound added: hides exactly the oldest debt",
    TAIL, "AND res.status <> 'draft'\n         AND res.check_in >= ${monthAgo}\n       ORDER BY res.check_in`"],
  ["derived table: res is already a filtered relation",
    FROMLINE, "room.room_number\n        FROM (SELECT r0.* FROM guesthub.reservations r0 WHERE r0.status <> 'cancelled') res"],
  ["filtering CTE prepended to src_rank",
    "WITH src_rank AS (", "WITH live AS (\n        SELECT id FROM guesthub.reservations WHERE status <> 'cancelled'\n      ), src_rank AS ("],
  ["inner self-join with the filter in ITS ON clause",
    FROMLINE, "room.room_number\n        FROM guesthub.reservations res\n        JOIN guesthub.reservations live ON live.id = res.id AND live.status <> 'cancelled'"],
  ["LATERAL gate: JOIN LATERAL (SELECT 1 WHERE …) before the main WHERE",
    "LIMIT 1) room ON true\n       " + WHERETOP,
    "LIMIT 1) room ON true\n        JOIN LATERAL (SELECT 1 WHERE res.status <> 'cancelled') gate ON true\n       " + WHERETOP],
  ["sql`` fragment smuggled through an interpolation slot",
    WHERETOP, "WHERE res.tenant_id = ${payScope(tenantId)}\n         AND res.check_in <= ${today}\n         AND COALESCE"],
  ["duplicate-canonical condition carrying a fragment",
    TAIL, "AND res.status <> 'draft'\n         AND res.tenant_id = ${payScope(tenantId)}\n       ORDER BY res.check_in`"],
  ["room LATERAL downgraded LEFT → INNER (a gate in disguise)",
    "LEFT JOIN src_rank sr ON sr.id = res.source_id\n        LEFT JOIN LATERAL (",
    "LEFT JOIN src_rank sr ON sr.id = res.source_id\n        JOIN LATERAL ("],
  ["JS post-filter: the SQL is untouched, the row still vanishes",
    "payRows: payRowsRaw.map((r) => ({", "payRows: payRowsRaw.filter((r) => r.cancelled !== true).map((r) => ({"],
  ["mapping unties from the template (decoy-class canary)",
    "daysSince: Number(r.days_since ?? 0)", "daysSince: Number(r.days_late ?? 0)"],
];

const occurrences = (hay, needle) => hay.split(needle).length - 1;
for (const [label, oldText, newText] of MUTANTS) {
  assert.equal(occurrences(src, oldText), 1,
    `B2 battery is stale: anchor for mutant "${label}" is not unique in ${DATA} — rewrite it`);
  const mutant = src.replace(oldText, newText);
  assert.notEqual(mutant, src,
    `B2 battery is stale: mutant "${label}" no longer changes the file — rewrite it`);
  assert.ok(validateFile(mutant).length > 0,
    `B2: mutant "${label}" PASSED the validator — the guard is not a guard`);
}
ok(`B2: all ${MUTANTS.length} mutants rejected — the spec's neutralizations AND every red-teamed bypass class fall`);

console.log(`\nall ${n} pay-widget checks passed — no status whitelist, 'approved' is the only way out (D139)`);
