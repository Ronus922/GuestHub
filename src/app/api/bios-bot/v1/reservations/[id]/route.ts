import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { getBiosBotReservation } from "@/lib/bios-bot/service/reservations";

// GET /api/bios-bot/v1/reservations/{id}
// READ. Minimized, customer-service-safe reservation lookup — never joins
// guesthub.reservation_cards (see src/lib/bios-bot/service/reservations.ts).
export const dynamic = "force-dynamic";

const idSchema = z.uuid();

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = authenticateBiosBotRequest(req);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const idResult = idSchema.safeParse(id);
  if (!idResult.success) return biosBotErrorResponse("VALIDATION_ERROR", "invalid reservation id");

  try {
    const reservation = await getBiosBotReservation(sql, auth.ctx.tenantId, idResult.data);
    return NextResponse.json({ ok: true, reservation });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot reservation lookup");
  }
}
