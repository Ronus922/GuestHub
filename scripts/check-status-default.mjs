// The default reservation status comes from ONE place and one place only: the
// status the user starred in Settings → Reservation Statuses. Nothing else may
// decide it — not a literal, not the payment state, not the display order, not
// "the first active row", not a per-source special case.
//
// There was no test holding this line, which is why the question "does D81
// hardcode a pending-payment default?" could even be asked. These are static
// source assertions: they read the real files and fail the moment someone
// reintroduces a hardcoded default. Usage: node scripts/check-status-default.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const read = (p) => readFileSync(p, "utf8");

const ACTIONS = "src/app/(dashboard)/reservations/actions.ts";
const IMPORT = "src/lib/channel/booking-import.ts";
const SETTINGS = "src/app/(dashboard)/settings/status-actions.ts";

// The canonical star query. Both creation paths must ask this exact question:
// "which ACTIVE workflow status did this tenant star?" — nothing more.
const STAR = /category\s*=\s*'workflow_statuses'[\s\S]{0,120}?is_active[\s\S]{0,80}?metadata->>'is_default'\)?\s*=\s*'true'/;

// ---- 1. every creation path resolves the default from the star ----
const actions = read(ACTIONS);
const imported = read(IMPORT);

assert.match(actions, STAR, "manual creation must resolve the default from the starred ACTIVE status");
assert.match(imported, STAR, "OTA/Channex import must resolve the default from the SAME starred ACTIVE status");
ok("both creation paths (manual + OTA import) read the starred Settings default");

// ---- 2. the default is never inferred from anything else ----
// Slice out each resolver query and prove it leans on no other signal.
for (const [label, src] of [["manual", actions], ["import", imported]]) {
  const m = src.match(/SELECT id FROM guesthub\.lookup_items[\s\S]{0,240}?'true'`/);
  assert.ok(m, `${label}: could not locate the default-status query`);
  const q = m[0];
  for (const forbidden of ["sort_order", "ORDER BY", "LIMIT", "paid_amount", "balance", "payment"]) {
    assert.ok(!q.includes(forbidden),
      `${label}: the default-status query must not consider ${forbidden} — the star is the only signal`);
  }
  ok(`${label}: default is not inferred from order, position or payment state`);
}

// ---- 3. no hardcoded fallback when nothing is starred ----
// No star → NULL. A fabricated fallback ("confirmed", "ממתין לתשלום", the first
// row, …) would silently override the user's Settings choice.
assert.match(actions, /workflowStatusId\s*=\s*await\s+defaultWorkflowStatusId\(tx,\s*actor\.tenantId\);/,
  "manual creation must call the resolver, not inline a default");
assert.ok(!/defaultWorkflowStatusId\([^)]*\)\s*(\?\?|\|\|)\s*["'`]/.test(actions),
  "manual creation must not fall back to a hardcoded status when nothing is starred");
assert.match(imported, /\$\{wf\?\.id\s*\?\?\s*null\}/,
  "OTA import must insert NULL when nothing is starred — never a fabricated status");
ok("no star → NULL; neither path invents a default status");

// ---- 4. no status literal is ever assigned as a workflow status ----
// Guards against `workflow_status_id = <some label/uuid>` creeping in anywhere.
const LABELS = ["ממתין לתשלום", "טרם שולם", "הזמנה אושרה", "ממתין לאישור"];
const walk = (dir) => readdirSync(dir).flatMap((e) => {
  const p = join(dir, e);
  return statSync(p).isDirectory() ? walk(p) : p.match(/\.tsx?$/) ? [p] : [];
});
for (const file of walk("src")) {
  const src = read(file);
  for (const line of src.split("\n")) {
    if (!/workflow_status_id|workflowStatusId/.test(line)) continue;
    if (/^\s*(\/\/|\*)/.test(line)) continue; // comments may name statuses
    for (const label of LABELS) {
      assert.ok(!line.includes(label),
        `${file}: a workflow status is being set from the literal "${label}" — the star is the only source`);
    }
  }
}
ok("no source file assigns a workflow status from a hardcoded status label");

// ---- 5. the star stays exclusive, and cannot be starved ----
const settings = read(SETTINGS);
assert.match(settings, /SET metadata = metadata - 'is_default'[\s\S]{0,200}?'is_default'\)?\s*=\s*'true'/,
  "starring a status must first demote the previous default (exactly one star)");
assert.match(settings, /jsonb_set\(metadata, '\{is_default\}', 'true'::jsonb\)/,
  "starring a status must set the star on the chosen row");
assert.match(settings, /!input\.isActive\s*&&\s*target\.is_default/,
  "deactivating the starred status must be refused — it would leave no default");
assert.match(settings, /if\s*\(target\.is_default\)/,
  "deleting the starred status must be refused — it would leave no default");
ok("Settings keeps exactly one star, and refuses to deactivate or delete it");

// ---- 6. an ordinary edit keeps the STORED status (D85) ----
// The retired "סטטוס שהות" select must not have been replaced by a client-side
// default: an omitted status means "keep what is stored", read in-transaction.
const validation = read("src/lib/validation/reservation.ts");
assert.match(validation, /status:\s*z\.enum\(EDITABLE_STATUSES\)\.optional\(\)/,
  "an editor save may omit status entirely");
assert.match(actions, /const nextStatus = input\.status \?\? existing\.status;/,
  "an omitted status must keep the STORED lifecycle — never a hardcoded default");
ok("an ordinary save keeps the stored status; only explicit check-in/out send one");

console.log(`\nall ${n} status-default checks passed — the starred Settings status is the sole source`);
