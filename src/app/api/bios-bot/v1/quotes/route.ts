import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { isDateOnly } from "@/lib/dates";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { getBiosBotQuote } from "@/lib/bios-bot/service/quote";

// POST /api/bios-bot/v1/quotes
// READ (computes a price; writes nothing). Thin wrapper around
// calculateReservationPrice — see src/lib/bios-bot/service/quote.ts.
export const dynamic = "force-dynamic";

const roomSchema = z.object({
  roomId: z.uuid(),
  ratePlanId: z.uuid().nullable().optional(),
  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20).default(0),
  infants: z.number().int().min(0).max(20).default(0),
});

const bodySchema = z.object({
  checkIn: z.string().refine(isDateOnly, "invalid checkIn"),
  checkOut: z.string().refine(isDateOnly, "invalid checkOut"),
  rooms: z.array(roomSchema).min(1).max(10),
});

export async function POST(req: Request): Promise<NextResponse> {
  const auth = authenticateBiosBotRequest(req);
  if (!auth.ok) return auth.response;

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
    const quote = await getBiosBotQuote(sql, auth.ctx.tenantId, parsed.data);
    return NextResponse.json({ ok: true, quote });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot quote");
  }
}
