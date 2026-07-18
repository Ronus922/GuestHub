#!/usr/bin/env node
// check:channex-environment-routing (Stage 4, V2 §11) — crossover impossibility.
//
// Proves that no Channex HTTP call anywhere derives its base URL from a
// hardcoded environment literal. The ONLY place the CHANNEX_BASE_URLS map is
// read is config.ts (through channexBaseUrl()); every call site passes an
// environment that flows from either the production-activation guard
// (effectiveChannexEnvironment) or a DB connection row (conn.environment).
// A stray `CHANNEX_BASE_URLS.production` or a raw host literal would let a
// staging/production crossover slip in — this check makes that fail CI.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const channelDir = join(root, "src", "lib", "channel");
const files = readdirSync(channelDir).filter((f) => f.endsWith(".ts"));

// strip // line comments and /* */ block comments so doc examples like
// "e.g. https://staging.channex.io/api/v1" don't trip the host-literal scan.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

let fail = 0;
const problems = [];
const flag = (file, msg) => { fail++; problems.push(`✗ ${file}: ${msg}`); };

for (const f of files) {
  const raw = readFileSync(join(channelDir, f), "utf8");
  const code = stripComments(raw);

  if (f === "config.ts") {
    // config.ts is the sole owner of the map + the resolver.
    if (!/export function channexBaseUrl\(/.test(code))
      flag(f, "channexBaseUrl() resolver missing from config.ts");
    continue;
  }

  // 1) No module other than config.ts may read the base-URL map as a value.
  if (/CHANNEX_BASE_URLS\s*[.[]/.test(code))
    flag(f, "reads CHANNEX_BASE_URLS directly — must call channexBaseUrl(env)");

  // 2) No raw Channex host literal outside config.ts.
  if (/staging\.channex\.io|app\.channex\.io/.test(code))
    flag(f, "hardcoded Channex host literal — route through channexBaseUrl(env)");

  // 3) No baseUrl assigned a string literal.
  for (const line of code.split("\n")) {
    if (/baseUrl\s*[:=]/.test(line) && /baseUrl\s*[:=]\s*["'`]https?:/.test(line))
      flag(f, `baseUrl assigned a string literal: ${line.trim()}`);
  }
}

// 4) Setup modules must resolve their environment through the guard, never a
//    bare `"staging" as const` literal.
const setupFiles = ["admin.ts", "room-type-admin.ts", "rate-plan-admin.ts"];
for (const f of setupFiles) {
  const code = stripComments(readFileSync(join(channelDir, f), "utf8"));
  if (/CHANNEX_ENV\s*=\s*["']staging["']\s*as const/.test(code))
    flag(f, "CHANNEX_ENV is a hardcoded literal — must be effectiveChannexEnvironment()");
  if (!/effectiveChannexEnvironment\(\)/.test(code))
    flag(f, "does not resolve environment via effectiveChannexEnvironment()");
}

// 5) Runtime send/inbound paths must route off the connection row's own column.
for (const f of ["ari-sync.ts", "booking-import.ts", "inbound-admin.ts", "reporting-admin.ts", "payments-admin.ts"]) {
  const code = stripComments(readFileSync(join(channelDir, f), "utf8"));
  if (!/channexBaseUrl\(conn\.environment\)/.test(code))
    flag(f, "runtime path must call channexBaseUrl(conn.environment)");
}

if (fail) {
  console.log(problems.join("\n"));
  console.log(`\ncheck:channex-environment-routing — FAIL (${fail})`);
  process.exit(1);
}
console.log(`✓ ${basename(channelDir)}: base URLs resolve only through channexBaseUrl()`);
console.log("✓ setup ops resolve environment via the production-activation guard");
console.log("✓ runtime paths route off conn.environment");
console.log("check:channex-environment-routing — PASS");
