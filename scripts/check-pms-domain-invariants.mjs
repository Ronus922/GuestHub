#!/usr/bin/env node
// check:pms-domain-invariants (Stage 3, V2 §8 one-source-of-truth / tenant safety).
// Read-only guard asserting cross-entity invariants that FKs alone do not enforce
// — chiefly that no row crosses a tenant boundary (the app-layer isolation that
// H3 relies on, verified against the data). Target: CHECK_DB_URL or STAGING_DATABASE_URL.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
function loadEnv(){try{const p=join(dirname(fileURLToPath(import.meta.url)),"..",".env.staging");for(const l of readFileSync(p,"utf8").split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}}catch{}}
loadEnv();
const url=process.env.CHECK_DB_URL||process.env.STAGING_DATABASE_URL;
if(!url){console.error("need CHECK_DB_URL or STAGING_DATABASE_URL");process.exit(2);}
const q=(sql)=>execFileSync("psql",[url,"-tAc",sql,"-X"],{encoding:"utf8"}).trim();
let fail=0; const ok=(m)=>console.log(`  ✓ ${m}`); const bad=(m,d)=>{fail++;console.log(`  ✗ ${m}${d?": "+d:""}`);};

const zero=(label,sql)=>{const c=q(sql); c==="0"?ok(label):bad(label,c+" offending rows");};

// tenant consistency across the core graph (no cross-tenant references)
zero("reservation_rooms share their reservation's tenant",
  `select count(*) from guesthub.reservation_rooms rr join guesthub.reservations r on r.id=rr.reservation_id where rr.tenant_id<>r.tenant_id`);
zero("payments share their reservation's tenant",
  `select count(*) from guesthub.payments p join guesthub.reservations r on r.id=p.reservation_id where p.tenant_id<>r.tenant_id`);
zero("reservation_rooms reference a room of the same tenant",
  `select count(*) from guesthub.reservation_rooms rr join guesthub.rooms rm on rm.id=rr.room_id where rr.tenant_id<>rm.tenant_id`);
zero("reservation_cards share their reservation's tenant",
  `select count(*) from guesthub.reservation_cards c join guesthub.reservations r on r.id=c.reservation_id where c.tenant_id<>r.tenant_id`);

// canonical status set (CHECK enforces; verify data obeys)
zero("all reservations have a canonical status",
  `select count(*) from guesthub.reservations where status not in ('draft','confirmed','checked_in','checked_out','no_show','blocked','cancelled')`);

// no orphaned core rows (FKs should prevent; verify)
zero("no reservation_rooms without a parent reservation",
  `select count(*) from guesthub.reservation_rooms rr left join guesthub.reservations r on r.id=rr.reservation_id where r.id is null`);

// rooms belong to a tenant that exists
zero("every room belongs to an existing tenant",
  `select count(*) from guesthub.rooms rm left join guesthub.tenants t on t.id=rm.tenant_id where t.id is null`);

console.log(fail?`\ncheck:pms-domain-invariants FAILED (${fail})`:"\ncheck:pms-domain-invariants PASSED");
process.exit(fail?1:0);
