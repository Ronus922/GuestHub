import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { IMAGE_MIME } from "@/lib/rooms/uploads";
import { logoUploadPath, TENANT_ID_RE, LOGO_NAME_RE } from "@/lib/business/uploads";

// Serves business logos from the durable uploads store (see lib/business/uploads.ts).
// Logos are public brand assets; access relies on UUID-unguessable filenames, and
// the strict patterns double as path-traversal protection. Mirrors the room-image
// serve route.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tenantId: string; name: string }> },
) {
  const { tenantId, name } = await params;
  if (!TENANT_ID_RE.test(tenantId) || !LOGO_NAME_RE.test(name)) {
    return new NextResponse(null, { status: 404 });
  }
  try {
    const buf = await readFile(logoUploadPath(tenantId, name));
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": IMAGE_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
