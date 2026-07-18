#!/usr/bin/env node
// check:payment-ledger-integrity (Stage 3) — read-only invariant guard proving
// guesthub.payments is the authoritative ledger and reservations.paid_amount /
// balance are faithful derived caches of it (D51/D52 + ledger.ts).
//
// Invariants asserted (per reservation):
//   paid_amount == SUM(amount) FILTER (status='paid')   -- only captured funds
//   balance     == total_price - paid_amount            -- unfloored (credit honest)
//   no orphan payments; idempotency key unique; refunds/voided excluded from paid.
//
// Target: CHECK_DB_URL or STAGING_DATABASE_URL (read-only).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvStaging() {
  try { const p=join(dirname(fileURLToPath(import.meta.url)),"..",".env.staging");
    for (const l of readFileSync(p,"utf8").split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];} } catch {}
}
loadEnvStaging();
const url = process.env.CHECK_DB_URL || process.env.STAGING_DATABASE_URL;
if (!url) { console.error("need CHECK_DB_URL or STAGING_DATABASE_URL"); process.exit(2); }
const q = (sql) => execFileSync("psql", [url, "-tAc", sql, "-X"], { encoding: "utf8" }).trim();
let fail=0; const ok=(m)=>console.log(`  ✓ ${m}`); const bad=(m,d)=>{fail++;console.log(`  ✗ ${m}${d?": "+d:""}`);};

// 1. paid_amount == sum of captured (status='paid') payments
const paidDrift = q(`
  select count(*) from guesthub.reservations res
  left join (select reservation_id, coalesce(sum(amount),0) p from guesthub.payments
             where status='paid' group by reservation_id) led on led.reservation_id=res.id
  where round(res.paid_amount,2) <> round(coalesce(led.p,0),2)`);
paidDrift==="0" ? ok("paid_amount == SUM(paid payments) for every reservation") : bad("paid_amount drift", paidDrift);

// 2. balance == total_price - paid_amount (unfloored)
const balDrift = q(`select count(*) from guesthub.reservations where round(balance,2) <> round(total_price-paid_amount,2)`);
balDrift==="0" ? ok("balance == total_price - paid_amount (unfloored)") : bad("balance drift", balDrift);

// 3. voided/refunded/failed/pending never counted as captured (implied by #1, assert none mislabeled)
const badStatus = q(`select count(*) from guesthub.payments where status not in ('paid','pending','failed','voided','refunded')`);
badStatus==="0" ? ok("all payment statuses in the canonical set") : bad("unknown payment status", badStatus);

// 4. no orphan payments (every payment points at a live reservation)
const orphan = q(`select count(*) from guesthub.payments p left join guesthub.reservations r on r.id=p.reservation_id where r.id is null`);
orphan==="0" ? ok("no orphan payments") : bad("orphan payments", orphan);

// 5. idempotency uniqueness holds (no duplicate non-null keys per tenant)
const dupIdem = q(`select count(*) from (select tenant_id, idempotency_key from guesthub.payments
                   where idempotency_key is not null group by tenant_id, idempotency_key having count(*)>1) d`);
dupIdem==="0" ? ok("payment idempotency keys unique per tenant") : bad("duplicate idempotency keys", dupIdem);

// 6. no negative captured payment inflating things unexpectedly (contra entries, if any, are intentional)
const negPaid = q(`select count(*) from guesthub.payments where status='paid' and amount<0`);
console.log(`  · captured contra/refund entries (negative 'paid'): ${negPaid}`);

console.log(fail ? `\ncheck:payment-ledger-integrity FAILED (${fail})` : "\ncheck:payment-ledger-integrity PASSED");
process.exit(fail?1:0);
