import "server-only";
import type { Sql, TransactionSql } from "postgres";
import type { ChannelManagerProvider, ProviderResult } from "./provider";
import {
  buildAvailabilityPayloads,
  buildRatePayloads,
  essToChannexInputs,
  type EssRow,
} from "./payloads";

// ============================================================
// One queue step (§0.6.11/§0.6.15). Recomputes ARI for a
// (connection, room_type, kind, range, revision) FROM the Effective Sell State
// projection and pushes it through the injected provider. Two invariants:
//   1. The payload source is ALWAYS the DB projection — never UI input.
//   2. A monotonic watermark makes a stale/out-of-order retry a no-op: an older
//      revision can never overwrite a newer synced range.
// NO real client / NO network lives here — the provider is injected (Disabled /
// DryRun / a fake recording provider in Phase 4A). The 4B worker calls this.
// ============================================================

export type DirtyKind = "availability" | "rates" | "restrictions";

export type ProcessResult =
  | { status: "sent"; kind: DirtyKind; batches: number; values: number; providerTaskId?: string }
  | { status: "skipped_stale"; kind: DirtyKind; revision: number; appliedRevision: number }
  | { status: "no_mapping"; kind: DirtyKind }
  | { status: "error"; kind: DirtyKind; code?: string; message: string };

export async function processDirtyRange(
  db: Sql | TransactionSql,
  provider: ChannelManagerProvider,
  args: {
    tenantId: string;
    connectionId: string;
    channexPropertyId: string;
    roomTypeId: string;
    kind: DirtyKind;
    dateFrom: string; // inclusive
    dateTo: string; // exclusive
    revision: number;
  },
): Promise<ProcessResult> {
  // stale guard: a >= revision already applied for this key ⇒ do nothing
  const [state] = await db<{ applied_revision: string }[]>`
    SELECT applied_revision FROM guesthub.channel_sync_state
    WHERE connection_id = ${args.connectionId}
      AND room_type_id = ${args.roomTypeId} AND kind = ${args.kind}`;
  const applied = state ? Number(state.applied_revision) : 0;
  if (args.revision <= applied) {
    return { status: "skipped_stale", kind: args.kind, revision: args.revision, appliedRevision: applied };
  }

  // recompute from Effective Sell State (NEVER from UI input)
  const ess = await db<EssRow[]>`
    SELECT sellable_unit_id, room_type_id, day::text AS day, availability,
           price::float8 AS price, min_stay_arrival, min_stay_through, max_stay,
           closed_to_arrival, closed_to_departure, stop_sell
    FROM guesthub.effective_sell_state(${args.tenantId}, ${args.dateFrom}, ${args.dateTo})
    WHERE room_type_id = ${args.roomTypeId}`;
  const { availability, rates } = essToChannexInputs(ess);

  const [rtm] = await db<{ channex_room_type_id: string | null }[]>`
    SELECT channex_room_type_id FROM guesthub.channel_room_type_mappings
    WHERE connection_id = ${args.connectionId} AND room_type_id = ${args.roomTypeId}
      AND is_active AND channex_room_type_id IS NOT NULL`;
  const [rpm] = await db<{ channex_rate_plan_id: string | null }[]>`
    SELECT channex_rate_plan_id FROM guesthub.channel_rate_plan_mappings
    WHERE connection_id = ${args.connectionId} AND room_type_id = ${args.roomTypeId}
      AND is_active AND channex_rate_plan_id IS NOT NULL
    ORDER BY (local_plan_code = 'default') DESC LIMIT 1`;

  let batches: { values: unknown[] }[];
  let result: ProviderResult;
  if (args.kind === "availability") {
    if (!rtm?.channex_room_type_id) return { status: "no_mapping", kind: args.kind };
    batches = buildAvailabilityPayloads(
      availability,
      args.channexPropertyId,
      new Map([[args.roomTypeId, rtm.channex_room_type_id]]),
    ).batches;
    result = await provider.pushAvailability(batches);
  } else {
    if (!rpm?.channex_rate_plan_id) return { status: "no_mapping", kind: args.kind };
    batches = buildRatePayloads(
      rates,
      args.channexPropertyId,
      new Map([[args.roomTypeId, rpm.channex_rate_plan_id]]),
    ).batches;
    result =
      args.kind === "rates"
        ? await provider.pushRates(batches)
        : await provider.pushRestrictions(batches);
  }

  if (!result.ok) {
    return { status: "error", kind: args.kind, code: result.code, message: result.message };
  }

  // advance the watermark, monotonically (WHERE clause is the concurrency backstop)
  await db`
    INSERT INTO guesthub.channel_sync_state
      (tenant_id, connection_id, room_type_id, kind, applied_revision)
    VALUES (${args.tenantId}, ${args.connectionId}, ${args.roomTypeId}, ${args.kind}, ${args.revision})
    ON CONFLICT (connection_id, room_type_id, kind) DO UPDATE
      SET applied_revision = EXCLUDED.applied_revision, updated_at = now()
      WHERE EXCLUDED.applied_revision > guesthub.channel_sync_state.applied_revision`;

  return {
    status: "sent",
    kind: args.kind,
    batches: batches.length,
    values: batches.reduce((n, b) => n + b.values.length, 0),
    providerTaskId: result.providerTaskId,
  };
}
