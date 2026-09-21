import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { listBiosBotRooms } from "@/lib/bios-bot/service/rooms";

// GET /api/bios-bot/v1/rooms[?lang=he|en|ar]
// READ. Customer-safe room catalog — reuses publicWebsiteRooms verbatim.
export const dynamic = "force-dynamic";

const querySchema = z.object({ lang: z.enum(["he", "en", "ar"]).default("he") });

export async function GET(req: Request): Promise<NextResponse> {
  const auth = authenticateBiosBotRequest(req);
  if (!auth.ok) return auth.response;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return biosBotErrorResponse("VALIDATION_ERROR", "invalid query parameters");

  try {
    const rooms = await listBiosBotRooms(sql, auth.ctx.tenantId, parsed.data.lang);
    return NextResponse.json({ ok: true, rooms });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot rooms list");
  }
}
