import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { getBiosBotRoom } from "@/lib/bios-bot/service/rooms";

// GET /api/bios-bot/v1/rooms/{id}[?lang=he|en|ar]
// READ. Customer-safe single-room detail — reuses publicWebsiteRooms verbatim.
export const dynamic = "force-dynamic";

const idSchema = z.uuid();
const querySchema = z.object({ lang: z.enum(["he", "en", "ar"]).default("he") });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = authenticateBiosBotRequest(req);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const idResult = idSchema.safeParse(id);
  if (!idResult.success) return biosBotErrorResponse("VALIDATION_ERROR", "invalid room id");
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return biosBotErrorResponse("VALIDATION_ERROR", "invalid query parameters");

  try {
    const room = await getBiosBotRoom(sql, auth.ctx.tenantId, idResult.data, parsed.data.lang);
    // no dedicated ROOM_NOT_FOUND in the stable contract — mapPricingErrorCode
    // buckets the engine's own ROOM_NOT_FOUND into the same code, on purpose.
    if (!room) return biosBotErrorResponse("ROOM_NOT_AVAILABLE", "room not found");
    return NextResponse.json({ ok: true, room });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot room detail");
  }
}
