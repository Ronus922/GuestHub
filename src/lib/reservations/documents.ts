import path from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { UPLOADS_DIR } from "@/lib/rooms/uploads";
import type { Sql } from "postgres";

// Booking-document storage (the lib/rooms/uploads.ts pattern): files live in
// the durable uploads store OUTSIDE the app tree, named by a server-generated
// uuid — never by anything the user typed. storage_path in
// guesthub.booking_documents is RELATIVE to UPLOADS_DIR:
//   before attach:  bookings/pending/<uuid>.<ext>   (wizard, no booking yet)
//   after attach:   bookings/<bookingId>/<uuid>.<ext>
// Serving (app/uploads/bookings/[bookingId]/[name]) resolves the row first —
// session + tenant + booking checked — and reads whatever storage_path says,
// so a document survives even if a post-attach file move ever failed.

export const BOOKING_ID_RE = /^[0-9a-f-]{36}$/i;
export const DOC_NAME_RE = /^[0-9a-f-]{36}\.(jpg|png|pdf)$/i;

export const MAX_DOC_BYTES = 15 * 1024 * 1024; // the rooms-upload ceiling (MAX_IMAGE_BYTES)

// MIME → extension allow-list (the migration's CHECK mirrors these three)
export const DOC_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

// client-declared MIME is not trusted — verify the leading bytes
// (images via the shared magic-byte check; PDF by its %PDF- header)
export function isRealDocument(buf: Buffer, mime: string): boolean {
  if (mime === "application/pdf") {
    return buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
  }
  if (buf.length < 12) return false;
  if (mime === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === "image/png") {
    return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return false;
}

export const pendingDocRelPath = (name: string) => path.posix.join("bookings", "pending", name);
export const bookingDocRelPath = (bookingId: string, name: string) =>
  path.posix.join("bookings", bookingId, name);
export const docAbsPath = (relPath: string) => path.join(UPLOADS_DIR, relPath);
export const bookingDocsDir = (bookingId: string) => path.join(UPLOADS_DIR, "bookings", bookingId);
export const pendingDocsDir = () => path.join(UPLOADS_DIR, "bookings", "pending");

export type BookingDocumentRow = {
  id: string;
  booking_id: string | null;
  file_name: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  created_at: string;
};

/** the /uploads serving URL of a stored document (attached bookings only) */
export function bookingDocumentUrl(bookingId: string, storagePath: string): string {
  return `/uploads/bookings/${bookingId}/${path.posix.basename(storagePath)}`;
}

// Move the wizard's pending files under their new booking directory and point
// storage_path at the final location. Runs AFTER the creation transaction
// committed — fs operations are not transactional, so a failure here must
// never undo the reservation; the row keeps its pending path and stays fully
// servable. Best-effort by design.
export async function moveAttachedDocumentFiles(
  tx: Sql,
  tenantId: string,
  bookingId: string,
  docIds: string[],
): Promise<void> {
  if (docIds.length === 0) return;
  const rows = await tx<{ id: string; storage_path: string }[]>`
    SELECT id, storage_path FROM guesthub.booking_documents
    WHERE tenant_id = ${tenantId} AND booking_id = ${bookingId}
      AND id = ANY(${docIds}) AND deleted_at IS NULL`;
  if (rows.length === 0) return;
  await mkdir(bookingDocsDir(bookingId), { recursive: true });
  for (const row of rows) {
    const target = bookingDocRelPath(bookingId, path.posix.basename(row.storage_path));
    if (row.storage_path === target) continue;
    try {
      await rename(docAbsPath(row.storage_path), docAbsPath(target));
      await tx`
        UPDATE guesthub.booking_documents SET storage_path = ${target}
        WHERE id = ${row.id} AND tenant_id = ${tenantId}`;
    } catch (e) {
      // the row still points at the pending file — serving keeps working
      console.error("[booking-docs:move]", row.id, e);
    }
  }
}
