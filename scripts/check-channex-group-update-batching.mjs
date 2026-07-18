#!/usr/bin/env node
// check:channex-group-update-batching (Stage 4, V2 §15) — a Group Update over
// multiple rooms, plans, date ranges and weekday filters, with combined
// restrictions, becomes ONE logical sync envelope and ONE combined Channex
// request per dimension; Min Stay Arrival/Through both flow through unchanged.
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

// 1) expansion: the Group Update action covers all §15 dimensions
const actions = read("src/app/(dashboard)/rates/actions.ts");
const expansions = {
  "multi-room/unit": /sellableUnitIds/,
  "multi-date range": /eachDay\(input\.dateFrom/,
  "weekday filter": /input\.weekdays/,
  "min stay through": /min_stay_through/,
  "min stay arrival": /min_stay_arrival/,
  "stop sell": /stop_sell/,
  "closed to arrival/departure": /closed_to_arrival[\s\S]*closed_to_departure/,
};
for (const [name, re] of Object.entries(expansions))
  if (!re.test(actions)) flag(`Group Update does not expand ${name}`);
if (!fail) pass("Group Update expands rooms × plans × ranges × weekdays × combined restrictions");

// 2) single logical envelope: writeRateCells emits exactly ONE markAriDirty over
//    the whole span, plan scope NULL (all channel-visible plans), rates+restrictions
const service = read("src/lib/rates/service.ts");
const dirtyCalls = (service.match(/markAriDirty\(/g) || []).length;
if (dirtyCalls !== 1) flag(`writeRateCells makes ${dirtyCalls} markAriDirty calls, expected exactly 1`);
else pass("writeRateCells marks a single ARI dirty envelope");
if (!/dateFrom = dates\[0\]/.test(service) || !/dateTo = addDays\(dates\[dates\.length - 1\], 1\)/.test(service))
  flag("dirty envelope does not span min→max of the update");
else pass("dirty envelope spans the whole update range (min→max)");
if (!/kinds:\s*\["rates",\s*"restrictions"\]/.test(service))
  flag("dirty envelope does not cover rates+restrictions");
else pass("dirty envelope covers rates + restrictions");

// 3) behavioral: a group-update-shaped projection collapses to ONE combined request
const ts = require("typescript");
const js = ts.transpileModule(read("src/lib/channel/ari-payloads.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), "gu-"));
const modPath = join(dir, "p.mjs");
writeFileSync(modPath, js);
const P = await import(pathToFileURL(modPath).href);

const rooms = ["r1", "r2", "r3", "r4"];
const plans = ["flex", "nonref"];
const combo = new Map();
for (const r of rooms) for (const p of plans) combo.set(`${r}|${p}`, `chx-${r}-${p}`);
// weekday-filtered range: Mondays+Fridays across ~8 weeks
const dates = [];
const t = new Date("2026-03-01T12:00:00Z");
for (let i = 0; i < 56; i++) {
  const day = t.getUTCDay();
  if (day === 1 || day === 5) dates.push(t.toISOString().slice(0, 10));
  t.setUTCDate(t.getUTCDate() + 1);
}
const inputs = [];
for (const r of rooms) for (const p of plans) for (const d of dates)
  inputs.push({
    roomId: r, planId: p, date: d,
    rates: [{ occupancy: 2, rate: 450 }],
    minStayArrival: 2, minStayThrough: 3, maxStay: 14,
    stopSell: false, closedToArrival: true, closedToDeparture: false,
  });
const built = P.buildRestrictionValues(inputs, "prop", combo);
if (built.batches.length !== 1) flag(`group update produced ${built.batches.length} requests, expected 1 combined request`);
else pass(`group update = 1 combined restrictions request (${built.batches[0].values.length} values, ${inputs.length} cells)`);

// 4) Min Stay Arrival + Through both survive to the payload
const sample = built.batches[0]?.values ?? [];
const hasArrival = sample.some((v) => v.min_stay_arrival === 2);
const hasThrough = sample.some((v) => v.min_stay_through === 3);
if (!hasArrival) flag("min_stay_arrival did not reach the payload");
if (!hasThrough) flag("min_stay_through did not reach the payload");
if (hasArrival && hasThrough) pass("min_stay_arrival AND min_stay_through both reach the payload");

// combined restrictions preserved (stop_sell / CTA present)
if (!sample.some((v) => v.closed_to_arrival === true)) flag("closed_to_arrival lost");
else pass("combined restrictions (CTA) preserved through batching");

// 5) determination is declared
const decl = read("docs/channex/MIN_STAY_SEMANTICS.md");
if (!/min_stay_arrival/.test(decl) || !/min_stay_through/.test(decl))
  flag("MIN_STAY_SEMANTICS.md does not declare both fields");
else pass("Min Stay Arrival/Through semantics declared in docs/channex/MIN_STAY_SEMANTICS.md");

if (fail) { console.log(`\ncheck:channex-group-update-batching — FAIL (${fail})`); process.exit(1); }
console.log("check:channex-group-update-batching — PASS");
