"use server";

import { z } from "zod";
import { sql } from "@/lib/db";
import {
  getActor,
  hasPermission,
  requirePermission,
  AuthorizationError,
  type Actor,
} from "@/lib/auth/actor";
import {
  DOC_TYPES,
  bookingDocumentUrl,
  type BookingDocumentRow,
} from "@/lib/reservations/documents";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// Booking-document actions (list / rename / soft-delete). Upload is the ONE
// operation that is NOT a server action — it goes through
// POST /api/reservations/documents (the rooms-image pattern) because server
// actions carry Next's default 1MB body ceiling. Everything here follows the
// house action pattern: session actor, permission check, tenant scoping, Zod.
//
// Deletion is SOFT (deleted_at) — the disk file stays; no physical removal in
// this phase. Rows with booking_id NULL are the create wizard's pre-created
// documents: the same tenant-scoped actions manage them until they are either
// attached (createReservationAction) or discarded (soft-deleted on wizard
// cancel).
// ============================================================

export type BookingDocumentView = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: "pdf" | "image";
  /** authenticated serving URL — null while the document is not attached yet */
  url: string | null;
};

const fail = (error: string): { success: false; error: string } => ({ success: false, error });

function toView(row: Pick<BookingDocumentRow, "id" | "booking_id" | "file_name" | "mime_type" | "size_bytes" | "storage_path">): BookingDocumentView {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    kind: row.mime_type === "application/pdf" ? "pdf" : "image",
    url: row.booking_id ? bookingDocumentUrl(row.booking_id, row.storage_path) : null,
  };
}

// the wizard runs on reservations.create, the edit window on reservations.edit
function requireDocumentAccess(actor: Actor | null): asserts actor is Actor {
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  if (!hasPermission(actor, "reservations.edit") && !hasPermission(actor, "reservations.create")) {
    throw new AuthorizationError("אין הרשאה לניהול מסמכי הזמנה");
  }
}

export async function listBookingDocumentsAction(
  reservationId: string,
): Promise<ActionResult<BookingDocumentView[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.view");
    const parsed = z.uuid().safeParse(reservationId);
    if (!parsed.success) return fail("קלט לא תקין");
    const rows = await sql<BookingDocumentRow[]>`
      SELECT id, booking_id, file_name, original_name, mime_type, size_bytes,
             storage_path, created_at::text AS created_at
      FROM guesthub.booking_documents
      WHERE tenant_id = ${actor.tenantId} AND booking_id = ${parsed.data}
        AND deleted_at IS NULL
      ORDER BY created_at`;
    return { success: true, data: rows.map(toView) };
  } catch (e) {
    return fail(e instanceof AuthorizationError ? e.message : "טעינת המסמכים נכשלה");
  }
}

const renameSchema = z.object({
  docId: z.uuid(),
  // the BASE name only — the extension is server-owned and never changes
  base: z.string().trim().min(1, "נדרש שם").max(120),
});

export async function renameBookingDocumentAction(
  raw: z.infer<typeof renameSchema>,
): Promise<ActionResult<{ fileName: string }>> {
  try {
    const actor = await getActor();
    requireDocumentAccess(actor);
    const parsed = renameSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    // strip path separators — the display name must never look like a path
    const base = parsed.data.base.replace(/[/\\]/g, " ").trim();
    if (!base) return fail("נדרש שם");
    const [row] = await sql<{ mime_type: string }[]>`
      SELECT mime_type FROM guesthub.booking_documents
      WHERE id = ${parsed.data.docId} AND tenant_id = ${actor.tenantId} AND deleted_at IS NULL`;
    if (!row) return fail("המסמך לא נמצא");
    const fileName = `${base}${DOC_TYPES[row.mime_type] ?? ""}`;
    await sql`
      UPDATE guesthub.booking_documents SET file_name = ${fileName}
      WHERE id = ${parsed.data.docId} AND tenant_id = ${actor.tenantId}`;
    return { success: true, data: { fileName } };
  } catch (e) {
    return fail(e instanceof AuthorizationError ? e.message : "שינוי השם נכשל");
  }
}

export async function deleteBookingDocumentAction(docId: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requireDocumentAccess(actor);
    const parsed = z.uuid().safeParse(docId);
    if (!parsed.success) return fail("קלט לא תקין");
    // soft delete — the row is hidden from every read path; the file stays
    await sql`
      UPDATE guesthub.booking_documents SET deleted_at = now()
      WHERE id = ${parsed.data} AND tenant_id = ${actor.tenantId} AND deleted_at IS NULL`;
    return { success: true, data: undefined };
  } catch (e) {
    return fail(e instanceof AuthorizationError ? e.message : "המחיקה נכשלה");
  }
}
