#!/usr/bin/env node
// check:channex-full-sync-two-requests (Stage 4, V2 §14) — a Full Sync is exactly
// 500 property-local dates delivered in exactly two requests (one availability,
// one rates/restrictions), with a real 10MB size preflight, and a delta-only
// policy afterwards.
//
// Behavioral: transpile the PURE payload builders (ari-payloads.ts) and run them
// on a realistic certification-sized projection; assert the batch counts and the
// preflight. Static: assert the horizon constant, the two-request evidence
// expectation, and that the incremental path never falls back to a full sync.
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

// ---- transpile + import the pure builders ----
const ts = require("typescript");
const js = ts.transpileModule(read("src/lib/channel/ari-payloads.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), "payloads-"));
const modPath = join(dir, "payloads.mjs");
writeFileSync(modPath, js);
const P = await import(pathToFileURL(modPath).href);

// ---- 500 property-local dates ----
const HORIZON = 500;
if (!/export const ARI_HORIZON_DAYS = 500;/.test(read("src/lib/channel/ranges.ts")))
  flag("ARI horizon is not 500 days");
else pass("Full Sync horizon = 500 property-local dates");

// helper: N consecutive ISO dates from a base
function dates(n) {
  const out = [];
  const t = new Date("2026-01-01T12:00:00Z");
  for (let i = 0; i < n; i++) { out.push(t.toISOString().slice(0, 10)); t.setUTCDate(t.getUTCDate() + 1); }
  return out;
}
const ds = dates(HORIZON);

// ---- realistic certification property: 12 rooms, 2 plans, 500 days ----
const rooms = Array.from({ length: 12 }, (_, i) => `room-${i}`);
const plans = ["plan-flex", "plan-nonref"];
const roomTypeMap = new Map(rooms.map((r) => [r, `chx-rt-${r}`]));
const comboMap = new Map();
for (const r of rooms) for (const p of plans) comboMap.set(`${r}|${p}`, `chx-rp-${r}-${p}`);

// availability: mostly 1, a couple of sold days — compresses to a handful/room
const availInputs = [];
for (const r of rooms) for (let i = 0; i < HORIZON; i++)
  availInputs.push({ roomId: r, date: ds[i], availability: i % 60 === 0 ? 0 : 1 });

// restrictions: weekday rate vs weekend rate — compresses to runs, never 1/day
const restrInputs = [];
for (const r of rooms) for (const p of plans) for (let i = 0; i < HORIZON; i++) {
  const weekend = new Date(`${ds[i]}T12:00:00Z`).getUTCDay() % 6 === 0;
  restrInputs.push({
    roomId: r, planId: p, date: ds[i],
    rates: [{ occupancy: 2, rate: weekend ? 520 : 400 }],
    minStayArrival: 1, minStayThrough: null, maxStay: null,
    stopSell: false, closedToArrival: false, closedToDeparture: false,
  });
}

const avail = P.buildAvailabilityValues(availInputs, "prop-cert", roomTypeMap);
const restr = P.buildRestrictionValues(restrInputs, "prop-cert", comboMap);

if (avail.batches.length !== 1) flag(`availability produced ${avail.batches.length} batches, expected 1`);
else pass(`availability = 1 request (${avail.batches[0].values.length} compressed values)`);
if (restr.batches.length !== 1) flag(`restrictions produced ${restr.batches.length} batches, expected 1`);
else pass(`rates/restrictions = 1 request (${restr.batches[0].values.length} compressed values)`);
if (avail.batches.length + restr.batches.length === 2) pass("Full Sync = exactly two requests");

// every produced batch passes the structural + byte preflight
for (const b of [...avail.batches, ...restr.batches]) {
  const err = P.validateAriBatch(b);
  if (err) flag(`cert batch failed preflight: ${err}`);
}
if (!fail) pass("both requests pass the structural + 10MB size preflight");

// ---- size preflight fires on an oversize body ----
const huge = { values: Array.from({ length: 1000 }, () => ({
  property_id: "p", room_type_id: "x".repeat(12_000), date_from: "2026-01-01", date_to: "2026-01-01", availability: 1,
})) };
const bytes = P.payloadByteSize(huge);
if (bytes <= P.PAYLOAD_BYTE_LIMIT) flag("test fixture not actually oversize");
const oversizeErr = P.validateAriBatch(huge);
if (!oversizeErr || !/10MB|bytes/.test(oversizeErr)) flag("size preflight did not reject a >10MB body");
else pass(`size preflight rejects a >10MB body (${(bytes / 1048576).toFixed(1)}MB → "${oversizeErr}")`);

// ---- static: evidence expects two requests + records bytes; delta-only after ----
const ari = read("src/lib/channel/ari-sync.ts");
if (!/expectedRequests:\s*2/.test(ari)) flag("full-sync evidence does not expect 2 requests");
else pass("full-sync evidence expects exactly 2 requests");
if (!/requestBytes:\s*availabilityBytes \+ restrictionBytes/.test(ari)) flag("full-sync evidence records no request bytes");
else pass("full-sync evidence records request bytes (size preflight evidence)");
// delta-only: the drain FUNCTION BODY never triggers a full sync
const drainStart = ari.indexOf("export async function drainAriDirtyRanges");
const drainBody = drainStart >= 0
  ? ari.slice(drainStart, ari.indexOf("\nexport ", drainStart + 1) > 0 ? ari.indexOf("\nexport ", drainStart + 1) : undefined)
  : "";
if (!drainBody) flag("drainAriDirtyRanges not found");
else if (/runInitialFullSync|jobType:\s*"full_sync"/.test(drainBody))
  flag("incremental drain references a full sync (must be delta-only)");
else pass("incremental drain is delta-only (never re-runs Full Sync)");

if (fail) { console.log(`\ncheck:channex-full-sync-two-requests — FAIL (${fail})`); process.exit(1); }
console.log("check:channex-full-sync-two-requests — PASS");
