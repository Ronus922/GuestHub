#!/usr/bin/env node
// check:retention (Stage 6, H8/H11) — the retention purge functions remove only
// data past its window and preserve everything inside it. Static + DB proof
// (rolled back) on staging.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// static: both purge functions exist + the runner refuses prod :5432
const mig = read("db/migrations/043_retention_purge.sql");
if (!/purge_expired_cards/.test(mig)) flag("no PAN purge function (H8)");
else pass("purge_expired_cards present (H8 PCI-scope reduction)");
if (!/purge_channel_sync_errors/.test(mig)) flag("no sync-error purge function (H11)");
else pass("purge_channel_sync_errors present (H11 log retention)");
const runner = read("scripts/ops/guesthub-purge.mjs");
if (!/refusing host-local :5432/.test(runner)) flag("purge runner does not refuse the prod pooler");
else pass("purge runner refuses host-local :5432 (prod-safety)");

// DB proof (rolled back): a card past the window is purged, one inside is kept;
// a resolved error past the window is purged, a recent unresolved one is kept.
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
  const t = q(`SELECT id FROM guesthub.tenants ORDER BY created_at LIMIT 1`);
  if (!t) { console.log("• no tenant on staging — retention DB proof skipped"); }
  else {
    const out = q(`
      BEGIN;
      CREATE TEMP TABLE r_out (card_purged int, card_kept int, err_purged int, err_kept int) ON COMMIT DROP;
      DO $$
      DECLARE t uuid := '${t}'; old_res uuid := gen_random_uuid(); new_res uuid := gen_random_uuid();
              cp int; ck int; ep int; ek int;
      BEGIN
        -- an old checked-out stay (past window) + a recent one (inside window)
        INSERT INTO guesthub.reservations (id, tenant_id, reservation_number, status, check_in, check_out)
          VALUES (old_res, t, 'RET-OLD-' || substr(old_res::text,1,8), 'checked_out', current_date - 400, current_date - 200),
                 (new_res, t, 'RET-NEW-' || substr(new_res::text,1,8), 'checked_out', current_date - 5, current_date - 3);
        INSERT INTO guesthub.reservation_cards (tenant_id, reservation_id, holder_name, pan_encrypted, last4, exp_month, exp_year)
          VALUES (t, old_res, 'A', 'v1.x', '1111', 1, 2030), (t, new_res, 'B', 'v1.y', '2222', 1, 2030);
        PERFORM guesthub.purge_expired_cards(90);
        cp := (SELECT count(*) FROM guesthub.reservation_cards WHERE reservation_id = old_res); -- expect 0
        ck := (SELECT count(*) FROM guesthub.reservation_cards WHERE reservation_id = new_res); -- expect 1

        INSERT INTO guesthub.channel_sync_errors (tenant_id, error_message, created_at, resolved_at)
          VALUES (t, 'old-resolved', now() - interval '60 days', now() - interval '40 days'),
                 (t, 'recent-unresolved', now() - interval '2 days', NULL);
        PERFORM guesthub.purge_channel_sync_errors(30, 180);
        ep := (SELECT count(*) FROM guesthub.channel_sync_errors WHERE tenant_id = t AND error_message = 'old-resolved');     -- expect 0
        ek := (SELECT count(*) FROM guesthub.channel_sync_errors WHERE tenant_id = t AND error_message = 'recent-unresolved'); -- expect 1
        INSERT INTO r_out VALUES (cp, ck, ep, ek);
      END $$;
      SELECT card_purged || '|' || card_kept || '|' || err_purged || '|' || err_kept FROM r_out;
      ROLLBACK;`);
    const line = out.split("\n").map((s) => s.trim()).find((s) => s.includes("|")) ?? "";
    const [cp, ck, ep, ek] = line.split("|").map(Number);
    if (cp !== 0) flag(`expired card not purged (${cp} remain)`); else pass("expired card (>90d post-stay) purged");
    if (ck !== 1) flag(`in-window card wrongly purged (${ck})`); else pass("in-window card preserved");
    if (ep !== 0) flag(`old resolved error not purged (${ep})`); else pass("old resolved error purged");
    if (ek !== 1) flag(`recent unresolved error wrongly purged (${ek})`); else pass("recent unresolved error preserved");
  }
} else {
  console.log("• staging DSN not available — retention DB proof skipped (static enforced)");
}

if (fail) { console.log(`\ncheck:retention — FAIL (${fail})`); process.exit(1); }
console.log("check:retention — PASS");
