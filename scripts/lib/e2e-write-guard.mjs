// ============================================================
// Fail-closed guard for WRITE-CAPABLE browser / E2E automation.
//
// Root cause of the 2026-07-04 incident: a "proof" drove the live production
// UI (guesthub.bios.co.il :3007, prod tenant) against the only database, and a
// cleanup used a content predicate (price=900) that deleted real rows. This
// guard makes that impossible: any automation that can submit a form or write
// the DB must call assertE2EWriteAllowed() BEFORE launching a browser or
// issuing a write. Default is refusal. Mirrors scripts/seed.mjs (assertSafeToSeed).
//
// It NEVER prints the password (parseDbTarget returns identifiers only).
// ============================================================

// Production markers — shared with the seed guard. The prod DB user is
// "postgres.bios-vps", already covered by the "bios-vps" substring.
export const PROD_MARKERS = ["bios-vps", "guesthub.bios.co.il", "db.bios.co.il"];
export const PROD_TENANT = "68139d06-58c4-4043-b256-4691f83e1556";
export const PROD_HOST = "guesthub.bios.co.il";
export const PROD_PORT = "3007";

export function parseDbTarget(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname || "?", port: u.port || "?", db: u.pathname.replace(/^\//, "") || "?", user: decodeURIComponent(u.username) || "?" };
  } catch { return { host: "?", port: "?", db: "?", user: "?" }; }
}

const hostOf = (v) => { try { return new URL(v).hostname.toLowerCase(); } catch { return String(v || "").toLowerCase(); } };
const portOf = (v) => { try { return new URL(v).port || ""; } catch { return ""; } };

// Pure: decide whether write-capable E2E is permitted. Fail-closed — EVERY
// condition must hold. `opts` overrides env for baseUrl/port/tenant so a caller
// can pass its actual target; otherwise they come from env.
export function evaluateE2EGuard(env = process.env, opts = {}) {
  const url = env.DATABASE_URL || "";
  const target = parseDbTarget(url);
  const baseUrl = opts.baseUrl ?? env.E2E_BASE_URL ?? "";
  const port = String(opts.port ?? env.E2E_PORT ?? portOf(baseUrl) ?? "");
  const tenantId = opts.tenantId ?? env.E2E_TENANT_ID ?? "";
  const allowTenants = (env.E2E_TEST_TENANTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const hay = `${url} ${baseUrl} ${env.NEXT_PUBLIC_APP_URL || ""}`.toLowerCase();
  const reasons = [];

  if (env.E2E_WRITE_OK !== "1") reasons.push("missing explicit opt-in: E2E_WRITE_OK=1");
  if (!["development", "test"].includes(env.E2E_ENV || "")) reasons.push('E2E_ENV must be "development" or "test"');

  const marker = PROD_MARKERS.find((m) => hay.includes(m.toLowerCase()));
  if (marker) reasons.push(`production marker present: "${marker}"`);
  if (target.user.toLowerCase().includes("bios-vps")) reasons.push(`production DB user: "${target.user}"`);

  const dbMarker = env.E2E_DB_MARKER || "";
  if (!dbMarker) reasons.push("missing approved test-DB marker: set E2E_DB_MARKER to a substring of the test DATABASE_URL");
  else if (!url.toLowerCase().includes(dbMarker.toLowerCase())) reasons.push(`approved test-DB marker "${dbMarker}" not found in DATABASE_URL`);

  if (!tenantId) reasons.push("no target tenant supplied (opts.tenantId / E2E_TENANT_ID)");
  else if (tenantId === PROD_TENANT) reasons.push("target tenant is the PRODUCTION tenant");
  else if (!allowTenants.includes(tenantId)) reasons.push("target tenant is not in E2E_TEST_TENANTS allowlist");

  if (hostOf(baseUrl) === PROD_HOST) reasons.push(`application base URL is production (${PROD_HOST})`);
  if (port === PROD_PORT) reasons.push(`application port is the production port (${PROD_PORT})`);

  return { ok: reasons.length === 0, reasons, target };
}

// Enforce. Prints safe identifiers only. Returns boolean; `exit` is injectable
// so the safety test can assert without terminating the process. MUST be called
// before any browser launch or server-action submission.
export function assertE2EWriteAllowed(env = process.env, opts = {}, exit = (c) => process.exit(c)) {
  const { ok, reasons, target } = evaluateE2EGuard(env, opts);
  console.log(`e2e target → db.host=${target.host} db.port=${target.port} db=${target.db} db.user=${target.user} app=${opts.baseUrl ?? env.E2E_BASE_URL ?? "?"}`);
  if (!ok) {
    console.error("✗ WRITE-CAPABLE E2E BLOCKED (fail-closed) — refusing before browser launch / any write:");
    for (const r of reasons) console.error(`  - ${r}`);
    console.error("Write E2E requires a dedicated test DB/environment: E2E_WRITE_OK=1 E2E_ENV=test E2E_DB_MARKER=<test-db> E2E_TENANT_ID=<test-tenant> against a non-production host/port.");
    exit(1);
    return false; // reached only when a test injects a non-terminating exit
  }
  console.log("✓ e2e write guard passed — isolated test target confirmed.");
  return true;
}

// Wrap a browser launch so the guard runs FIRST; the launch thunk is never
// invoked when blocked (proves "refusal before launch").
export async function launchGuardedBrowser(launch, env = process.env, opts = {}) {
  if (!assertE2EWriteAllowed(env, opts, () => { throw new GuardBlocked(); })) throw new GuardBlocked();
  return launch();
}
export class GuardBlocked extends Error { constructor() { super("e2e write guard blocked"); this.name = "GuardBlocked"; } }

// ---------- fixtures & cleanup policy ----------
// Unique per-run tag so every test-created record is attributable and cleanable
// by exact identity. `seed` varies the id without Date.now (callers may pass one).
export function newRunId(seed = `${process.pid}-${process.hrtime.bigint()}`) {
  return `e2e_${String(seed).replace(/[^a-z0-9]/gi, "").slice(-16)}`;
}

// Cleanup MUST target exact ids / run ids — never a content predicate. Throws on
// anything that isn't a non-empty list of exact string ids.
export function assertExactCleanup(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("cleanup requires a non-empty array of exact record ids / run ids");
  if (!ids.every((x) => typeof x === "string" && x.length >= 8)) throw new Error("cleanup ids must be exact string identifiers");
  return true;
}

// Reject the broad predicates that caused the incident.
const BROAD = [/\bprice\s*=/i, /\bdelete\b(?![\s\S]*\b(id|run_id|correlation_id)\b)/i, /where\s+tenant_id\s*=\s*\S+\s*$/i, /\b(900|test|demo)\b\s*$/i];
export function forbidBroadPredicate(text) {
  const t = String(text || "");
  const hit = BROAD.find((re) => re.test(t));
  if (hit) throw new Error(`refusing broad cleanup predicate (use exact ids): matched ${hit}`);
  return true;
}
