import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { isDateOnly } from "@/lib/dates";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { withBiosBotIdempotency } from "@/lib/bios-bot/idempotency";
import { changeBiosBotReservationStay } from "@/lib/bios-bot/service/change-stay";

// PATCH /api/bios-bot/v1/reservations/{id}/stay
// WRITE. guesthub.change_stay — dates and/or room for ONE stay (identified
// by stayId, from GET .../reservations/{id}), never the whole reservation.
export const dynamic = "force-dynamic";

const idSchema = z.uuid();
const bodySchema = z.object({
  stayId: z.uuid(),
  roomId: z.uuid().optional(),
  checkIn: z.string().refine(isDateOnly, "invalid checkIn"),
  checkOut: z.string().refine(isDateOnly, "invalid checkOut"),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = authenticateBiosBotRequest(req);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const idResult = idSchema.safeParse(id);
  if (!idResult.success) return biosBotErrorResponse("VALIDATION_ERROR", "invalid reservation id");

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.trim().length === 0) {
    return biosBotErrorResponse("VALIDATION_ERROR", "the Idempotency-Key header is required");
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return biosBotErrorResponse("VALIDATION_ERROR", "invalid JSON body");
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return biosBotErrorResponse("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "invalid body");
  if (parsed.data.checkOut <= parsed.data.checkIn) return biosBotErrorResponse("INVALID_DATES", "checkOut must be after checkIn");

  try {
    const stay = await withBiosBotIdempotency(
      sql,
      { tenantId: auth.ctx.tenantId, operation: "change_stay", idempotencyKey, request: { reservationId: idResult.data, ...parsed.data } },
      (tx) => changeBiosBotReservationStay(tx, auth.ctx.tenantId, idResult.data, parsed.data.stayId, parsed.data),
    );
    return NextResponse.json({ ok: true, stay });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot change stay");
  }
}
