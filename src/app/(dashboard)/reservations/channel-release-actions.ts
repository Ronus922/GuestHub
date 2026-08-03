"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { blocksAutomaticRelease } from "@/lib/inventory";
import { enqueueChannelJob } from "@/lib/channel/queue";
import { getBeds24AccessToken } from "@/lib/channel/beds24-token";
import { beds24Request } from "@/lib/channel/beds24-http";
import { beds24BaseUrl } from "@/lib/channel/config";
import { beds24BookingIdentity } from "@/lib/channel/beds24-normalize";
import { asObj } from "@/lib/channel/channel-http";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// D127 — the supervised channel release (D93 layer 3) lives HERE, and not in
// reservations/actions.ts, because it is the one reservation action that is
// deliberately allowed to talk to Beds24.
//
// D68's invariant is PATH-level: no CANONICAL SAVE may reach the network —
// outbound ARI must originate from the outbox and be delivered by the PM2
// worker, never from a request that writes a reservation. This action writes
// no reservation, changes no status and pushes no ARI: it performs one
// READ-ONLY GET /bookings to make Beds24 itself confirm the cancellation, then
// hands the release to the canonical targeted pull. It is a gate, not a save.
//
// check:calendar enforces D68 at FILE level (a hardcoded SAVE_PATHS list), so
// as long as this function sat inside actions.ts the guard read the whole file
// as a save path and went red — correctly, by its own rule. Separating the
// module keeps the guard sharp on the real save paths instead of teaching it an
// exception, which is what an exception list would have cost.
//
// THIS MODULE IS NOT A SAVE PATH AND MUST NEVER BECOME ONE. If a reservation
// write is ever needed here, it belongs in actions.ts — and the network call
// does not follow it there.
// ============================================================

const fail = (error: string): ActionResult<never> => ({ success: false, error });
function errorMessage(e: unknown): string {
  if (e instanceof AuthorizationError) return e.message;
  console.error("[channel-release]", e);
  return "אירעה שגיאה בלתי צפויה";
}

// ---------------------------------------------------------------
// supervised channel release (the escape hatch over the pull pipeline) — an
// operator-triggered release of an OTA reservation that is ALLOWED ONLY when
// Beds24 itself confirms the booking is cancelled. It never flips status by
// hand: it enqueues the worker's targeted pull job, so the release runs
// through the one canonical path (persisted cancelled revision →
// applyCancellation → inventory release → ARI push → realtime), with a full
// actor audit of WHO triggered it and WHAT the source reported.
// ---------------------------------------------------------------
export async function releaseChannelReservationAction(id: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.cancel");

    const [res] = await sql<
      {
        id: string; reservation_number: string; status: string;
        channel_connection_id: string | null; external_booking_id: string | null;
      }[]
    >`
      SELECT id, reservation_number, status, channel_connection_id, external_booking_id
      FROM guesthub.reservations
      WHERE id = ${id} AND tenant_id = ${actor.tenantId}`;
    if (!res) return fail("הזמנה לא נמצאה");
    if (!res.channel_connection_id || !res.external_booking_id)
      return fail("זו אינה הזמנת ערוץ — השתמש בביטול הרגיל");
    if (res.status === "cancelled") return { success: true };
    if (blocksAutomaticRelease(res.status))
      return fail("האורח בצ'ק-אין — שחרור אוטומטי חסום. יש לטפל בשהות (צ'ק-אאוט/החלטה ידנית) קודם");

    const [conn] = await sql<
      {
        id: string; api_key_ciphertext: string | null;
        access_token_ciphertext: string | null; access_token_expires_at: string | null;
      }[]
    >`
      SELECT id, api_key_ciphertext, access_token_ciphertext,
             access_token_expires_at::text AS access_token_expires_at
      FROM guesthub.channel_connections
      WHERE id = ${res.channel_connection_id} AND tenant_id = ${actor.tenantId}
        AND provider = 'beds24' AND is_active_provider = true`;
    if (!conn) return fail("חיבור הערוץ של ההזמנה אינו פעיל");

    // the gate: Beds24 must say cancelled, live, right now
    const access = await getBeds24AccessToken(sql, conn);
    if (!access.ok) return fail(access.error);
    const r = await beds24Request({
      token: access.token,
      baseUrl: beds24BaseUrl(),
      method: "GET",
      path: `/bookings?id=${encodeURIComponent(res.external_booking_id)}`,
    });
    if ("ok" in r) return fail(r.message);
    if (r.status !== 200) return fail("שגיאה בבדיקת סטטוס ההזמנה מול Beds24");
    const data = asObj(r.body)?.data ?? r.body;
    const source = (Array.isArray(data) ? data : [])
      .map((b) => beds24BookingIdentity(b))
      .find((b) => b.bookingId === res.external_booking_id);
    if (!source) return fail("ההזמנה לא נמצאה ב-Beds24 — שחרור מותר רק כשהמקור מאשר ביטול");
    const sourceStatus = source.rawStatus?.toLowerCase() ?? "unknown";
    if (sourceStatus !== "cancelled")
      return fail(`Beds24 עדיין מציג את ההזמנה במצב "${sourceStatus}" — שחרור מותר רק אחרי ביטול במקור`);

    // audited trigger + the canonical targeted pull (worker wakes instantly)
    await writeAudit(actor, {
      entityType: "reservation",
      entityId: res.id,
      action: "channel_release_trigger",
      before: { status: res.status },
      after: {
        booking_id: res.external_booking_id,
        source_status: sourceStatus,
        source_modified_time: source.modifiedTime,
      },
    });
    await enqueueChannelJob(sql, {
      tenantId: actor.tenantId,
      connectionId: conn.id,
      jobType: "pull_booking_revisions",
      priority: 10,
      payload: { booking_id: res.external_booking_id },
      idempotencyKey: `manual_release_${res.external_booking_id}`,
    });
    revalidatePath("/calendar");
    revalidatePath("/reservations");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
