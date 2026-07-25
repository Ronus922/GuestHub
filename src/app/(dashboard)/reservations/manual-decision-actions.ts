"use server";

import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { loadManualDecisionView, type ManualDecisionView } from "@/lib/reservations/manual-decision";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// The read action behind the "נדרשת החלטת מפעיל" card in the reservation panel.
//
// WHY A SEPARATE FILE AND NOT A FIELD ON getReservationAction. The natural home
// for this is the detail payload itself — one round trip, one query plan. It is
// NOT there because `src/app/(dashboard)/reservations/actions.ts` is owned by
// the diff of `fix/beds24-checkin-cancellation-guard` (PR #112), and this branch
// is under an explicit no-touch rule for that file. Folding
// `getManualDecisionAction` into `getReservationAction` as
// `detail.manualDecision` is a mechanical follow-up once #112 has landed; the
// derivation and the card do not change when it happens, only where the data is
// fetched. Until then the panel pays one extra read on open — three indexed
// single-row lookups, all tenant-scoped.
//
// Permission: `reservations.view`. The payload carries no card data, no secret
// and no channel credential — a reservation status, a timestamp, room labels
// and stay dates the same viewer already sees in the panel.
// ============================================================

const fail = (error: string): ActionResult<never> => ({ success: false, error });

export async function getManualDecisionAction(
  reservationId: string,
): Promise<ActionResult<ManualDecisionView | null>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.view");
    const view = await loadManualDecisionView(sql, actor.tenantId, reservationId);
    return { success: true, data: view };
  } catch (e) {
    if (e instanceof AuthorizationError) return fail(e.message);
    console.error("[manual-decision]", e);
    return fail("אירעה שגיאה בלתי צפויה");
  }
}
