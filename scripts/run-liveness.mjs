#!/usr/bin/env node
// ============================================================
// run-liveness — the production-liveness harness for the liveness:* probes.
//
// The suite (run-checks.mjs) measures CODE inside disposable clone databases
// and refuses production DSNs. This runner is its exact inverse: it measures
// the LIVE SYSTEM and refuses everything that is NOT production. An eternal
// red inside the suite is noise; the same red here is an alarm (D138).
//
//   TARGET     LIVENESS_DB_URL, explicit — there is NO default DSN. The DSN
//              must carry at least one production marker (the same list
//              run-checks.mjs refuses). Anything else is refused before a
//              single probe runs.
//   READ-ONLY  every probe connection opens with
//              default_transaction_read_only=on at SESSION level, added as a
//              startup parameter on the DSN handed to the probes (postgres.js
//              forwards unknown DSN query params into the startup packet, and
//              its begin() issues a plain BEGIN, so the session default holds
//              inside transactions too). A probe attempting a write dies with
//              "cannot execute ... in a read-only transaction". The runner
//              PREFLIGHTS the GUC on a real connection and refuses to run if
//              the server (or a pooler) dropped it — fail-closed.
//   ENV        probes run with --env-file=.env.local; the runner overrides
//              only DATABASE_URL (a real env var beats the file, Node ≥20.6),
//              so secrets like CHANNEL_SECRETS_KEY keep coming from the tree.
//   VERDICTS   ALL liveness:* keys run — nothing halts on a red. Each probe's
//              own output is printed verbatim, pass/fail per probe, exit 1 if
//              any probe failed.
//   HANDS OFF  this runner never restarts, builds or deploys anything —
//              no pm2, no next build, no deploy hooks. It observes.
//
// Usage: LIVENESS_DB_URL=<production DSN> node scripts/run-liveness.mjs [--only k1,k2]
// ============================================================
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DSN = process.env.LIVENESS_DB_URL;
if (!DSN) {
  console.error("REFUSED: LIVENESS_DB_URL is not set. There is no default DSN — liveness runs ONLY against production, named explicitly.");
  process.exit(2);
}
// SAFETY INVERSION of run-checks.mjs: the suite refuses these markers, this
// runner REQUIRES one. Keep the list in sync with run-checks.mjs.
const PRODUCTION_MARKERS = ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"];
if (!PRODUCTION_MARKERS.some((m) => DSN.includes(m))) {
  console.error(`REFUSED: LIVENESS_DB_URL carries no production marker (${PRODUCTION_MARKERS.join(", ")}).`);
  console.error("Liveness measures the live system only — to measure code, run the suite (pnpm suite).");
  process.exit(2);
}

// session-level read-only, as a startup parameter on the DSN every probe gets
const url = new URL(DSN);
url.searchParams.set("default_transaction_read_only", "on");
const RO_DSN = url.toString();

// preflight: prove the GUC actually landed on a real connection (fail-closed —
// a pooler that strips startup parameters would otherwise silently hand the
// probes a writable session).
{
  const require_ = createRequire(import.meta.url);
  const postgres = require_("postgres");
  const sql = postgres(RO_DSN, { prepare: false, max: 1 });
  let ro = "";
  try {
    const [row] = await sql`SELECT current_setting('default_transaction_read_only') AS ro`;
    ro = row.ro;
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (ro !== "on") {
    console.error(`REFUSED: session read-only did not land (default_transaction_read_only=${JSON.stringify(ro)}) — the target dropped the startup parameter.`);
    process.exit(2);
  }
  console.log("# read-only preflight: default_transaction_read_only=on (session)");
}

// ---- args ----
const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith("--only"));
const ONLY = (onlyArg?.includes("=")
  ? onlyArg.split("=").slice(1).join("=")
  : (onlyArg ? argv[argv.indexOf(onlyArg) + 1] ?? "" : ""))
  .split(",").filter(Boolean);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
let probes = Object.keys(pkg.scripts).filter((k) => k.startsWith("liveness:"));
if (ONLY.length) probes = probes.filter((k) => ONLY.includes(k));
if (probes.length === 0) {
  console.error("REFUSED: no liveness:* keys to run.");
  process.exit(2);
}
console.log(`# ${probes.length} probes: ${probes.join(", ")}`);

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 300_000);
const results = [];
for (const name of probes) {
  const started = Date.now();
  const r = spawnSync("pnpm", ["run", name], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, DATABASE_URL: RO_DSN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ms = Date.now() - started;
  const timedOut = r.error?.code === "ETIMEDOUT" || (r.signal && r.status === null);
  const pass = !timedOut && r.status === 0;
  results.push({ name, pass, status: timedOut ? "timeout" : r.status, ms });
  console.log(`\n=== ${name} — ${pass ? "PASS" : `FAIL (${timedOut ? `timeout ${TIMEOUT_MS}ms` : `exit ${r.status}`})`} (${ms}ms) ===`);
  const out = ((r.stdout || "") + (r.stderr || "")).trimEnd();
  if (out) console.log(out);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== LIVENESS TOTALS: pass=${results.length - failed.length} fail=${failed.length} of ${results.length}`);
for (const f of failed) console.log(`=== ALARM: ${f.name} (${f.status}) — a red here is the live system, not the code`);
if (failed.length > 0) process.exitCode = 1;
