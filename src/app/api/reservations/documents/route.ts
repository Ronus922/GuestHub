import { NextResponse } from "next/server";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { sql } from "@/lib/db";
import { getActor, hasPermission, AuthorizationError } from "@/lib/auth/actor";
import {
  BOOKING_ID_RE,
  DOC_TYPES,
  MAX_DOC_BYTES,
  isRealDocument,
  pendingDocRelPath,
  bookingDocRelPath,
  docAbsPath,
  bookingDocsDir,
  pendingDocsDir,
} from "@/lib/reservations/documents";

// Booking-document upload (both booking windows). The rooms-image pattern
// (api/rooms/images): session-authenticated, permission-checked, tenant-scoped,
// strict MIME/size + magic-byte validation, uuid filenames in the durable
// uploads store. An API route rather than a server action ON PURPOSE: server
// actions carry Next's default 1MB body ceiling, and a passport scan or PDF is
// routinely larger.
//
// bookingId is OPTIONAL: the create wizard uploads before a reservation
// exists (booking_id NULL, file under bookings/pending/); the row is attached
// inside createReservationAction's transaction and the file then moves under
// its booking directory.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    // the wizard runs on reservations.create, the edit window on reservations.edit
    if (!hasPermission(actor, "reservations.edit") && !hasPermission(actor, "reservations.create")) {
      return NextResponse.json({ error: "אין הרשאה להעלאת מסמכים" }, { status: 403 });
    }

    const form = await request.formData();
    const bookingId = String(form.get("bookingId") ?? "") || null;
    const file = form.get("file");
    if (!(file instanceof File) || (bookingId !== null && !BOOKING_ID_RE.test(bookingId))) {
      return NextResponse.json({ error: "קלט לא תקין" }, { status: 400 });
    }
    const ext = DOC_TYPES[file.type];
    if (!ext) {
      return NextResponse.json({ error: "פורמט לא נתמך — JPG, PNG או PDF" }, { status: 400 });
    }
    if (file.size > MAX_DOC_BYTES) {
      return NextResponse.json({ error: "קובץ גדול מ-15MB" }, { status: 400 });
    }

    // an attached upload must target a live reservation of THIS tenant
    if (bookingId) {
      const [res] = await sql<{ id: string }[]>`
        SELECT id FROM guesthub.reservations
        WHERE id = ${bookingId} AND tenant_id = ${actor.tenantId}`;
      if (!res) return NextResponse.json({ error: "ההזמנה לא נמצאה" }, { status: 404 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (!isRealDocument(buf, file.type)) {
      return NextResponse.json({ error: "הקובץ אינו תואם את הפורמט המוצהר" }, { status: 400 });
    }

    // a duplicate display name within the same reservation gets a running
    // suffix: "שם", "שם (2)", "שם (3)" …
    const displayName = await uniqueFileName(actor.tenantId, bookingId, file.name || `מסמך${ext}`, ext);

    const storageName = `${crypto.randomUUID()}${ext}`;
    const relPath = bookingId
      ? bookingDocRelPath(bookingId, storageName)
      : pendingDocRelPath(storageName);
    await mkdir(bookingId ? bookingDocsDir(bookingId) : pendingDocsDir(), { recursive: true });
    await writeFile(docAbsPath(relPath), buf);

    try {
      const [doc] = await sql<
        { id: string; file_name: string; mime_type: string; size_bytes: number; storage_path: string }[]
      >`
        INSERT INTO guesthub.booking_documents
          (tenant_id, booking_id, file_name, original_name, mime_type, size_bytes, storage_path, uploaded_by)
        VALUES
          (${actor.tenantId}, ${bookingId}, ${displayName}, ${file.name || displayName},
           ${file.type}, ${file.size}, ${relPath}, ${actor.userId})
        RETURNING id, file_name, mime_type, size_bytes, storage_path`;
      return NextResponse.json({ document: doc });
    } catch (e) {
      await rm(docAbsPath(relPath), { force: true }); // no orphan file when the row fails
      throw e;
    }
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    console.error("[reservations:document-upload]", e);
    return NextResponse.json({ error: "אירעה שגיאה בלתי צפויה" }, { status: 500 });
  }
}

async function uniqueFileName(
  tenantId: string,
  bookingId: string | null,
  uploadedName: string,
  ext: string,
): Promise<string> {
  const dot = uploadedName.lastIndexOf(".");
  const base = (dot > 0 ? uploadedName.slice(0, dot) : uploadedName).trim() || "מסמך";
  const taken = new Set(
    (
      await sql<{ file_name: string }[]>`
        SELECT file_name FROM guesthub.booking_documents
        WHERE tenant_id = ${tenantId} AND booking_id IS NOT DISTINCT FROM ${bookingId}
          AND deleted_at IS NULL`
    ).map((r) => r.file_name),
  );
  let candidate = `${base}${ext}`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base} (${n})${ext}`;
  return candidate;
}
