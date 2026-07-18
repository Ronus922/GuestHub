#!/usr/bin/env node
// check:reports (Stage 5 §11) — reports are safe (read-only, tenant-scoped),
// the CSV export is injection-hardened, and the underlying aggregates run against
// the real schema.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

// ---- static: reports are read-only + tenant-scoped ----
const q = read("src/lib/reports/queries.ts");
if (/\b(INSERT|UPDATE|DELETE)\b/i.test(q.replace(/\/\/[^\n]*/g, ""))) flag("reports contain a write statement");
else pass("report queries are read-only (SELECT only)");
const fns = [...q.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
if (fns.length < 6) flag(`expected the core report set, found ${fns.length}`);
else pass(`report functions present: ${fns.join(", ")}`);
// each report must be tenant-scoped
const bodies = q.split(/export async function /).slice(1);
for (const b of bodies) {
  const name = b.slice(0, b.indexOf("("));
  // only functions that OWN a full query must carry the tenant filter; thin
  // wrappers that delegate to a tenant-scoped helper (stayList) are fine.
  if (/FROM guesthub\./.test(b) && !/tenant_id = \$\{tenantId\}|\(\$\{tenantId\}/.test(b))
    flag(`report ${name} is not tenant-scoped`);
}
if (!fail) pass("every report is tenant-scoped");
if (!/INVENTORY_BLOCKING_STATUSES/.test(q)) flag("reports do not use canonical blocking statuses");
else pass("reports use the canonical INVENTORY_BLOCKING_STATUSES");

// ---- CSV export: quoting + formula-injection + BOM ----
const ts = require("typescript");
const js = ts.transpileModule(read("src/lib/reports/csv.ts").replace('import "server-only";\n', ""), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), "csv-"));
const modPath = join(dir, "csv.mjs");
writeFileSync(modPath, js);
const { toCsv } = await import(pathToFileURL(modPath).href);
const out = toCsv(["a", "b"], [{ x: 'he said "hi", ok', y: "=SUM(A1)" }, { x: "plain", y: "line\nbreak" }], ["x", "y"]);
if (!out.startsWith("﻿")) flag("CSV missing UTF-8 BOM");
else pass("CSV has a UTF-8 BOM (Excel-safe Hebrew)");
if (!out.includes('"he said ""hi"", ok"')) flag("CSV does not RFC-4180 quote commas/quotes");
else pass("CSV quotes commas + doubles inner quotes");
if (!out.includes("'=SUM(A1)")) flag("CSV does not neutralize formula injection");
else pass("CSV neutralizes formula-injection (=+-@ prefixed)");
if (!out.includes('"line\nbreak"')) flag("CSV does not quote embedded newlines");
else pass("CSV quotes embedded newlines");

// ---- data export (§1 completeness) is read-only, tenant-scoped, audited ----
const exp = read("src/lib/reports/export.ts");
if (/\b(INSERT|UPDATE|DELETE)\b/i.test(exp.replace(/\/\/[^\n]*/g, ""))) flag("export contains a write statement");
else pass("data export is read-only");
if (!/exportReservationsCsvAction/.test(exp) || !/exportGuestsCsvAction/.test(exp)) flag("missing reservation/guest CSV export");
else pass("reservation + guest CSV exports present");
if (!/toCsv\(/.test(exp)) flag("export does not use the hardened CSV serializer");
else pass("exports use the injection-hardened CSV serializer");
if ((exp.match(/requirePermission\(/g) || []).length < 2) flag("export actions not permission-gated");
else pass("export actions are permission-gated");
if (!/action: "export_csv"/.test(exp)) flag("exports are not audited");
else pass("exports are audited (fact of export, not the PII)");

// ---- DB smoke: the aggregate sources run against the real schema ----
function loadEnvStaging() {
  try {
    for (const line of read(".env.staging").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* optional */ }
}
loadEnvStaging();
const dsn = process.env.CHECK_DB_URL || process.env.STAGING_OWNER_URL;
if (dsn && existsSync("/usr/bin/psql")) {
  const psql = (s) => execFileSync("psql", [dsn, "-tAc", s, "-X", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8" }).trim();
  const t = psql(`SELECT id FROM guesthub.tenants ORDER BY created_at LIMIT 1`);
  if (!t) console.log("• no tenant on staging — DB smoke skipped");
  else {
    // occupancy source: room_type_inventory returns sane sums
    const occ = psql(`SELECT COALESCE(SUM(occupied_rooms),0) <= COALESCE(SUM(sellable_rooms),0)
                      FROM guesthub.room_type_inventory('${t}', current_date, current_date + 30)`);
    if (occ !== "t") flag("occupancy: occupied exceeds sellable room-nights");
    else pass("occupancy source runs; occupied ≤ sellable");
    // cash-up aggregate runs
    psql(`SELECT COALESCE(SUM(amount),0) FROM guesthub.payments WHERE tenant_id='${t}' AND status='paid'`);
    pass("cash-up aggregate runs against payments");
    // balances-due aggregate runs
    psql(`SELECT count(*) FROM guesthub.reservations WHERE tenant_id='${t}' AND balance > 0`);
    pass("balances-due aggregate runs against reservations");
  }
} else {
  console.log("• staging DSN not available — DB smoke skipped (static + CSV enforced)");
}

if (fail) { console.log(`\ncheck:reports — FAIL (${fail})`); process.exit(1); }
console.log("check:reports — PASS");
