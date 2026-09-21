import "server-only";
import type { TransactionSql } from "postgres";
import { writeSystemAudit } from "@/lib/audit";
import { BiosBotError } from "../errors";

// ============================================================
// guesthub.update_guest_details (Phase 5 §14B) — a fixed, narrow field set
// only: first/last name, phone, email. NOT idNumber (staff-verified PII),
// NOT VIP/blocked flags, NOT arbitrary guest columns — the model has no way
// to name a column, only these four request fields.
//
// COALESCE partial-update, the SAME pattern upsertGuest (src/app/(dashboard)/
// reservations/actions.ts) already uses: an omitted field keeps its current
// value, it is never cleared to NULL by omission.
// ============================================================

export type BiosBotUpdateGuestDetailsRequest = {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  email?: string | null;
};

export type BiosBotUpdatedGuestDetails = {
  reservationId: string;
  guestId: string;
};

export async function updateBiosBotGuestDetails(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
  req: BiosBotUpdateGuestDetailsRequest,
): Promise<{ resourceId: string; response: BiosBotUpdatedGuestDetails }> {
  const [res] = await tx<{ primary_guest_id: string | null; status: string }[]>`
    SELECT primary_guest_id, status FROM guesthub.reservations
    WHERE tenant_id = ${tenantId} AND id = ${reservationId}
    FOR UPDATE`;
  if (!res) throw new BiosBotError("RESERVATION_NOT_FOUND", "reservation not found");
  if (res.status === "cancelled") {
    throw new BiosBotError("RESERVATION_NOT_MODIFIABLE", "a cancelled reservation cannot be modified");
  }
  if (!res.primary_guest_id) {
    throw new BiosBotError("RESERVATION_NOT_MODIFIABLE", "this reservation has no linked guest to update");
  }

  const fullName =
    req.firstName && req.lastName ? `${req.firstName} ${req.lastName}`.trim() : null;

  await tx`
    UPDATE guesthub.guests SET
      first_name = COALESCE(${req.firstName ?? null}, first_name),
      last_name  = COALESCE(${req.lastName ?? null}, last_name),
      full_name  = COALESCE(${fullName}, full_name),
      phone      = COALESCE(${req.phone ?? null}, phone),
      email      = COALESCE(${req.email ?? null}, email)
    WHERE id = ${res.primary_guest_id} AND tenant_id = ${tenantId}`;

  await writeSystemAudit(tenantId, {
    entityType: "guest",
    entityId: res.primary_guest_id,
    action: "update",
    after: { fields: Object.keys(req) },
    session: "bios-bot",
  }, tx);

  return { resourceId: reservationId, response: { reservationId, guestId: res.primary_guest_id } };
}
