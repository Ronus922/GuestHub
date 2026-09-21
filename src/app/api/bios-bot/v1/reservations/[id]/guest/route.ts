import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { withBiosBotIdempotency } from "@/lib/bios-bot/idempotency";
import { updateBiosBotGuestDetails } from "@/lib/bios-bot/service/update-guest-details";

// PATCH /api/bios-bot/v1/reservations/{id}/guest
// WRITE. guesthub.update_guest_details — a fixed, narrow field set only.
export const dynamic = "force-dynamic";

const idSchema = z.uuid();
const bodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().min(5).max(30).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");

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

  try {
    const guest = await withBiosBotIdempotency(
      sql,
      { tenantId: auth.ctx.tenantId, operation: "update_guest_details", idempotencyKey, request: { reservationId: idResult.data, ...parsed.data } },
      (tx) => updateBiosBotGuestDetails(tx, auth.ctx.tenantId, idResult.data, parsed.data),
    );
    return NextResponse.json({ ok: true, guest });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot update guest details");
  }
}
