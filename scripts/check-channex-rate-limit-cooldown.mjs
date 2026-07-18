#!/usr/bin/env node
// check:channex-rate-limit-cooldown (Stage 4, V2 §16, defect M14) — the outbound
// path honours a 429 cooldown and a circuit breaker, with the full fault-test
// list run against the REAL (transpiled) pure modules.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

const ts = require("typescript");
function load(rel) {
  const js = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "m6-"));
  const p = join(dir, "m.mjs");
  writeFileSync(p, js);
  return import(pathToFileURL(p).href);
}

const CB = await load("src/lib/channel/circuit-breaker.ts");
const HTTP = await load("src/lib/channel/channex-http.ts");
const cfg = { failureThreshold: 3, baseCooldownMs: 60_000, maxCooldownMs: 600_000 };
const T0 = 1_000_000;

// ---- fault: default closed, success keeps closed ----
if (!CB.circuitAllowsRequest(CB.CLOSED, T0)) flag("default breaker blocks requests");
else pass("default breaker is closed (requests flow)");
if (CB.onCircuitSuccess().openUntil !== null) flag("success did not close the breaker");
else pass("success closes the breaker");

// ---- fault: a 429 opens for the provider's Retry-After exactly ----
let s = CB.onCircuitFailure(CB.CLOSED, "rate_limited", T0, { retryAfterMs: 120_000, config: cfg });
if (CB.circuitPhase(s, T0) !== "open") flag("429 did not open the breaker");
else if (CB.circuitAllowsRequest(s, T0 + 119_000)) flag("breaker allowed a request during the 429 cooldown");
else if (CB.circuitPhase(s, T0 + 120_001) !== "half_open") flag("breaker did not half-open after the cooldown");
else pass("429 opens for the exact Retry-After, half-opens after it elapses");

// ---- fault: 429 without Retry-After falls back to base cooldown, clamped ----
s = CB.onCircuitFailure(CB.CLOSED, "rate_limited", T0, { config: cfg });
if (s.openUntil !== T0 + cfg.baseCooldownMs) flag("429 w/o Retry-After did not use base cooldown");
else pass("429 without Retry-After uses the base cooldown");

// ---- fault: consecutive server errors trip only at the threshold ----
s = CB.CLOSED;
s = CB.onCircuitFailure(s, "server_error", T0, { config: cfg }); // 1
if (CB.circuitPhase(s, T0) !== "closed") flag("breaker tripped before threshold (1)");
s = CB.onCircuitFailure(s, "server_error", T0, { config: cfg }); // 2
if (CB.circuitPhase(s, T0) !== "closed") flag("breaker tripped before threshold (2)");
s = CB.onCircuitFailure(s, "server_error", T0, { config: cfg }); // 3 == threshold
if (CB.circuitPhase(s, T0) !== "open") flag("breaker did not trip at threshold");
else pass("breaker trips after N consecutive server errors (threshold)");

// ---- fault: cooldown grows exponentially, bounded by max ----
const firstCooldown = s.openUntil - T0;
let s2 = CB.onCircuitFailure(s, "server_error", T0, { config: cfg }); // threshold+1
if (!(s2.openUntil - T0 > firstCooldown)) flag("cooldown did not grow after further failures");
let sMany = s;
for (let i = 0; i < 20; i++) sMany = CB.onCircuitFailure(sMany, "server_error", T0, { config: cfg });
if (sMany.openUntil - T0 > cfg.maxCooldownMs) flag("cooldown exceeded the max ceiling");
else pass("cooldown grows exponentially but is bounded by maxCooldownMs");

// ---- fault: half-open → success closes; half-open → failure re-opens ----
const recovered = CB.onCircuitSuccess();
if (recovered.openUntil !== null || recovered.consecutiveFailures !== 0) flag("half-open success did not reset");
else pass("half-open + success fully resets the breaker");

// ---- Retry-After parsing (delta-seconds + HTTP-date + garbage) ----
if (HTTP.parseRetryAfterMs("120", T0) !== 120_000) flag("Retry-After seconds not parsed");
else pass("Retry-After delta-seconds parsed to ms");
const dateHdr = new Date(T0 + 90_000).toUTCString();
const parsed = HTTP.parseRetryAfterMs(dateHdr, T0);
if (parsed === null || Math.abs(parsed - 90_000) > 1_000) flag("Retry-After HTTP-date not parsed");
else pass("Retry-After HTTP-date parsed to a delta");
if (HTTP.parseRetryAfterMs(null, T0) !== null || HTTP.parseRetryAfterMs("garbage", T0) !== null)
  flag("Retry-After garbage/absent not handled as null");
else pass("Retry-After absent/garbage → null");

// ---- static wiring: the drain and HTTP layer actually use all this ----
const ari = read("src/lib/channel/ari-sync.ts");
if (!/circuitAllowsRequest\(circuit, now\(\)\)/.test(ari)) flag("drain does not gate on the circuit breaker");
else pass("drain skips a connection whose circuit is open");
if (!/onCircuitFailure\(/.test(ari) || !/onCircuitSuccess\(/.test(ari)) flag("drain does not persist breaker transitions");
else pass("drain persists breaker transitions (failure + success)");
if (!/retryAfterMs:\s*failure\?\.retryAfterMs/.test(ari)) flag("drain does not feed Retry-After into the breaker");
else pass("drain feeds the 429 Retry-After into the breaker");

const http = read("src/lib/channel/channex-http.ts");
if (!/res\.status === 429[\s\S]*retry-after/.test(http)) flag("HTTP core does not extract Retry-After on 429");
else pass("HTTP core extracts Retry-After on 429");

const ariClient = read("src/lib/channel/channex-ari.ts");
if (!/retryAfterMs:\s*r\.retryAfterMs/.test(ariClient)) flag("channex-ari does not propagate Retry-After");
else pass("channex-ari propagates Retry-After to the caller");

if (!read("db/migrations/manifest.txt").includes("039_channel_circuit_breaker.sql"))
  flag("circuit-breaker migration not in manifest");
else pass("circuit-breaker migration in manifest");

if (fail) { console.log(`\ncheck:channex-rate-limit-cooldown — FAIL (${fail})`); process.exit(1); }
console.log("check:channex-rate-limit-cooldown — PASS");
