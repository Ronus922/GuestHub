import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { lookupBiosBotReservationsByCustomer } from "@/lib/bios-bot/service/reservations";

// GET /api/bios-bot/v1/reservations?reservation_number=...
// GET /api/bios-bot/v1/reservations?phone=...
// GET /api/bios-bot/v1/reservations?email=...
// READ. guesthub.get_guest_reservations — exactly ONE exact identifier
// required (never a free-text/substring search; see
// src/lib/bios-bot/service/reservations.ts for why).
export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    reservation_number: z.string().trim().min(1).max(40).optional(),
    phone: z.string().trim().min(5).max(30).optional(),
    email: z.string().trim().email().max(200).optional(),
  })
  .refine(
    (v) => [v.reservation_number, v.phone, v.email].filter((x) => x != null).length === 1,
    "exactly one of reservation_number, phone, or email is required",
  );

export async function GET(req: Request): Promise<NextResponse> {
  const auth = authenticateBiosBotRequest(req);
  if (!auth.ok) return auth.response;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return biosBotErrorResponse("VALIDATION_ERROR", "exactly one of reservation_number, phone, or email is required");

  const { reservation_number, phone, email } = parsed.data;
  const query = reservation_number
    ? { reservationNumber: reservation_number }
    : phone
      ? { phone }
      : { email: email! };

  try {
    const reservations = await lookupBiosBotReservationsByCustomer(sql, auth.ctx.tenantId, query);
    return NextResponse.json({ ok: true, reservations });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot guest reservation lookup");
  }
}
