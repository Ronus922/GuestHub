-- ============================================================
--  GuestHub · Stage 4 — Channex certification evidence ledger (defects H9, H10).
--
--  Until now, Channex Task IDs were recorded ONLY for the initial Full Sync
--  (on the channel_sync_jobs.payload), and INCREMENTAL drains discarded them
--  entirely (drainAriDirtyRanges collected outcome.taskIds and threw them away).
--  The Channex PMS certification requires, for every executed scenario, durable
--  evidence: the triggering UI workflow, the firing file+function, the request
--  count against the official expectation, the returned Task IDs, and the pass
--  status. This table is that append-only evidence ledger (§13).
--
--  It is EVIDENCE, not control: nothing here triggers a scenario. The read-only
--  certification console selects from it; the ARI send path and the inbound
--  acknowledgement path append to it.
--
--  Idempotent. Safe to replay from zero. Append-only (no row is ever updated or
--  deleted by application code).
-- ============================================================
SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.channel_evidence_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  connection_id  uuid,
  environment    text NOT NULL,
  -- what scenario this evidence belongs to, e.g. 'full_sync', 'availability_update',
  -- 'rate_update', 'group_update', 'stop_sell', 'inbound_new', 'inbound_modify',
  -- 'inbound_cancel', 'booking_ack'. Free text so new cert scenarios need no DDL.
  scenario_key   text NOT NULL,
  -- the ARI dimension / message kind, e.g. 'availability', 'restrictions', 'booking_ack'.
  kind           text,
  -- §12 traceability: the operator UI action + the code that issued the request.
  ui_workflow    text,
  firing_file    text,
  firing_function text,
  -- request accounting against the official expectation.
  request_count  int NOT NULL DEFAULT 0,
  expected_requests int,
  request_bytes  int,
  task_ids       text[] NOT NULL DEFAULT '{}',
  date_from      date,
  date_to        date,
  warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 'success' | 'partial' | 'failed'
  outcome        text NOT NULL,
  error_code     text,
  error_message  text,
  job_id         uuid,
  -- free-form context (never a secret): batch sizes, min-stay mode, etc.
  context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_evidence_outcome_chk CHECK (outcome IN ('success','partial','failed'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_tenant_created
  ON guesthub.channel_evidence_ledger (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_connection
  ON guesthub.channel_evidence_ledger (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_scenario
  ON guesthub.channel_evidence_ledger (tenant_id, scenario_key, created_at DESC);
-- fast lookup of "which scenarios produced Task IDs" for the cert console.
CREATE INDEX IF NOT EXISTS idx_evidence_has_tasks
  ON guesthub.channel_evidence_ledger (tenant_id)
  WHERE array_length(task_ids, 1) > 0;
