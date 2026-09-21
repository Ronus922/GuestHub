import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { isDateOnly } from "@/lib/dates";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { searchBiosBotAvailability } from "@/lib/bios-bot/service/availability";

// GET /api/bios-bot/v1/availability?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD&adults=2&children=0&infants=0
// READ. Authoritative availability (publicAvailability) filtered by the
// authoritative capacity rule (getRoomCapacities) — see
// src/lib/bios-bot/service/availability.ts for why this is not a parallel
// availability algorithm.
export const dynamic = "force-dynamic";

const querySchema = z.object({
  check_in: z.string().refine(isDateOnly, "invalid check_in"),
  check_out: z.string().refine(isDateOnly, "invalid check_out"),
  adults: z.coerce.number().int().min(1).max(20),
  children: z.coerce.number().int().min(0).max(20).default(0),
  infants: z.coerce.number().int().min(0).max(20).default(0),
});

export async function GET(req: Request): Promise<NextResponse> {
  const auth = authenticateBiosBotRequest(req);
  if (!auth.ok) return auth.response;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return biosBotErrorResponse("VALIDATION_ERROR", "invalid query parameters");
  const { check_in: checkIn, check_out: checkOut, adults, children, infants } = parsed.data;
  if (checkOut <= checkIn) return biosBotErrorResponse("INVALID_DATES", "check_out must be after check_in");

  try {
    const roomTypes = await searchBiosBotAvailability(sql, auth.ctx.tenantId, {
      checkIn, checkOut, adults, children, infants,
    });
    return NextResponse.json({ ok: true, checkIn, checkOut, adults, children, infants, roomTypes });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot availability search");
  }
}
