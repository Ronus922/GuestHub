import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { loadBookingDocData, bookingFileName } from "@/lib/pdf/booking-doc-data";
import { BookingPdf } from "@/lib/pdf/BookingPdf";

// GET /api/reservations/[id]/pdf → downloads the booking confirmation as a PDF.
// Node runtime (react-pdf + node:path + fonts read from the filesystem); always
// dynamic (per-request auth, live reservation data).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const loaded = await loadBookingDocData(id);
  if (!loaded) return new Response("Not found or unauthorized", { status: 404 });
  const { actor, doc } = loaded;

  // JSX is not allowed in a .ts route handler → build the element imperatively.
  // BookingPdf renders a <Document>; the cast aligns the element's props generic
  // with renderToBuffer's expected ReactElement<DocumentProps>.
  const element = createElement(BookingPdf, { doc }) as Parameters<typeof renderToBuffer>[0];
  const buffer = await renderToBuffer(element);

  const { ip, session } = await auditRequestContext();
  await writeAudit(actor, {
    entityType: "reservation",
    entityId: id,
    action: "pdf_generated",
    after: { reservation_number: doc.reservationNumber },
    ip,
    session,
  });

  const base = bookingFileName(doc);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${base}.pdf"; filename*=UTF-8''${encodeURIComponent(`${base}.pdf`)}`,
      "Cache-Control": "no-store",
    },
  });
}
