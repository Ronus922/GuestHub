import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { redactPayload } from "./payloads";

// ============================================================
// Inbound booking-revision foundation (§X). NOT active in Phase 3 — no
// polling, no acknowledgement, no imports run. These primitives define the
// safe lifecycle for activation:
//   persist (idempotent, redacted) → import/quarantine → acknowledge.
// ============================================================

export type RevisionInput = {
  tenantId: string;
  connectionId: string;
  providerBookingId: string;
  providerRevisionId: string;
  uniqueId?: string;
  systemId?: string;
  otaReservationCode?: string;
  otaName?: string;
  revisionKind: "new" | "modified" | "cancelled";
  rawStatus?: string;
  payload: unknown;
};

// Idempotent persistence: the same provider revision can never be stored (and
// therefore never imported) twice — identity is (connection, revision_id),
// never the OTA reservation code alone.
export async function persistBookingRevision(
  db: Sql | TransactionSql,
  rev: RevisionInput,
): Promise<{ id: string; duplicate: false } | { duplicate: true }> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO guesthub.channel_booking_revisions
      (tenant_id, connection_id, provider_booking_id, provider_revision_id,
       unique_id, system_id, ota_reservation_code, ota_name,
       revision_kind, raw_status, payload)
    VALUES
      (${rev.tenantId}, ${rev.connectionId}, ${rev.providerBookingId},
       ${rev.providerRevisionId}, ${rev.uniqueId ?? null}, ${rev.systemId ?? null},
       ${rev.otaReservationCode ?? null}, ${rev.otaName ?? null},
       ${rev.revisionKind}, ${rev.rawStatus ?? null},
       ${db.json(redactPayload(rev.payload) as never)})
    ON CONFLICT (connection_id, provider_revision_id) DO NOTHING
    RETURNING id`;
  return rows[0] ? { id: rows[0].id, duplicate: false } : { duplicate: true };
}

// Unmapped room type / rate plan → quarantined with a visible error, raw
// identifiers retained; never silently discarded, never a broken local
// reservation, never falsely acknowledged.
export async function quarantineRevision(
  db: Sql | TransactionSql,
  revisionId: string,
  mappingError: string,
): Promise<void> {
  await db`
    UPDATE guesthub.channel_booking_revisions SET
      import_status = 'quarantined', mapping_error = ${mappingError},
      attempts = attempts + 1
    WHERE id = ${revisionId}`;
}

// Mark imported — call ONLY inside the transaction that created the local
// reservation/inventory hold, so "imported" implies durably saved.
export async function markRevisionImported(
  tx: TransactionSql,
  revisionId: string,
  localReservationId: string | null,
): Promise<void> {
  await tx`
    UPDATE guesthub.channel_booking_revisions SET
      import_status = 'imported', local_reservation_id = ${localReservationId},
      mapping_error = NULL
    WHERE id = ${revisionId}`;
}

// Acknowledgement gate (§X): a revision may be acknowledged only AFTER its
// local transaction committed with import_status='imported'. The WHERE clause
// makes early acknowledgement structurally impossible.
export async function markRevisionAcknowledged(
  db: Sql | TransactionSql,
  revisionId: string,
): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    UPDATE guesthub.channel_booking_revisions SET
      ack_status = 'acknowledged', acknowledged_at = now()
    WHERE id = ${revisionId}
      AND import_status = 'imported'
      AND ack_status = 'unacknowledged'
    RETURNING id`;
  return rows.length > 0;
}
