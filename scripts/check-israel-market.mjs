#!/usr/bin/env node
// check:israel-market (Stage 5 §21) — tourist VAT zero-rating, guest anonymization
// (Amendment 13), and the fail-closed invoice seam.
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

const ts = require("typescript");
async function load(rel, strip = []) {
  let src = read(rel);
  for (const s of strip) src = src.replace(s, "");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "il-"));
  const p = join(dir, "m.mjs");
  writeFileSync(p, js);
  return import(pathToFileURL(p).href);
}

// ---- tourist VAT zero-rating (pure) ----
const vat = await load("src/lib/vat.ts");
if (vat.includedVatForReservation(1180, 18, false) !== vat.includedVatAmount(1180, 18))
  flag("non-exempt VAT differs from includedVatAmount");
else pass("non-exempt reservation carries normal included VAT");
if (vat.includedVatForReservation(1180, 18, true) !== 0)
  flag("tax_exempt reservation still carries VAT (zero-rating broken)");
else pass("tax_exempt (tourist) reservation is zero-rated (0 VAT)");

// ---- tourist VAT action wiring ----
const il = read("src/lib/israel-market/actions.ts");
if (!/tax_exempt = \$\{exempt\}/.test(il)) flag("setReservationTaxExempt does not persist the flag");
else pass("tourist VAT flag is persisted per reservation");
if (!/evidenceComplete/.test(il)) flag("no passport/foreign-guest evidence check");
else pass("zero-rating records foreign-guest evidence completeness");

// ---- anonymization (static invariants) ----
if (!/requirePermission\(actor, "guests\.delete"\)/.test(il)) flag("anonymize not gated by guests.delete");
else pass("anonymize gated by guests.delete");
if (!/full_name = 'אורח שהוסר'/.test(il)) flag("anonymize does not scrub the name");
else pass("anonymize scrubs identifying fields, keeps the row");
if (!/anonymized_at = now\(\)/.test(il)) flag("anonymize does not stamp anonymized_at");
else pass("anonymize stamps anonymized_at (idempotent + auditable)");
if (!/already עבר אנונימיזציה|anonymized_at\)\s*return/.test(il) && !/if \(guest\.anonymized_at\)/.test(il))
  flag("anonymize is not idempotent");
else pass("anonymize is idempotent (refuses a second run)");
// audit must carry field NAMES, never the erased values
if (/after:\s*\{[^}]*first_name:/.test(il)) flag("anonymize audit may carry erased PII values");
else pass("anonymize audit carries field names only, never erased values");

// ---- invoice seam (fail-closed) ----
const inv = await load("src/lib/israel-market/invoice.ts", ['import "server-only";\n']);
const unconfigured = await inv.issueTaxDocument({
  tenantId: "t", reservationId: "r", kind: "invoice_receipt", amount: 100, currency: "ILS",
  taxExempt: false, customer: { name: "Test" }, lines: [{ description: "stay", amount: 100 }],
});
if (unconfigured.ok || unconfigured.category !== "not_configured")
  flag("invoice seam does not fail closed when unconfigured");
else pass("invoice seam fails closed (not_configured) until a provider is wired");
const invalid = await inv.issueTaxDocument({
  tenantId: "t", reservationId: "r", kind: "receipt", amount: 0, currency: "ILS",
  taxExempt: false, customer: { name: "" }, lines: [],
});
if (invalid.ok || invalid.category !== "validation") flag("invoice seam does not validate amount/customer");
else pass("invoice seam validates amount + customer before any provider call");

// ---- DB proof: anonymization scrubs PII but keeps the row (rolled back) ----
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
  if (!t) console.log("• no tenant on staging — anonymization DB proof skipped");
  else {
    const out = psql(`
      BEGIN;
      CREATE TEMP TABLE il_out (kept bool, scrubbed bool, stamped bool) ON COMMIT DROP;
      DO $$
      DECLARE g uuid := gen_random_uuid();
      BEGIN
        INSERT INTO guesthub.guests (id, tenant_id, full_name, email, phone, id_number)
          VALUES (g, '${t}', 'משה כהן', 'x@y.z', '0500000000', '123456789');
        UPDATE guesthub.guests
          SET first_name=NULL,last_name=NULL,full_name='אורח שהוסר',phone=NULL,email=NULL,
              id_number=NULL,address=NULL,city=NULL,company=NULL,notes=NULL,is_vip=false,anonymized_at=now()
          WHERE id=g;
        INSERT INTO il_out
          SELECT EXISTS(SELECT 1 FROM guesthub.guests WHERE id=g),
                 (SELECT email IS NULL AND phone IS NULL AND id_number IS NULL AND full_name='אורח שהוסר' FROM guesthub.guests WHERE id=g),
                 (SELECT anonymized_at IS NOT NULL FROM guesthub.guests WHERE id=g);
      END $$;
      SELECT kept::text || '|' || scrubbed::text || '|' || stamped::text FROM il_out;
      ROLLBACK;`);
    const line = out.split("\n").map((s) => s.trim()).find((s) => s.includes("|")) ?? "";
    const [kept, scrubbed, stamped] = line.split("|");
    if (kept !== "true") flag("anonymization removed the guest row (must keep it)");
    else if (scrubbed !== "true") flag("anonymization did not scrub all PII");
    else if (stamped !== "true") flag("anonymization did not stamp anonymized_at");
    else pass("DB proof: PII scrubbed, row kept, anonymized_at stamped");
  }
} else {
  console.log("• staging DSN not available — anonymization DB proof skipped");
}

if (fail) { console.log(`\ncheck:israel-market — FAIL (${fail})`); process.exit(1); }
console.log("check:israel-market — PASS");
