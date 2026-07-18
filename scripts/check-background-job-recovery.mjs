#!/usr/bin/env node
// check:background-job-recovery (Stage 3, V2 §1/§21) — prove the durable job
// queue recovers from a crashed worker and honours its concurrency rules, using
// the SAME claim predicate as src/lib/channel/queue.ts. Runs on a DISPOSABLE DB.
//
//   1. a job left 'processing' by a dead worker (expired lease) is reclaimed.
//   2. a fresh 'queued' job is claimed.
//   3. one-live-job-per-connection: a second job on a connection whose job is
//      already held by a LIVE worker is NOT claimed.
//   4. FOR UPDATE SKIP LOCKED: two concurrent claimers never grab the same job.
import postgres from "postgres";
const url=process.env.CHECK_CONCURRENCY_DB_URL||process.env.CHECK_DB_URL;
if(!url){console.error("need CHECK_CONCURRENCY_DB_URL (disposable DB)");process.exit(2);}
try{const u=new URL(url);if(["localhost","127.0.0.1","::1"].includes(u.hostname)&&(u.port||"5432")==="5432"){console.error("ABORT :5432");process.exit(2);}}catch{}
const sql=postgres(url,{prepare:false,max:3});
const LEASE=10; // minutes, mirror JOB_LEASE_MINUTES
let fail=0; const ok=(m)=>console.log(`  ✓ ${m}`); const bad=(m,d)=>{fail++;console.log(`  ✗ ${m}${d?": "+d:""}`);};

// claim predicate copied from queue.ts claimChannelJobs (single-conn, limit 1)
const claim = (tx, worker) => tx`
  UPDATE guesthub.channel_sync_jobs j SET
    status='processing', locked_at=now(), locked_by=${worker},
    started_at=COALESCE(j.started_at, now()), attempts=j.attempts+1
  WHERE j.id IN (
    SELECT c.id FROM guesthub.channel_sync_jobs c
    WHERE ((c.status IN ('queued','retry_wait') AND c.next_attempt_at<=now())
        OR (c.status='processing' AND c.locked_at < now() - make_interval(mins=>${LEASE})))
      AND NOT EXISTS (SELECT 1 FROM guesthub.channel_sync_jobs p
        WHERE p.connection_id=c.connection_id AND p.status='processing' AND p.id<>c.id
          AND p.locked_at >= now() - make_interval(mins=>${LEASE}))
    ORDER BY c.priority, c.created_at
    FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING j.id, j.locked_by, j.attempts`;

let T,C1,C2;
try {
  [{id:T}]=await sql`insert into guesthub.tenants(name,slug) values('jobs','jobs-'||substr(md5(random()::text),1,8)) returning id`;
  // distinct (provider, environment) to satisfy the per-tenant unique connection key
  [{id:C1}]=await sql`insert into guesthub.channel_connections(tenant_id, provider, environment) values(${T},'channex','staging') returning id`;
  [{id:C2}]=await sql`insert into guesthub.channel_connections(tenant_id, provider, environment) values(${T},'channex','production') returning id`;
  const mkJob=(conn,status,lockedAgoMin,lockedBy)=>sql`
    insert into guesthub.channel_sync_jobs(tenant_id,connection_id,job_type,status,locked_at,locked_by,next_attempt_at)
    values(${T},${conn},'sync_ari_range',${status},
      ${lockedAgoMin==null?null:sql`now() - make_interval(mins=>${lockedAgoMin})`},
      ${lockedBy??null}, now()) returning id`;

  // 1. crashed worker (processing, lease expired 20m>10m) -> reclaimed
  const [j1]=await mkJob(C1,'processing',20,'dead-worker');
  const r1=await sql.begin((tx)=>claim(tx,'worker-A'));
  (r1.length===1 && r1[0].id===j1.id && r1[0].locked_by==='worker-A')
    ? ok("crashed job (expired lease) reclaimed by a new worker")
    : bad("expired-lease reclaim", JSON.stringify(r1));
  // reset j1 to done so it doesn't interfere
  await sql`update guesthub.channel_sync_jobs set status='succeeded', locked_at=null where id=${j1.id}`;

  // 2. fresh queued job on C1 -> claimed
  const [j2]=await mkJob(C1,'queued',null,null);
  const r2=await sql.begin((tx)=>claim(tx,'worker-A'));
  (r2.length===1 && r2[0].id===j2.id) ? ok("fresh queued job claimed") : bad("queued claim", JSON.stringify(r2));
  await sql`update guesthub.channel_sync_jobs set status='succeeded', locked_at=null where id=${j2.id}`;

  // 3. one-live-job-per-connection: C2 has a LIVE processing job; a queued sibling is NOT claimed
  await mkJob(C2,'processing',1,'worker-live');           // locked 1m ago = live
  const [j3b]=await mkJob(C2,'queued',null,null);
  const r3=await sql.begin((tx)=>claim(tx,'worker-B'));
  (r3.length===0 || r3[0].id!==j3b.id)
    ? ok("sibling job NOT claimed while connection has a live in-flight job")
    : bad("one-live-per-connection violated", JSON.stringify(r3));

  // 4. SKIP LOCKED: two concurrent claimers, one eligible job -> at most one gets it
  const [j4]=await mkJob(C1,'queued',null,null);
  let got=[];
  await sql.begin(async (txA)=>{
    const a=await claim(txA,'A');                          // txA holds the row lock
    const b=await sql.begin((txB)=>claim(txB,'B'));        // txB must SKIP it
    got=[...a.map(x=>x.id),...b.map(x=>x.id)];
  });
  (got.filter(id=>id===j4.id).length===1)
    ? ok("FOR UPDATE SKIP LOCKED: concurrent claimers never double-grab a job")
    : bad("skip-locked double grab", JSON.stringify(got));

} catch(e){ bad("run", e.message); }
finally { if(T) await sql`delete from guesthub.tenants where id=${T}`.catch(()=>{}); await sql.end(); }
console.log(fail?`\ncheck:background-job-recovery FAILED (${fail})`:"\ncheck:background-job-recovery PASSED");
process.exit(fail?1:0);
