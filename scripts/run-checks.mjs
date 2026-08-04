#!/usr/bin/env node
// ============================================================
// run-checks — the trustworthy harness for the check:* suite.
//
// 69/23 on the old ad-hoc runs measured the harness, not the code: guards
// shared one mutable database, died on a missing node_modules/.cache, read env
// nobody supplied, and flipped verdicts with the UTC wall clock. This runner
// closes those four channels:
//
//   DATABASE    every DB-backed guard gets its OWN database, cloned with
//               CREATE DATABASE … TEMPLATE <from-zero template>. The template
//               is built by scripts/db/migrate.mjs in manifest order — never
//               hand-assembled. Guards that replay the migration chain
//               themselves (the REPLAYERS set) get an EMPTY database instead:
//               the chain is replayable only on a virgin schema (054's rename
//               breaks 005 on an already-migrated one). Databases are dropped
//               immediately after the guard.
//   FILESYSTEM  node_modules/.cache exists before EVERY guard (several guards
//               mkdtemp into it without creating the parent). Each guard gets
//               a private TMPDIR; entries a guard adds under node_modules/
//               .cache are removed after it, so no guard inherits another's
//               scratch.
//   ENV         DATABASE_URL, TEST_DATABASE_URL and every CHECK_*_DB_URL point
//               at the guard's own database — in the child env AND in a
//               generated .env.local (some guards run with --env-file). The
//               three encryption keys are supplied as ephemeral per-run values
//               (product code sha256-hashes them; guards only round-trip their
//               own fixtures). Guards needing env this harness cannot supply
//               (live app + browser, npm registry) are CANNOT-RUN — a third
//               state, never counted as pass or fail.
//   CLOCK       TZ=Asia/Jerusalem is pinned for every guard, matching the
//               product's default property timezone.
//
// Ordering is the declared package.json order; --shuffle[=seed] runs a seeded
// permutation so leftover-dependent greens are detectable (a verdict that
// changes with order is a finding about the guard, not the code).
//
// Usage:
//   node scripts/run-checks.mjs [--shuffle[=seed]] [--only k1,k2] [--json out]
//                               [--template name]   reuse an existing template DB
//                               [--keep-template]   leave the built template behind
// Admin DSN: SUITE_ADMIN_DB_URL (default: the repo-standard disposable testdb).
// ============================================================
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// This runner mutates .env.local and writes scratch DBs — never in the
// production runtime tree.
if (existsSync(join(ROOT, ".production-runtime"))) {
  console.error("REFUSED: this tree is marked .production-runtime — run the suite from a worktree.");
  process.exit(2);
}

const ADMIN =
  process.env.SUITE_ADMIN_DB_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (ADMIN.includes(marker)) {
    console.error(`REFUSED: production marker "${marker}" in SUITE_ADMIN_DB_URL`);
    process.exit(2);
  }
}

// ---- args ----
const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => {
  const idx = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return null;
  if (argv[idx].includes("=")) return argv[idx].split("=").slice(1).join("=");
  return argv[idx + 1] && !argv[idx + 1].startsWith("--") ? argv[idx + 1] : null;
};
const SHUFFLE = Boolean(flag("shuffle"));
const SEED = Number(flagVal("shuffle") ?? Date.now() % 1_000_000);
const ONLY = (flagVal("only") || "").split(",").filter(Boolean);
const OUT_DIR = join(ROOT, "node_modules", ".cache", "check-suite");
const JSON_OUT = flagVal("json") || join(OUT_DIR, "results.json");
const REUSE_TEMPLATE = flagVal("template");
const KEEP_TEMPLATE = Boolean(flag("keep-template"));
const TIMEOUT_MS = Number(process.env.GUARD_TIMEOUT_MS || 300_000);

// ---- guard classification ----
// Guards that DROP/replay the migration chain themselves. The chain applies
// only on a virgin schema, so these get an EMPTY database, not a clone.
const REPLAYERS = new Set([
  "check:commercial-db", "check:room-db", "check:check-in-check-out-db",
  "check:rate-plans", "check:pricing-engine", "check:pricing-equality",
  "check:totals-parity", "check:public-quote", "check:room-picker-window",
  "check:su-lifecycle", "check:room-identity", "check:beds24-failure-evidence",
]);
// Env the harness cannot supply: a live authenticated app + Chrome; the npm
// registry (probed below). Anything here is CANNOT-RUN unless the caller
// exported the requirement themselves.
const CANNOT_RUN = {
  "check:hydration-browser": () =>
    ["HYDRATION_BASE_URL", "HYDRATION_EMAIL", "HYDRATION_PASSWORD"].filter((k) => !process.env[k]),
  "check:supply-chain": () => (registryReachable ? [] : ["npm registry unreachable"]),
};

const psqlAdmin = (sql) =>
  execFileSync("psql", [ADMIN, "-v", "ON_ERROR_STOP=1", "-X", "-tAc", sql], { encoding: "utf8" });

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
let checks = Object.entries(pkg.scripts)
  .filter(([k]) => k.startsWith("check:"))
  .map(([name, cmd]) => ({ name, cmd }));
if (ONLY.length) checks = checks.filter((c) => ONLY.includes(c.name));

// A guard is DB-backed if any script it runs (directly or via a chained
// pnpm check:* key) references a database, or if it loads .env.local.
const scriptsOf = (cmd, seen = new Set()) => {
  const files = [...cmd.matchAll(/scripts\/[a-z0-9./-]+\.mjs/g)].map((m) => m[0]);
  for (const [, key] of cmd.matchAll(/pnpm (check:[a-z0-9-]+)/g)) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (pkg.scripts[key]) files.push(...scriptsOf(pkg.scripts[key], seen));
  }
  return files;
};
const isDbBacked = ({ cmd }) => {
  if (/--env-file/.test(cmd)) return true;
  return scriptsOf(cmd).some((f) => {
    try {
      return /TEST_DATABASE_URL|DATABASE_URL|CHECK_[A-Z_]*DB_URL|from "postgres"|\bpsql\b/.test(
        readFileSync(join(ROOT, f), "utf8"),
      );
    } catch {
      return false;
    }
  });
};

// ---- seeded shuffle (LCG — reproducible from the printed seed) ----
if (SHUFFLE) {
  let s = SEED >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
  for (let i = checks.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [checks[i], checks[j]] = [checks[j], checks[i]];
  }
  console.log(`# order: shuffled (seed ${SEED})`);
} else console.log("# order: declared (package.json)");

// ---- registry probe (for check:supply-chain) ----
const registryReachable = await new Promise((resolve) => {
  const req = get("https://registry.npmjs.org/-/ping", { timeout: 5000 }, (res) => {
    res.resume();
    resolve(res.statusCode > 0);
  });
  req.on("timeout", () => { req.destroy(); resolve(false); });
  req.on("error", () => resolve(false));
});

// ---- template database (built by migrate.mjs from manifest order) ----
const RUN_ID = `${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
const TEMPLATE = REUSE_TEMPLATE || `gh_suite_tpl_${RUN_ID}`;
const dsnFor = (db) => {
  const u = new URL(ADMIN);
  u.pathname = `/${db}`;
  return u.toString();
};
if (!REUSE_TEMPLATE) {
  console.log(`# building template ${TEMPLATE} via scripts/db/migrate.mjs (manifest order)…`);
  psqlAdmin(`DROP DATABASE IF EXISTS ${TEMPLATE}`);
  psqlAdmin(`CREATE DATABASE ${TEMPLATE}`);
  execFileSync("node", [join(ROOT, "scripts/db/migrate.mjs"), "--apply"], {
    env: { ...process.env, MIGRATE_DATABASE_URL: dsnFor(TEMPLATE) },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

// ---- per-run ephemeral secrets (sha256-hashed by product code) ----
const EPHEMERAL = Object.fromEntries(
  ["CHANNEL_SECRETS_KEY", "CARD_VAULT_KEY", "MESSAGING_SECRETS_ENCRYPTION_KEY"].map((k) => [
    k,
    process.env[k] || `suite-ephemeral-${randomBytes(16).toString("hex")}`,
  ]),
);

// ---- .env.local is rewritten per guard: preserve whatever was there ----
const ENV_LOCAL = join(ROOT, ".env.local");
const ENV_BACKUP = join(ROOT, `.env.local.suite-backup-${RUN_ID}`);
const hadEnvLocal = existsSync(ENV_LOCAL);
if (hadEnvLocal) renameSync(ENV_LOCAL, ENV_BACKUP);

const CACHE = join(ROOT, "node_modules", ".cache");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, "logs"), { recursive: true });

const results = [];
let i = 0;
try {
  for (const { name, cmd } of checks) {
    i++;
    const slug = name.replace(/^check:/, "").replace(/[^a-z0-9]/g, "_");

    const missing = CANNOT_RUN[name]?.() ?? [];
    if (missing.length) {
      writeFileSync(join(OUT_DIR, "logs", `${slug}.txt`), `cannot-run — needs: ${missing.join(", ")}\n`);
      results.push({ name, mode: "static", verdict: "cannot-run", why: `needs: ${missing.join(", ")}`, ms: 0 });
      console.log(`${String(i).padStart(2)}/${checks.length} cannot-run     ${name} (${missing.join(", ")})`);
      continue;
    }

    const dbBacked = isDbBacked({ cmd });
    const mode = !dbBacked ? "static" : REPLAYERS.has(name) ? "empty-db" : "clone";
    let db = null;
    if (dbBacked) {
      db = `sui_${String(i).padStart(2, "0")}_${slug}`.slice(0, 60);
      // CREATE … TEMPLATE needs exclusive access to the template; a transient
      // autovacuum worker inside it fails the clone. Kick sessions and retry.
      let created = false, lastErr = null;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        try {
          if (attempt > 0) {
            psqlAdmin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                       WHERE datname = '${TEMPLATE}' AND pid <> pg_backend_pid()`);
            execFileSync("sleep", ["0.4"]);
          }
          psqlAdmin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
          psqlAdmin(mode === "empty-db" ? `CREATE DATABASE ${db}` : `CREATE DATABASE ${db} TEMPLATE ${TEMPLATE}`);
          created = true;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!created) {
        const why = `db setup failed: ${String(lastErr.message).split("\n")[0]}`;
        writeFileSync(join(OUT_DIR, "logs", `${slug}.txt`), `cannot-run — ${why}\n`);
        results.push({ name, mode, verdict: "cannot-run", why, ms: 0 });
        continue;
      }
    }
    // Static guards get a DSN that does not resolve: a guard misclassified as
    // static then fails loudly instead of silently touching the template.
    const target = db ? dsnFor(db) : dsnFor(`sui_no_db_${slug}`.slice(0, 60));

    // FILESYSTEM: parent exists before the guard; snapshot to clean after.
    mkdirSync(CACHE, { recursive: true });
    const cacheBefore = new Set(readdirSync(CACHE));
    const guardTmp = mkdtempSync(join(tmpdir(), `suite-${slug}-`));

    const vars = {
      TZ: "Asia/Jerusalem",
      TMPDIR: guardTmp,
      DATABASE_URL: target,
      TEST_DATABASE_URL: target,
      CHECK_DB_URL: target,
      CHECK_CONCURRENCY_DB_URL: target,
      CHECK_MARK_CLEAN_DB_URL: target,
      CHECK_SOURCES_DB_URL: target,
      ...EPHEMERAL,
    };
    writeFileSync(ENV_LOCAL, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");

    const started = Date.now();
    const r = spawnSync("pnpm", ["run", name], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: { ...process.env, ...vars },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ms = Date.now() - started;
    const out = (r.stdout || "") + "\n" + (r.stderr || "");
    writeFileSync(join(OUT_DIR, "logs", `${slug}.txt`), out);

    let verdict, why = "";
    if (r.error?.code === "ETIMEDOUT" || (r.signal && r.status === null)) {
      verdict = "cannot-run";
      why = `timeout ${TIMEOUT_MS}ms`;
    } else if (r.status === 0) verdict = "pass";
    else if (r.status === 2) {
      verdict = "cannot-run";
      why = out.split("\n").filter((l) => l.trim()).slice(-2).join(" | ").slice(0, 200);
    } else {
      verdict = "fail";
      const collected = out.match(/COLLECT-ALL: (\d+) assertion failure/);
      why = (collected ? `${collected[1]} assertion failure(s): ` : "") +
        out.split("\n").filter((l) => /✗|FAILED|Error|error/.test(l)).slice(0, 3).join(" | ").slice(0, 260);
    }
    results.push({ name, mode, verdict, why, ms });
    console.log(`${String(i).padStart(2)}/${checks.length} ${verdict.padEnd(11)} ${mode.padEnd(9)} ${name} (${ms}ms)`);

    // teardown: drop the DB (FORCE — a guard may leave a pooled connection
    // open for a moment), remove what the guard left in the cache + tmp
    if (db) { try { psqlAdmin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } catch {} }
    rmSync(guardTmp, { recursive: true, force: true });
    try {
      for (const entry of readdirSync(CACHE)) {
        if (!cacheBefore.has(entry) && entry !== "check-suite") {
          rmSync(join(CACHE, entry), { recursive: true, force: true });
        }
      }
    } catch {}
  }
} finally {
  rmSync(ENV_LOCAL, { force: true });
  if (hadEnvLocal) renameSync(ENV_BACKUP, ENV_LOCAL);
  if (!REUSE_TEMPLATE && !KEEP_TEMPLATE) {
    try { psqlAdmin(`DROP DATABASE IF EXISTS ${TEMPLATE}`); } catch {}
  }
}

writeFileSync(JSON_OUT, JSON.stringify({ seed: SHUFFLE ? SEED : null, template: TEMPLATE, results }, null, 1));
const n = (v) => results.filter((r) => r.verdict === v).length;
console.log(`\n=== TOTALS: pass=${n("pass")} fail=${n("fail")} cannot-run=${n("cannot-run")} of ${results.length}`);
console.log(`=== results: ${JSON_OUT}`);
if (n("fail") > 0) process.exitCode = 1;
