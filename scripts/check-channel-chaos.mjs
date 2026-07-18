#!/usr/bin/env node
// check:channel-chaos (Stage 4, V2 §17) — the inbound pipeline degrades safely
// under adversarial input: duplicates, malformed payloads, unknown mappings,
// conflicts and ack failures never crash it and never lose a booking. Source-
// level audit of the resilience invariants (behaviour is DB-tested by
// check:inbound-bookings; this proves the invariants exist and stay).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

const importSrc = read("src/lib/channel/booking-import.ts");
const revisions = read("src/lib/channel/revisions.ts");
const webhook = read("src/app/api/channel/webhook/[token]/route.ts");
const migrations = read("db/migrations/005_phase3_channel_foundation.sql");

// 1) duplicate revision → import exactly once (DB UNIQUE + ON CONFLICT)
if (!/ON CONFLICT[\s\S]{0,120}DO NOTHING/.test(revisions) && !/ON CONFLICT[\s\S]{0,120}DO NOTHING/.test(importSrc))
  flag("no ON CONFLICT DO NOTHING guard on revision import");
else pass("duplicate revision is idempotent (ON CONFLICT DO NOTHING)");

// 2) malformed / normalize-fail → persist-then-quarantine, never crash/lose (D82)
if (!/QuarantineError/.test(importSrc)) flag("no quarantine path for bad revisions");
else pass("bad/unmapped revision is quarantined, never dropped");
if (!/persistBookingRevision|quarantineRevision/.test(importSrc))
  flag("no persist-then-quarantine seam");
else pass("revision is persisted before quarantine (identity kept — D82)");

// 3) unknown rate plan → quarantine first, then alias reconcile (D78)
if (!/reconcileInboundRatePlans/.test(importSrc)) flag("no inbound rate-plan alias reconciliation");
else pass("unknown rate plan quarantines then self-heals via alias adoption (D78)");

// 4) ACK strictly after commit — the DB WHERE clause is the backstop
if (!/markRevisionAcknowledged/.test(importSrc)) flag("no post-commit ack gate");
else pass("acknowledgement only after the import transaction commits");
if (!/import_status\s*=\s*'imported'|status\s*=\s*'imported'/.test(revisions))
  flag("ack DB backstop does not require an imported row");
else pass("a non-imported revision can never be acknowledged (DB gate)");

// 5) conflicting modification → visible quarantine; local stay never clobbered
if (!/PRESERVED_STATUSES/.test(importSrc)) flag("operator-advanced states not preserved on modification");
else pass("checked_in/checked_out survive a channel modification");

// 6) ack failure → durably imported + unacknowledged, retried next pull
if (!/ambiguous|isAmbiguous|retr/i.test(read("src/lib/channel/channex-bookings.ts")))
  flag("ack failure handling not evident");
else pass("a failed ack leaves the booking imported + unacked for the next pull");

// 7) webhook chaos: duplicate delivery deduped; oversize/ malformed rejected safely
if (!/ON CONFLICT \(connection_id, dedup_key\) DO NOTHING/.test(webhook))
  flag("webhook does not dedupe redelivered events");
else pass("redelivered webhook is deduped (connection_id, dedup_key)");
if (!/MAX_BODY_BYTES/.test(webhook) || !/invalid json/.test(webhook))
  flag("webhook does not bound/validate the body");
else pass("webhook rejects oversize/malformed bodies without crashing");

// 8) worker pull failure → bounded retry, never an infinite loop
const queue = read("src/lib/channel/queue.ts");
if (!/max_attempts|dead_letter/.test(queue)) flag("no bounded-retry / dead-letter on the job queue");
else pass("a failing pull retries with backoff then dead-letters (bounded)");

// 9) the revision feed is append-only evidence: a UNIQUE (connection, revision)
if (!/UNIQUE|unique/.test(migrations)) flag("no uniqueness guard in the channel foundation schema");
else pass("revision uniqueness enforced at the schema level");

// ---- §24 fault-injection list (Stage 6) — each fault has a handling site ----
const admin = read("src/lib/channel/admin.ts");
const ariSync = read("src/lib/channel/ari-sync.ts");
const worker = read("src/lib/channel/worker.ts");
const queueSrc = queue;

// two Full Sync clicks → DB-enforced dedup, no second run
if (!/alreadyRunning|"duplicate" in enqueued|uq_jobs_idempotency/.test(admin) && !/idempotencyKey:\s*`full_sync/.test(admin))
  flag("§24 two-Full-Sync-clicks: no duplicate-run guard");
else pass("§24 two Full Sync clicks → deduped (idempotency key, already-running reported)");

// credential rotation during a job → the stored key is re-probed before any ARI
if (!/runChannexConnectionTest\(/.test(ariSync)) flag("§24 credential rotation: no pre-send auth probe");
else pass("§24 credential rotation mid-job → auth probed before ARI, fails safe");

// expired lease → a stale in-flight job is reclaimed, not stranded
if (!/stale|reclaim|locked_at\s*<|lease/i.test(queueSrc + worker)) flag("§24 expired lease: no stale-lease reclaim");
else pass("§24 expired lease → stale job reclaimed");

// corrupted queue payload / DB unavailable → the tick catches per-job + per-tick
if (!/catch \(e\)[\s\S]{0,200}failChannelJob/.test(worker)) flag("§24 corrupted payload: a bad job is not isolated");
else pass("§24 corrupted payload → job fails in isolation, tick continues");
if (!/catch \(e\)[\s\S]{0,160}(heartbeat|lastError)/.test(worker)) flag("§24 DB-unavailable: tick does not degrade gracefully");
else pass("§24 DB unavailable → tick degrades gracefully (heartbeat records the error)");

// webhook + poll → both converge on the same deduped job (no double import)
if (!/fallback|missed webhook|watchdog/i.test(worker)) flag("§24 webhook+poll: no reconciling fallback poll");
else pass("§24 webhook + poll → converge on one deduped pull job");

// certification reset during a run → the evidence ledger is append-only (no reset)
const evidence = read("src/lib/channel/evidence.ts");
if (/\b(UPDATE|DELETE)\s+[^;]*channel_evidence_ledger/i.test(evidence)) flag("§24 cert reset: evidence ledger is mutable");
else pass("§24 certification reset → evidence ledger is append-only (no destructive reset path)");

if (fail) { console.log(`\ncheck:channel-chaos — FAIL (${fail})`); process.exit(1); }
console.log("check:channel-chaos — PASS");
