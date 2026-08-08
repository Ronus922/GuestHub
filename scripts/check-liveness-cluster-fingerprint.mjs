// check:liveness-cluster-fingerprint — liveness proves it is talking to THE
// production cluster before a single probe runs (D142).
//
// THE RULE (D142, resolved 2026-08-08): PRODUCTION_MARKERS is a first-pass
// string filter, and a string can be composed — any DSN carrying ":5432/"
// passes it, including a docker-internal IP of a test cluster. The BINDING
// identity check is the cluster fingerprint: pg_control_system().
// system_identifier, read on the preflight connection, compared to
// PROD_CLUSTER_FINGERPRINT pinned in run-liveness.mjs under version control.
// The order is law: markers → connect → read-only preflight → fingerprint →
// probes. A mismatch, a failed query — refusal, exit 2, zero probes.
//
// HOW: the fingerprint block is FROZEN byte-for-byte (comments stripped
// first), the pinned constant must be a real identifier (10+ digits), and the
// ORDER is asserted on the stripped source: the fingerprint check sits after
// the markers filter and the read-only check, and before the only spawnSync
// that launches probes — with NO spawn of any kind ahead of it. A check that
// warns instead of exiting, compares fp to itself, or runs after the probes
// is not a check, and each of those mutations breaks an assert below.
//
// FAIL-CLOSED: if the runner, the constant, the query, the frozen block or
// the probe spawn cannot be located, the guard fails — a guard that cannot
// see its subject proves nothing.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN, against in-memory mutants of the
// real file (the work tree is never touched): semantic neutralization
// (fp !== fp), the check moved below the probes, refusal downgraded to a
// warning, exit code downgraded to 0, the constant emptied, the query
// dropped, the block deleted. Every mutant's rejection is printed.
// Usage: node scripts/check-liveness-cluster-fingerprint.mjs
import { readFileSync } from "node:fs";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

const RUNNER = "scripts/run-liveness.mjs";
const src = readFileSync(RUNNER, "utf8");

const occurrences = (hay, needle) => hay.split(needle).length - 1;
// block comments, then whole-line // comments — a check that survives only as
// documentation must not count as a check
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ---- the frozen shape ------------------------------------------------------
// Verbatim twins of run-liveness.mjs. The duplication is the mechanism: the
// runner cannot drift without editing this file too.
const CONST_RE = /const PROD_CLUSTER_FINGERPRINT = "(\d{10,})";/;
const QUERY = "SELECT system_identifier::text AS fp FROM pg_control_system()";
const FP_CHECK = `if (fp !== PROD_CLUSTER_FINGERPRINT) {
    console.error(\`REFUSED: cluster fingerprint mismatch — found \${JSON.stringify(fp)}, expected \${PROD_CLUSTER_FINGERPRINT} (production's pg_control_system().system_identifier, D142).\`);
    console.error("The target passed the marker filter but is NOT the production cluster. Liveness runs against production and nothing else.");
    process.exit(2);
  }`;
const MARKERS_GATE = "if (!PRODUCTION_MARKERS.some((m) => DSN.includes(m))) {";
const RO_GATE = 'if (ro !== "on") {';
const PROBE_SPAWN = 'spawnSync("pnpm", ["run", name]';

// ---- the validator ---------------------------------------------------------
// Whole FILE → list of violations. Ran once on the real file, then once per
// mutant (where a clean result is itself the failure).
const validateFile = (source) => {
  const body = stripComments(source);
  const errs = [];

  const c = body.match(CONST_RE);
  if (!c) errs.push("PROD_CLUSTER_FINGERPRINT is missing or not a pinned 10+ digit identifier — the binding identity has no value to bind to");

  if (occurrences(body, QUERY) !== 1)
    errs.push("the pg_control_system() query is missing — the fingerprint is never read from the target");

  if (occurrences(body, FP_CHECK) !== 1)
    errs.push("the fingerprint check is missing or altered (frozen byte-for-byte — a legitimate change updates FP_CHECK here in the same commit); a check that warns, compares fp to itself, or exits 0 reads as altered");

  const markersAt = body.indexOf(MARKERS_GATE);
  const roAt = body.indexOf(RO_GATE);
  const fpAt = body.indexOf(FP_CHECK);
  const spawnAt = body.indexOf(PROBE_SPAWN);
  if (markersAt < 0) errs.push("the PRODUCTION_MARKERS gate is gone — the first-pass filter was removed (forbidden: the fingerprint SUPPLEMENTS it, never replaces it)");
  if (roAt < 0) errs.push("the read-only preflight gate is gone");
  if (spawnAt < 0) errs.push("the probe spawn cannot be located — re-point the guard");
  if (occurrences(body, "spawnSync(") !== 1)
    errs.push("more than one spawn site (or none) — a second spawn is a path around the preflight gates");
  if (markersAt >= 0 && roAt >= 0 && fpAt >= 0 && spawnAt >= 0) {
    if (!(markersAt < roAt && roAt < fpAt && fpAt < spawnAt))
      errs.push(`the order must be markers → read-only → fingerprint → probes; found markers@${markersAt}, read-only@${roAt}, fingerprint@${fpAt}, spawn@${spawnAt} — a probe that runs before the fingerprint is approved runs against an unproven target`);
  }
  return errs;
};

// ---- 1. the real file passes ----------------------------------------------
const real = validateFile(src);
assert.equal(real.length, 0, `${RUNNER} violates D142:\n  - ${real.join("\n  - ")}`);
const pinned = stripComments(src).match(CONST_RE)?.[1];
ok(`the fingerprint check is present, frozen, blocking (exit 2), and ordered markers → read-only → fingerprint → probes (pinned: ${pinned})`);

// ---- 2. B2 — semantic neutralizations must fall ----------------------------
// [label, old, new] over the FILE text. Every `old` must exist exactly once
// (a stale battery proves nothing), and every mutant must be REJECTED.
const MUTANTS = [
  ["semantic neutralization: fp !== PROD_CLUSTER_FINGERPRINT → fp !== fp (markers intact)",
    "if (fp !== PROD_CLUSTER_FINGERPRINT) {", "if (fp !== fp) {"],
  ["refusal → warning: the exit inside the fingerprint block becomes a warn",
    FP_CHECK, FP_CHECK.replace("process.exit(2);", 'console.warn("fingerprint mismatch — continuing anyway");')],
  ["exit downgraded: process.exit(2) → process.exit(0) inside the block",
    FP_CHECK, FP_CHECK.replace("process.exit(2);", "process.exit(0);")],
  ["constant emptied: the pinned identity becomes \"\"",
    /const PROD_CLUSTER_FINGERPRINT = "\d+";/, 'const PROD_CLUSTER_FINGERPRINT = "";'],
  ["check deleted outright", FP_CHECK, ""],
  ["query dropped: fp is never read from the target",
    "    const [ctl] = await sql`SELECT system_identifier::text AS fp FROM pg_control_system()`;\n    fp = ctl.fp;\n", ""],
];

for (const [label, oldText, newText] of MUTANTS) {
  if (oldText instanceof RegExp) {
    assert.ok(oldText.test(src), `B2 battery is stale: anchor for mutant "${label}" not found in ${RUNNER} — rewrite it`);
  } else {
    assert.equal(occurrences(src, oldText), 1,
      `B2 battery is stale: anchor for mutant "${label}" is not unique in ${RUNNER} — rewrite it`);
  }
  const mutant = src.replace(oldText, newText);
  assert.notEqual(mutant, src,
    `B2 battery is stale: mutant "${label}" no longer changes the file — rewrite it`);
  const verdicts = validateFile(mutant);
  assert.ok(verdicts.length > 0,
    `B2: mutant "${label}" PASSED the validator — the guard is not a guard`);
  if (verdicts.length > 0) console.log(`  ✓ B2 mutant rejected: ${label}`);
}

// moved-after-probes mutant needs a two-step move, so it lives outside the
// table: the block is deleted from its place and re-planted after the probes
// loop. Every marker survives; only the order dies.
{
  const LATE_ANCHOR = "const failed = results.filter((r) => !r.pass);";
  assert.equal(occurrences(src, LATE_ANCHOR), 1,
    "B2 battery is stale: the results anchor is not unique — rewrite the late-check mutant");
  const mutant = src.replace(FP_CHECK, "").replace(LATE_ANCHOR, `${FP_CHECK}\n${LATE_ANCHOR}`);
  assert.notEqual(mutant, src, "B2 battery is stale: the late-check mutant no longer changes the file");
  const verdicts = validateFile(mutant);
  assert.ok(verdicts.length > 0,
    'B2: mutant "late check: fingerprint moved below the probes" PASSED the validator — the guard is not a guard');
  if (verdicts.length > 0) console.log('  ✓ B2 mutant rejected: late check: fingerprint moved below the probes');
}
ok(`B2: all ${MUTANTS.length + 1} mutants rejected — the fingerprint cannot be neutralized, softened, emptied, starved or reordered without this guard failing`);

console.log(`\nall ${n} liveness-cluster-fingerprint checks passed — no probe runs against an unproven cluster (D142)`);
