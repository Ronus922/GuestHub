import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "@/lib/db";
import { getActor } from "@/lib/auth/actor";
import { BOOKING_ID_RE, DOC_NAME_RE, docAbsPath } from "@/lib/reservations/documents";

// Serves booking documents from the durable uploads store. UNLIKE the room
// images route this is NOT public: booking documents are guest IDs and
// passports, so every request must carry a live session, and the file is
// released only when a LIVE booking_documents row of the actor's OWN tenant
// matches both the booking and the uuid filename. The file is read from the
// row's storage_path (not from a path convention), so a document stays
// servable even if its post-attach move ever failed.
// Content-Disposition: inline — the viewer opens in the browser, no forced
// download. Private, never cached.

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookingId: string; name: string }> },
) {
  const { bookingId, name } = await params;
  if (!BOOKING_ID_RE.test(bookingId) || !DOC_NAME_RE.test(name)) {
    return new NextResponse(null, { status: 404 });
  }

  const actor = await getActor();
  if (!actor) return new NextResponse(null, { status: 401 });

  const rows = await sql<{ file_name: string; mime_type: string; storage_path: string }[]>`
    SELECT file_name, mime_type, storage_path FROM guesthub.booking_documents
    WHERE tenant_id = ${actor.tenantId} AND booking_id = ${bookingId}
      AND deleted_at IS NULL`;
  const doc = rows.find((r) => path.posix.basename(r.storage_path) === name);
  if (!doc) return new NextResponse(null, { status: 404 });

  try {
    const buf = await readFile(docAbsPath(doc.storage_path));
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": doc.mime_type,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
