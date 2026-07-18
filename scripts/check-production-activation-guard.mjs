#!/usr/bin/env node
// check:production-activation-guard (Stage 4, V2 §26) — production is inactive
// by default and unreachable without an explicit opt-in.
//
// Behavioral: transpile the REAL production-guard.ts (via the installed
// typescript package — no duplicated logic) and execute it under different
// CHANNEX_PRODUCTION_ACTIVATION values, asserting the environment it resolves.
// Static: prove production stays off in the repo and that the guard gates
// production-connection creation.
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const guardSrcPath = join(root, "src", "lib", "channel", "production-guard.ts");

let fail = 0;
const flag = (msg) => { fail++; console.log(`✗ ${msg}`); };
const pass = (msg) => console.log(`✓ ${msg}`);

// ---- transpile the real guard to an executable temp .mjs (type import erased) ----
const ts = require("typescript");
const src = readFileSync(guardSrcPath, "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), "guard-"));
const modPath = join(dir, "guard.mjs");
writeFileSync(modPath, js);

async function evalGuard(activationValue) {
  // fresh process semantics via a child would be cleaner, but the guard reads
  // process.env live per-call, so setting it here before import is sufficient.
  if (activationValue === undefined) delete process.env.CHANNEX_PRODUCTION_ACTIVATION;
  else process.env.CHANNEX_PRODUCTION_ACTIVATION = activationValue;
  // bust the module cache so each scenario re-reads env
  const mod = await import(pathToFileURL(modPath).href + `?v=${activationValue ?? "unset"}`);
  return mod;
}

const guard = await evalGuard(undefined);

// 1) default (flag unset) → staging, not enabled, not operable
if (guard.effectiveChannexEnvironment() !== "staging") flag("default environment is not staging");
else pass("default (flag unset) resolves to staging");
if (guard.isProductionActivationEnabled()) flag("production reported enabled with no flag");
else pass("production not enabled by default");
if (guard.channexActivationStatus().productionOperable) flag("productionOperable true with no flag");
else pass("production not operable by default");

// 2) assertion fails closed when off
try { guard.assertProductionActivationAuthorized(); flag("assert did not throw while off"); }
catch { pass("assertProductionActivationAuthorized throws while off"); }

// 3) explicit off-values stay staging
for (const v of ["0", "false", "off", "", "no", "staging"]) {
  const g = await evalGuard(v);
  if (g.effectiveChannexEnvironment() !== "staging") flag(`value ${JSON.stringify(v)} unexpectedly enabled production`);
}
pass("off/garbage values all resolve to staging");

// 4) explicit on-values enable production
for (const v of ["1", "true", "on", "enabled", "ON", " True "]) {
  const g = await evalGuard(v);
  if (g.effectiveChannexEnvironment() !== "production") flag(`on-value ${JSON.stringify(v)} did not enable production`);
  if (!g.isProductionActivationEnabled()) flag(`on-value ${JSON.stringify(v)} not reported enabled`);
}
pass("explicit on-values enable production");
// restore program default so nothing downstream inherits an on-flag
delete process.env.CHANNEX_PRODUCTION_ACTIVATION;

// ---- static: production stays inactive in the repo ----
// 5) no committed env file turns activation on
const envFiles = readdirSync(root).filter((f) => f.startsWith(".env"));
for (const f of envFiles) {
  let content = "";
  try { content = readFileSync(join(root, f), "utf8"); } catch { continue; }
  const m = content.match(/^CHANNEX_PRODUCTION_ACTIVATION\s*=\s*(.+)$/m);
  if (m && ["1", "true", "on", "enabled"].includes(m[1].trim().toLowerCase()))
    flag(`${f} activates production (CHANNEX_PRODUCTION_ACTIVATION=${m[1].trim()})`);
}
if (!fail) pass("no committed env file activates production");

// 6) creating a production connection is gated by the guard
const adminSrc = readFileSync(join(root, "src", "lib", "channel", "admin.ts"), "utf8");
if (!/input\.environment === "production"\)\s*assertProductionActivationAuthorized\(\)/.test(adminSrc))
  flag("upsertChannelConnectionAction does not gate production creation with the guard");
else pass("production-connection creation is guarded");

if (fail) { console.log(`\ncheck:production-activation-guard — FAIL (${fail})`); process.exit(1); }
console.log("check:production-activation-guard — PASS");
