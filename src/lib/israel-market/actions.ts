"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor } from "@/lib/auth/actor";
import { requirePermission, AuthorizationError } from "@/lib/auth/permission-check";
import { writeAudit } from "@/lib/audit";

// ============================================================
// Israel-market capabilities (Stage 5 §21).
//  · Tourist VAT zero-rating — set reservations.tax_exempt (foreign tourist).
//  · Privacy / Amendment 13 — anonymize a guest's PII on request while keeping
//    the row (FK + financial/audit integrity) intact.
// Both are audited. The invoice/receipt seam is a typed interface in ./invoice.ts
// (external provider is a deployment dependency — V2 §2).
// ============================================================

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

// §21 tourist VAT zero-rating. Flags/unflags a reservation as tax-exempt. A
// zero-rated stay SHOULD have a foreign primary guest (passport evidence:
// guests.country + id_number) — enforced as a soft warning, not a hard block, so
// legitimate edge cases are not lost, but the audit records the evidence state.
export async function setReservationTaxExemptAction(
  reservationId: string,
  exempt: boolean,
): Promise<Result<{ evidenceComplete: boolean }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    const [row] = await sql<{ id: string; country: string | null; id_number: string | null }[]>`
      UPDATE guesthub.reservations r
      SET tax_exempt = ${exempt}, updated_at = now()
      FROM guesthub.guests g
      WHERE r.id = ${reservationId} AND r.tenant_id = ${actor.tenantId}
        AND (g.id = r.primary_guest_id OR r.primary_guest_id IS NULL)
      RETURNING r.id, g.country, g.id_number`;
    if (!row) return { success: false, error: "ההזמנה לא נמצאה" };
    const evidenceComplete = !exempt || (!!row.country && row.country.toUpperCase() !== "IL" && !!row.id_number);
    await writeAudit(actor, {
      entityType: "reservation", entityId: reservationId, action: "set_tax_exempt",
      after: { tax_exempt: exempt, evidence_complete: evidenceComplete },
    });
    revalidatePath("/reservations");
    return { success: true, data: { evidenceComplete } };
  } catch (e) {
    return fail(e);
  }
}

// §21 privacy — anonymize a guest's PII (Amendment 13 right-to-erasure). Scrubs
// identifying fields but KEEPS the row so reservations, payments and the audit
// trail stay coherent (financial/legal records are retained; identity is not).
// Irreversible; audited (field NAMES only, never the erased values).
export async function anonymizeGuestAction(guestId: string): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "guests.delete");
    const done = await sql.begin(async (tx) => {
      const [guest] = await tx<{ id: string; anonymized_at: string | null }[]>`
        SELECT id, anonymized_at::text AS anonymized_at FROM guesthub.guests
        WHERE id = ${guestId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!guest) return { ok: false as const, error: "האורח לא נמצא" };
      if (guest.anonymized_at) return { ok: false as const, error: "האורח כבר עבר אנונימיזציה" };
      await tx`
        UPDATE guesthub.guests
        SET first_name = NULL, last_name = NULL, full_name = 'אורח שהוסר',
            phone = NULL, email = NULL, id_number = NULL, address = NULL,
            city = NULL, company = NULL, notes = NULL, is_vip = false,
            anonymized_at = now(), updated_at = now()
        WHERE id = ${guestId} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "guest", entityId: guestId, action: "anonymize",
        // NAMES only — never the erased PII values
        after: { fields: ["first_name", "last_name", "full_name", "phone", "email", "id_number", "address", "city", "company", "notes"] },
      }, tx);
      return { ok: true as const };
    });
    if (!done.ok) return { success: false, error: done.error };
    revalidatePath("/guests");
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

function fail(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error("[israel-market]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}
