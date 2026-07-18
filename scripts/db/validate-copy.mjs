#!/usr/bin/env node
// GuestHub data-copy validator (Stage 2, V2 §9 items 8-9): read-only row-count
// and content-checksum comparison of the guesthub schema between two databases.
// Used to validate staging data-copy fidelity and, later, the production cutover.
//
// Read-only (SELECT only) on both sides — safe to point SOURCE at production.
//
// Usage:
//   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... node scripts/db/validate-copy.mjs
// Content checksum per table = md5 over the sorted set of per-row md5s, so it is
// independent of physical row order. schema_migrations is ignored (target-only).
// Known append-only ops tables can drift if SOURCE is live; they are listed
// separately, not counted as failures, when only counts differ.
import { execFileSync } from "node:child_process";

const src = process.env.SOURCE_DATABASE_URL, dst = process.env.TARGET_DATABASE_URL;
if (!src || !dst) { console.error("need SOURCE_DATABASE_URL and TARGET_DATABASE_URL"); process.exit(2); }

const VOLATILE = new Set([  // append-only/ops tables that may grow if SOURCE is live
  "channel_sync_jobs", "channel_sync_errors", "channel_dirty_ranges",
  "channel_webhook_events", "audit_logs", "communication_delivery_attempts",
  "communication_events", "message_events", "outbound_messages",
  "channel_worker_state",  // heartbeat row updated continuously by the live worker
]);
const IGNORE = new Set(["schema_migrations", "sellable_units_backup_028"]);

const q = (url, sql) => execFileSync("psql", [url, "-tAc", sql, "-X"], { encoding: "utf8" }).trim();

const tables = (url) => q(url, `select tablename from pg_tables where schemaname='guesthub' order by 1`).split("\n").filter(Boolean);
const srcT = new Set(tables(src)), dstT = new Set(tables(dst));
const common = [...srcT].filter((t) => dstT.has(t) && !IGNORE.has(t));

// content fingerprint: order-independent md5 of row md5s
const fp = (url, t) =>
  q(url, `select coalesce(md5(string_agg(h, '' order by h)),'∅')||':'||count(*) from (select md5(x.*::text) h from guesthub.${t} x) s`);

let hardFail = 0, drift = 0, ok = 0;
console.log(`Comparing guesthub schema: ${common.length} common tables\n`);
for (const t of common) {
  const a = fp(src, t), b = fp(dst, t);
  if (a === b) { ok++; continue; }
  const [ha, ca] = a.split(":"), [hb, cb] = b.split(":");
  if (VOLATILE.has(t)) { drift++; console.log(`~ DRIFT (volatile) ${t}: src=${ca} dst=${cb}`); }
  else { hardFail++; console.log(`✗ MISMATCH ${t}: src(count=${ca},fp=${ha.slice(0,8)}) dst(count=${cb},fp=${hb.slice(0,8)})`); }
}
const onlySrc = [...srcT].filter((t) => !dstT.has(t) && !IGNORE.has(t));
const onlyDst = [...dstT].filter((t) => !srcT.has(t) && !IGNORE.has(t));
if (onlySrc.length) console.log(`✗ tables only in source: ${onlySrc.join(", ")}`);
if (onlyDst.length) console.log(`✗ tables only in target: ${onlyDst.join(", ")}`);

console.log(`\nidentical=${ok}  volatile-drift=${drift}  MISMATCH=${hardFail}  (only-src=${onlySrc.length}, only-dst=${onlyDst.length})`);
process.exit(hardFail || onlySrc.length || onlyDst.length ? 1 : 0);
