import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { isDateOnly } from "@/lib/dates";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { lookupBiosBotReservationsByCustomer } from "@/lib/bios-bot/service/reservations";
import { withBiosBotIdempotency } from "@/lib/bios-bot/idempotency";
import { createBiosBotReservation } from "@/lib/bios-bot/service/create-reservation";

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

// POST /api/bios-bot/v1/reservations
// WRITE. guesthub.create_reservation — see src/lib/bios-bot/service/
// create-reservation.ts for the full transaction and the INITIAL STATUS
// decision. Requires an Idempotency-Key header (Phase 5 §11/§13): GuestHub
// itself has no other defense against a retried create producing a second
// reservation.
const createRoomSchema = z.object({
  roomId: z.uuid(),
  ratePlanId: z.uuid().nullable().optional(),
  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20).default(0),
  infants: z.number().int().min(0).max(20).default(0),
});

const createBodySchema = z.object({
  checkIn: z.string().refine(isDateOnly, "invalid checkIn"),
  checkOut: z.string().refine(isDateOnly, "invalid checkOut"),
  rooms: z.array(createRoomSchema).min(1).max(10),
  quoteFingerprint: z.string().min(1),
  guest: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(5).max(30).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
  }),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const auth = authenticateBiosBotRequest(req);
  if (!auth.ok) return auth.response;

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
  const parsed = createBodySchema.safeParse(json);
  if (!parsed.success) return biosBotErrorResponse("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "invalid body");
  if (parsed.data.checkOut <= parsed.data.checkIn) return biosBotErrorResponse("INVALID_DATES", "checkOut must be after checkIn");

  try {
    const reservation = await withBiosBotIdempotency(
      sql,
      { tenantId: auth.ctx.tenantId, operation: "create_reservation", idempotencyKey, request: parsed.data },
      (tx) => createBiosBotReservation(tx, auth.ctx.tenantId, idempotencyKey, parsed.data),
    );
    return NextResponse.json({ ok: true, reservation }, { status: 201 });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot create reservation");
  }
}
