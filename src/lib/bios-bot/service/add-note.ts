import "server-only";
import type { TransactionSql } from "postgres";
import { writeSystemAudit } from "@/lib/audit";
import { BiosBotError } from "../errors";

// ============================================================
// guesthub.add_note (Phase 5 §14C).
//
// Writes to reservations.internal_notes — a deliberate, explicit choice,
// not reservations.notes: `notes` can carry staff-authored billing text
// (migration 059) and is surfaced nowhere in this boundary's own read model
// (src/lib/bios-bot/service/reservations.ts) precisely because its exact
// contents are not yet a settled product decision. `internal_notes` is
// already staff-only everywhere else in GuestHub, so a bot-authored note
// landing there cannot leak to a guest-facing surface by construction.
//
// APPENDS (timestamped, attributed) rather than overwriting — the model
// never gets to erase a human operator's prior notes.
// ============================================================

export type BiosBotAddNoteRequest = { note: string };
export type BiosBotAddedNote = { reservationId: string };

export async function addBiosBotNote(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
  req: BiosBotAddNoteRequest,
): Promise<{ resourceId: string; response: BiosBotAddedNote }> {
  const [res] = await tx<{ internal_notes: string | null }[]>`
    SELECT internal_notes FROM guesthub.reservations
    WHERE tenant_id = ${tenantId} AND id = ${reservationId}
    FOR UPDATE`;
  if (!res) throw new BiosBotError("RESERVATION_NOT_FOUND", "reservation not found");

  const line = `[BIOS Bot ${new Date().toISOString()}] ${req.note}`;
  const updated = res.internal_notes ? `${res.internal_notes}\n${line}` : line;

  await tx`
    UPDATE guesthub.reservations SET internal_notes = ${updated}
    WHERE id = ${reservationId} AND tenant_id = ${tenantId}`;

  await writeSystemAudit(tenantId, {
    entityType: "reservation",
    entityId: reservationId,
    action: "note",
    after: { note: req.note },
    session: "bios-bot",
  }, tx);

  return { resourceId: reservationId, response: { reservationId } };
}
