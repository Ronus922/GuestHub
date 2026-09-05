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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const url=process.env.CHECK_CONCURRENCY_DB_URL||process.env.CHECK_DB_URL;
if(!url){console.error("need CHECK_CONCURRENCY_DB_URL (disposable DB)");process.exit(2);}
try{const u=new URL(url);if(["localhost","127.0.0.1","::1"].includes(u.hostname)&&(u.port||"5432")==="5432"){console.error("ABORT :5432");process.exit(2);}}catch{}
const sql=postgres(url,{prepare:false,max:3});
// The lease was `const LEASE=10; // mirror JOB_LEASE_MINUTES` — a COPY. Change
// JOB_LEASE_MINUTES in queue.ts and this guard kept testing 10 and stayed green.
// Read it from the module instead; a missing/renamed export must fail loudly,
// never fall back to a literal.
const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
console.log(`# tree under test: ${ROOT}`);
const QUEUE_TS=join(ROOT,"src/lib/channel/queue.ts");
const leaseMatch=/export\s+const\s+JOB_LEASE_MINUTES\s*(?::[^=]+)?=\s*(\d+)/.exec(readFileSync(QUEUE_TS,"utf8"));
if(!leaseMatch){console.error(`JOB_LEASE_MINUTES not found in ${QUEUE_TS} — the guard cannot pin what it cannot read`);process.exit(2);}
const LEASE=Number(leaseMatch[1]);
console.log(`# JOB_LEASE_MINUTES read from src/lib/channel/queue.ts = ${LEASE}`);
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
  [{id:C1}]=await sql`insert into guesthub.channel_connections(tenant_id, provider, environment) values(${T},'beds24','staging') returning id`;
  [{id:C2}]=await sql`insert into guesthub.channel_connections(tenant_id, provider, environment) values(${T},'beds24','production') returning id`;
  const mkJob=(conn,status,lockedAgoMin,lockedBy)=>sql`
    insert into guesthub.channel_sync_jobs(tenant_id,connection_id,job_type,status,locked_at,locked_by,next_attempt_at)
    values(${T},${conn},'sync_ari_range',${status},
      ${lockedAgoMin==null?null:sql`now() - make_interval(mins=>${lockedAgoMin})`},
      ${lockedBy??null}, now()) returning id`;

  // 1. crashed worker (processing, lease expired 2×LEASE) -> reclaimed
  const [j1]=await mkJob(C1,'processing',LEASE*2,'dead-worker');
  const r1=await sql.begin((tx)=>claim(tx,'worker-A'));
  if (r1.length===1 && r1[0].id===j1.id && r1[0].locked_by==='worker-A')
    ok(`crashed job (locked ${LEASE*2}m ago, lease ${LEASE}m) reclaimed by a new worker`);
  else bad("expired-lease reclaim", JSON.stringify(r1));
  // reset j1 to done so it doesn't interfere
  await sql`update guesthub.channel_sync_jobs set status='succeeded', locked_at=null where id=${j1.id}`;

  // 1b/1c. BOTH SIDES OF THE LEASE BOUNDARY. Testing only the far side (20 vs 10)
  // passes for any lease <= 20, so it never pinned the value. Each job below is
  // the ONLY row on its connection, so the one-live-per-connection rule (p.id<>c.id)
  // cannot explain either outcome — the lease is the sole discriminator.
  const [jIn]=await mkJob(C1,'processing',LEASE-1,'still-alive');
  const rIn=await sql.begin((tx)=>claim(tx,'worker-A'));
  if (rIn.length===0)
    ok(`inside the lease (locked ${LEASE-1}m ago < ${LEASE}m): NOT reclaimed — a live worker keeps its job`);
  else bad(`lease boundary: a job locked ${LEASE-1}m ago was stolen from a live worker`, JSON.stringify(rIn));
  await sql`update guesthub.channel_sync_jobs set status='succeeded', locked_at=null where id=${jIn.id}`;

  const [jOut]=await mkJob(C1,'processing',LEASE+1,'dead-worker');
  const rOut=await sql.begin((tx)=>claim(tx,'worker-A'));
  if (rOut.length===1 && rOut[0].id===jOut.id)
    ok(`past the lease (locked ${LEASE+1}m ago > ${LEASE}m): reclaimed`);
  else bad(`lease boundary: a job locked ${LEASE+1}m ago was not reclaimed`, JSON.stringify(rOut));
  await sql`update guesthub.channel_sync_jobs set status='succeeded', locked_at=null where id=${jOut.id}`;

  // 2. fresh queued job on C1 -> claimed
  const [j2]=await mkJob(C1,'queued',null,null);
  const r2=await sql.begin((tx)=>claim(tx,'worker-A'));
  if (r2.length===1 && r2[0].id===j2.id) ok("fresh queued job claimed");
  else bad("queued claim", JSON.stringify(r2));
  await sql`update guesthub.channel_sync_jobs set status='succeeded', locked_at=null where id=${j2.id}`;

  // 3. one-live-job-per-connection: C2 has a LIVE processing job; a queued sibling is NOT claimed
  await mkJob(C2,'processing',1,'worker-live');           // locked 1m ago = live
  const [j3b]=await mkJob(C2,'queued',null,null);
  const r3=await sql.begin((tx)=>claim(tx,'worker-B'));
  if (r3.length===0 || r3[0].id!==j3b.id)
    ok("sibling job NOT claimed while connection has a live in-flight job");
  else bad("one-live-per-connection violated", JSON.stringify(r3));

  // 4. SKIP LOCKED: two concurrent claimers, one eligible job -> at most one gets it
  const [j4]=await mkJob(C1,'queued',null,null);
  let got=[];
  await sql.begin(async (txA)=>{
    const a=await claim(txA,'A');                          // txA holds the row lock
    const b=await sql.begin((txB)=>claim(txB,'B'));        // txB must SKIP it
    got=[...a.map(x=>x.id),...b.map(x=>x.id)];
  });
  if (got.filter(id=>id===j4.id).length===1)
    ok("FOR UPDATE SKIP LOCKED: concurrent claimers never double-grab a job");
  else bad("skip-locked double grab", JSON.stringify(got));
  await sql`update guesthub.channel_sync_jobs set status='succeeded', locked_at=null, locked_by=null where id=${j4.id}`;

  // ---- §24 fault-injection (Stage 6): DB-behavioral proofs on the disposable DB ----
  // failChannelJob logic mirrored from src/lib/channel/queue.ts (+ isPermanentError
  // from ranges.ts) — a poison/corrupted job must dead-letter, never loop forever.
  const PERMANENT=["validation_error","mapping_error","unauthorized","not_found"];
  const failJob=async(id,err)=>{
    const [j]=await sql`select attempts,max_attempts from guesthub.channel_sync_jobs where id=${id}`;
    if(!j) return;
    const dead=PERMANENT.includes(err.code)||j.attempts>=j.max_attempts;
    await sql`update guesthub.channel_sync_jobs set
      status=${dead?'dead_letter':'retry_wait'},
      next_attempt_at=now()+make_interval(secs=>30),
      finished_at=${dead?sql`now()`:null}, locked_at=null, locked_by=null,
      last_error_code=${err.code??null}, last_error_message=${err.message}
      where id=${id}`;
  };

  // 5. corrupted/poison queue payload → bounded retry then dead_letter, never re-claimed.
  //   (a) a permanent (validation) error dead-letters on the first failure.
  const [j5a]=await mkJob(C1,'queued',null,null);
  await sql.begin((tx)=>claim(tx,'worker-A'));                 // attempts -> 1
  await failJob(j5a.id,{code:'validation_error',message:'corrupted payload'});
  const [s5a]=await sql`select status from guesthub.channel_sync_jobs where id=${j5a.id}`;
  if (s5a.status==='dead_letter') ok("§24 poison payload (permanent error) → dead_letter immediately");
  else bad("permanent-error dead-letter", s5a.status);
  //   (b) a transient error at the attempts ceiling dead-letters (retry exhaustion).
  const [j5b]=await mkJob(C1,'queued',null,null);
  await sql`update guesthub.channel_sync_jobs set attempts=max_attempts where id=${j5b.id}`;
  await failJob(j5b.id,{message:'still failing'});
  const [s5b]=await sql`select status from guesthub.channel_sync_jobs where id=${j5b.id}`;
  if (s5b.status==='dead_letter') ok("§24 retry exhaustion (attempts>=max) → dead_letter");
  else bad("retry-exhaustion dead-letter", s5b.status);
  //   (c) a dead_letter job is inert — the claim predicate never picks it up again.
  const r5=await sql.begin((tx)=>claim(tx,'worker-A'));
  if (!r5.some(x=>x.id===j5a.id||x.id===j5b.id)) ok("§24 dead_letter job is never re-claimed");
  else bad("dead-letter re-claimed", JSON.stringify(r5.map(x=>x.id)));
  await sql`update guesthub.channel_sync_jobs set status='succeeded', locked_at=null, locked_by=null
    where id in (${r5.map(x=>x.id)}) and status='processing'`.catch(()=>{});

  // 6. DB unavailable / timeout after possible upstream success → the claim
  //    transaction rolls back atomically: no half-claimed job, no leaked lock,
  //    no lost work. The job is still claimable afterwards.
  const [j6]=await mkJob(C1,'queued',null,null);
  try { await sql.begin(async(tx)=>{ await claim(tx,'crashing-worker'); throw new Error('db dropped mid-claim'); }); }
  catch { /* expected */ }
  const [s6]=await sql`select status,locked_by,attempts from guesthub.channel_sync_jobs where id=${j6.id}`;
  if (s6.status==='queued' && s6.locked_by==null)
    ok("§24 mid-claim DB failure rolls back → job intact, no leaked lock (no work lost)");
  else bad("mid-claim rollback", JSON.stringify(s6));
  const r6=await sql.begin((tx)=>claim(tx,'worker-A'));
  if (r6.some(x=>x.id===j6.id)) ok("§24 the rolled-back job is re-claimable by the next worker");
  else bad("post-rollback reclaim", JSON.stringify(r6.map(x=>x.id)));

} catch(e){ bad("run", e.message); }
finally { if(T) await sql`delete from guesthub.tenants where id=${T}`.catch(()=>{}); await sql.end(); }
console.log(fail?`\ncheck:background-job-recovery FAILED (${fail})`:"\ncheck:background-job-recovery PASSED");
process.exit(fail?1:0);
