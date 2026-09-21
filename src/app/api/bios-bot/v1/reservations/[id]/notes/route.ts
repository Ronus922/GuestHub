import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { authenticateBiosBotRequest } from "@/lib/bios-bot/guard";
import { toBiosBotErrorResponse, biosBotErrorResponse } from "@/lib/bios-bot/errors";
import { withBiosBotIdempotency } from "@/lib/bios-bot/idempotency";
import { addBiosBotNote } from "@/lib/bios-bot/service/add-note";

// PATCH /api/bios-bot/v1/reservations/{id}/notes
// WRITE. guesthub.add_note — appends to reservations.internal_notes (staff-
// only everywhere else in GuestHub; see src/lib/bios-bot/service/add-note.ts).
export const dynamic = "force-dynamic";

const idSchema = z.uuid();
const bodySchema = z.object({ note: z.string().trim().min(1).max(2000) });

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
    const result = await withBiosBotIdempotency(
      sql,
      { tenantId: auth.ctx.tenantId, operation: "add_note", idempotencyKey, request: { reservationId: idResult.data, ...parsed.data } },
      (tx) => addBiosBotNote(tx, auth.ctx.tenantId, idResult.data, parsed.data),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return toBiosBotErrorResponse(e, "bios-bot add note");
  }
}
