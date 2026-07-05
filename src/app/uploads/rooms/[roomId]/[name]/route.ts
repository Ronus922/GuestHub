import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { IMAGE_MIME, IMAGE_NAME_RE, ROOM_ID_RE, roomUploadPath } from "@/lib/rooms/uploads";

// Serves room images from the durable uploads store (see lib/rooms/uploads.ts).
// public/ can't serve runtime uploads (`next start` snapshots it at boot), so
// this route owns the stable /uploads/rooms/<roomId>/<file> URLs. Filenames are
// server-generated UUIDs — the strict patterns double as traversal protection.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ roomId: string; name: string }> },
) {
  const { roomId, name } = await params;
  if (!ROOM_ID_RE.test(roomId) || !IMAGE_NAME_RE.test(name)) {
    return new NextResponse(null, { status: 404 });
  }
  try {
    const buf = await readFile(roomUploadPath(roomId, name));
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
