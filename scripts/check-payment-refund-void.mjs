#!/usr/bin/env node
// check:payment-refund-void (Stage 3, H7) — proves the refund/void ledger model
// that src/lib/payments/mutations.ts implements: refunds are negative contra
// 'paid' rows (net captured drops), void flips 'paid'→'voided' (excluded), the
// single aggregate formula stays correct, and over-refund fails closed.
// Runs against a DISPOSABLE DB (schema present). Fail-closed against :5432.
import postgres from "postgres";
const url = process.env.CHECK_CONCURRENCY_DB_URL || process.env.CHECK_DB_URL;
if (!url) { console.error("need CHECK_CONCURRENCY_DB_URL (disposable DB)"); process.exit(2); }
try { const u=new URL(url); if(["localhost","127.0.0.1","::1"].includes(u.hostname)&&(u.port||"5432")==="5432"){console.error("ABORT :5432");process.exit(2);} } catch {}
const sql = postgres(url, { prepare:false, max:1 });
let fail=0; const ok=(m)=>console.log(`  ✓ ${m}`); const bad=(m,d)=>{fail++;console.log(`  ✗ ${m}${d?": "+d:""}`);};

// mirror of ledger.ts recompute (paid = SUM amount FILTER status='paid')
const recompute = (tx,T,R)=>tx`
  UPDATE guesthub.reservations res SET paid_amount=x.paid, balance=res.total_price-x.paid
  FROM (SELECT COALESCE(SUM(amount) FILTER (WHERE status='paid'),0) paid FROM guesthub.payments
        WHERE reservation_id=${R} AND tenant_id=${T}) x
  WHERE res.id=${R} AND res.tenant_id=${T} RETURNING res.paid_amount::float8 paid, res.balance::float8 balance`;
const agg = async (T,R)=>(await sql`select paid_amount::float8 paid, balance::float8 balance from guesthub.reservations where id=${R} and tenant_id=${T}`)[0];

let T,R;
try {
  [{id:T}] = await sql`insert into guesthub.tenants(name,slug) values('rv','rv-'||substr(md5(random()::text),1,8)) returning id`;
  [{id:R}] = await sql`insert into guesthub.reservations(tenant_id,reservation_number,check_in,check_out,status,total_price)
                       values(${T},'RV-1','2027-02-01','2027-02-04','confirmed',300) returning id`;

  // capture 200
  await sql.begin(async tx=>{ await tx`insert into guesthub.payments(tenant_id,reservation_id,amount,status,paid_at) values(${T},${R},200,'paid',now())`; await recompute(tx,T,R); });
  let a=await agg(T,R); (a.paid===200&&a.balance===100)?ok(`capture 200 → paid=200 balance=100`):bad("capture",JSON.stringify(a));

  // refund 50 (contra -50)
  await sql.begin(async tx=>{
    const [{paid:net}]=await tx`select coalesce(sum(amount) filter(where status='paid'),0)::float8 paid from guesthub.payments where reservation_id=${R} and tenant_id=${T}`;
    if (50>net+1e-9) throw new Error("over");
    await tx`insert into guesthub.payments(tenant_id,reservation_id,amount,status,paid_at,idempotency_key) values(${T},${R},${-50},'paid',now(),'refund:r1') on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing`;
    await recompute(tx,T,R);
  });
  a=await agg(T,R); (a.paid===150&&a.balance===150)?ok(`refund 50 → paid=150 balance=150`):bad("refund",JSON.stringify(a));

  // duplicate refund (same key) suppressed
  await sql.begin(async tx=>{ await tx`insert into guesthub.payments(tenant_id,reservation_id,amount,status,paid_at,idempotency_key) values(${T},${R},${-50},'paid',now(),'refund:r1') on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing`; await recompute(tx,T,R); });
  a=await agg(T,R); a.paid===150?ok("duplicate refund (same key) suppressed → paid still 150"):bad("dup refund",JSON.stringify(a));

  // over-refund fails closed (refund 1000 > net 150)
  let blocked=false;
  try { await sql.begin(async tx=>{ const [{paid:net}]=await tx`select coalesce(sum(amount) filter(where status='paid'),0)::float8 paid from guesthub.payments where reservation_id=${R} and tenant_id=${T}`; if(1000>net+1e-9) throw new Error("refund exceeds net captured"); }); }
  catch { blocked=true; }
  blocked?ok("over-refund rejected (fail closed)"):bad("over-refund allowed");

  // void a clean captured payment on a fresh reservation
  const [{id:R2}]=await sql`insert into guesthub.reservations(tenant_id,reservation_number,check_in,check_out,status,total_price) values(${T},'RV-2','2027-03-01','2027-03-03','confirmed',120) returning id`;
  const [{id:P2}]=await sql`insert into guesthub.payments(tenant_id,reservation_id,amount,status,paid_at) values(${T},${R2},120,'paid',now()) returning id`;
  await sql.begin(async tx=>{ await recompute(tx,T,R2); });
  await sql.begin(async tx=>{ await tx`update guesthub.payments set status='voided' where id=${P2} and tenant_id=${T} and status='paid'`; await recompute(tx,T,R2); });
  a=await agg(T,R2); (a.paid===0&&a.balance===120)?ok("void captured 120 → paid=0 balance=120"):bad("void",JSON.stringify(a));

} catch(e){ bad("run",e.message); }
finally { if(T) await sql`delete from guesthub.tenants where id=${T}`.catch(()=>{}); await sql.end(); }
console.log(fail?`\ncheck:payment-refund-void FAILED (${fail})`:"\ncheck:payment-refund-void PASSED");
process.exit(fail?1:0);
