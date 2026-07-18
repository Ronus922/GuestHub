#!/usr/bin/env node
// check:maintenance-closures (Stage 5 §8) — typed OOO/OOS closures. An OOO block
// removes availability and syncs; an OOS note is dirty-but-sellable and never
// reduces availability nor touches the outbox. DB proof via sellable_unit_inventory
// + static invariants on the actions.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// ---- static: only OOO marks the outbox / blocks; OOS never does ----
const cal = read("src/app/(dashboard)/calendar/actions.ts");
if (!/const isOoo = input\.kind === "ooo"/.test(cal)) flag("createClosure does not branch on kind");
else pass("createClosure branches on OOO vs OOS");
// the conflict check + markAriDirty must be inside the isOoo guard on create
const createBlock = cal.slice(cal.indexOf("createClosureAction"), cal.indexOf("deleteClosureAction"));
if (!/if \(isOoo\)[\s\S]{0,200}checkRoomAvailability/.test(createBlock)) flag("OOS is subject to the OOO conflict check");
else pass("only OOO is conflict-checked (OOS may overlap harmlessly)");
if (!/if \(isOoo\)[\s\S]{0,200}markAriDirty/.test(createBlock)) flag("OOS create marks the outbox");
else pass("only OOO create marks the ARI outbox");
const delBlock = cal.slice(cal.indexOf("deleteClosureAction"));
if (!/closure\.kind === "ooo"[\s\S]{0,200}markAriDirty/.test(delBlock)) flag("OOS delete marks the outbox");
else pass("only OOO delete marks the ARI outbox");

// migration + functions filter kind='ooo'
const mig = read("db/migrations/040_typed_room_closures.sql");
if ((mig.match(/c\.kind = 'ooo'/g) || []).length < 3) flag("not all three availability functions filter kind='ooo'");
else pass("all three availability functions count only OOO closures");
if (!/room_closures_kind_check[\s\S]{0,80}'ooo','oos'/.test(mig)) flag("no kind CHECK constraint");
else pass("kind constrained to ooo/oos");

// ---- DB proof: OOO reduces availability by 1, OOS does not ----
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
  const q = (s) => execFileSync("psql", [dsn, "-tAc", s, "-X", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8" }).trim();
  // Pick a real SU with member rooms, insert an OOS then an OOO closure on one of
  // its rooms, and read sellable_unit_inventory before/after each. The DO block
  // stores results in a temp table which we SELECT to stdout; the whole thing is
  // rolled back so nothing persists.
  const out = q(`
    BEGIN;
    CREATE TEMP TABLE probe_out (base int, oos int, ooo int, skip bool) ON COMMIT DROP;
    DO $$
    DECLARE su uuid; rm uuid; t uuid; d date := current_date + 30; b int; ao int; ax int;
    BEGIN
      SELECT sur.sellable_unit_id, sur.room_id, sur.tenant_id INTO su, rm, t
      FROM guesthub.sellable_unit_rooms sur
      JOIN guesthub.rooms r ON r.id = sur.room_id AND r.status='available' AND r.is_active
      LIMIT 1;
      IF su IS NULL THEN INSERT INTO probe_out VALUES (NULL,NULL,NULL,true); RETURN; END IF;
      SELECT availability INTO b FROM guesthub.sellable_unit_inventory(t,d,d+1) WHERE sellable_unit_id=su;
      INSERT INTO guesthub.room_closures (tenant_id,room_id,start_date,end_date,kind,reason) VALUES (t,rm,d,d+1,'oos','probe-oos');
      SELECT availability INTO ao FROM guesthub.sellable_unit_inventory(t,d,d+1) WHERE sellable_unit_id=su;
      INSERT INTO guesthub.room_closures (tenant_id,room_id,start_date,end_date,kind,reason) VALUES (t,rm,d,d+1,'ooo','probe-ooo');
      SELECT availability INTO ax FROM guesthub.sellable_unit_inventory(t,d,d+1) WHERE sellable_unit_id=su;
      INSERT INTO probe_out VALUES (b, ao, ax, false);
    END $$;
    SELECT COALESCE(skip::text,'f') || '|' || COALESCE(base::text,'') || '|' || COALESCE(oos::text,'') || '|' || COALESCE(ooo::text,'') FROM probe_out;
    ROLLBACK;`);
  const line = out.split("\n").map((s) => s.trim()).find((s) => s.includes("|")) ?? "";
  const [skip, base, oos, ooo] = line.split("|");
  if (skip === "t") console.log("• no sellable unit with member rooms on staging — DB probe skipped");
  else if (!base) flag(`DB probe produced no result (${out.slice(-160)})`);
  else {
    const [b, o, x] = [Number(base), Number(oos), Number(ooo)];
    if (o !== b) flag(`OOS changed availability (${b} → ${o}) — it must be dirty-but-sellable`);
    else pass(`OOS does not reduce availability (stays ${b})`);
    if (x !== o - 1) flag(`OOO did not reduce availability by 1 (${o} → ${x})`);
    else pass(`OOO removes availability by exactly 1 (${o} → ${x})`);
  }
} else {
  console.log("• staging DSN not available — DB probe skipped (static invariants still enforced)");
}

if (fail) { console.log(`\ncheck:maintenance-closures — FAIL (${fail})`); process.exit(1); }
console.log("check:maintenance-closures — PASS");
