import { NextResponse } from "next/server";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { roomUploadsDir, roomUploadPath } from "@/lib/rooms/uploads";
import { IMAGE_TYPES as TYPES, MAX_IMAGE_BYTES as MAX_BYTES, isRealImage } from "@/lib/uploads/image";

// Room image upload (wizard step 2). Session-authenticated + rooms.edit,
// tenant-scoped room ownership check, strict type/size + magic-byte validation
// (shared with the business-logo upload via lib/uploads/image.ts). Files land in
// the durable uploads store (lib/rooms/uploads.ts — outside the app tree) and
// rows in guesthub.room_images.
// ponytail: local-disk storage; move to Supabase storage if multi-node serving
// ever matters.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    requirePermission(actor, "rooms.edit");

    const form = await request.formData();
    const roomId = String(form.get("roomId") ?? "");
    const file = form.get("file");
    if (!/^[0-9a-f-]{36}$/i.test(roomId) || !(file instanceof File)) {
      return NextResponse.json({ error: "קלט לא תקין" }, { status: 400 });
    }
    const ext = TYPES[file.type];
    if (!ext) return NextResponse.json({ error: "פורמט לא נתמך — JPG, PNG או WEBP" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "קובץ גדול מ-15MB" }, { status: 400 });

    const [room] = await sql<{ id: string }[]>`
      SELECT id FROM guesthub.rooms WHERE id = ${roomId} AND tenant_id = ${actor.tenantId}`;
    if (!room) return NextResponse.json({ error: "החדר לא נמצא" }, { status: 404 });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM guesthub.room_images WHERE room_id = ${roomId}`;
    if (n >= 20) return NextResponse.json({ error: "עד 20 תמונות לחדר" }, { status: 400 });

    const buf = Buffer.from(await file.arrayBuffer());
    if (!isRealImage(buf, file.type)) {
      return NextResponse.json({ error: "הקובץ אינו תמונה תקינה" }, { status: 400 });
    }

    const name = `${crypto.randomUUID()}${ext}`;
    const filePath = roomUploadPath(roomId, name);
    await mkdir(roomUploadsDir(roomId), { recursive: true });
    await writeFile(filePath, buf);

    const url = `/uploads/rooms/${roomId}/${name}`;
    try {
      const [img] = await sql<{ id: string; url: string; alt_text: string | null; is_main: boolean; sort_order: number }[]>`
        INSERT INTO guesthub.room_images (tenant_id, room_id, url, is_main, sort_order)
        VALUES (${actor.tenantId}, ${roomId}, ${url}, ${n === 0}, ${n})
        RETURNING id, url, alt_text, is_main, sort_order`;
      return NextResponse.json({ image: img });
    } catch (e) {
      await rm(filePath, { force: true }); // no orphan file when the row fails
      throw e;
    }
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    console.error("[rooms:image-upload]", e);
    return NextResponse.json({ error: "אירעה שגיאה בלתי צפויה" }, { status: 500 });
  }
}
