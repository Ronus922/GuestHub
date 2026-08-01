import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireBookingSecret } from "@/lib/public-booking/config";
import { publicWebsiteRooms } from "@/lib/public-booking/rooms";

// GET /api/public/rooms[?lang=he]
// Server-to-server (sea-tower). Read-only room CATALOG — content, gallery and
// amenities for every room the owner marked show_on_website. Date-dependent
// facts (availability, price) belong to /api/public/availability, never here.
export const dynamic = "force-dynamic";

const LANGS = ["he", "en", "ar"] as const;
type Lang = (typeof LANGS)[number];
const isLang = (v: string): v is Lang => (LANGS as readonly string[]).includes(v);

export async function GET(req: Request): Promise<NextResponse> {
  if (!requireBookingSecret(req)) {
    return NextResponse.json({ ok: false, code: "unauthorized" }, { status: 401 });
  }

  const requested = new URL(req.url).searchParams.get("lang") ?? "he";
  if (!isLang(requested)) {
    return NextResponse.json(
      { ok: false, code: "validation", message: "שפה לא נתמכת" },
      { status: 400 },
    );
  }

  try {
    const rooms = await publicWebsiteRooms(sql, requested);
    return NextResponse.json({ ok: true, lang: requested, rooms });
  } catch (e) {
    console.error("[public-booking] rooms failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, code: "internal" }, { status: 500 });
  }
}
