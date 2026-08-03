"use server";

import { sql } from "@/lib/db";
import { getActor } from "@/lib/auth/actor";
import { requirePermission, AuthorizationError } from "@/lib/auth/permission-check";
import { todayInTz } from "@/lib/dates";
import {
  sourcesBreakdown,
  type SourceMetric,
  type SourcesBreakdown,
} from "@/lib/reports/sources-breakdown";
import { normalizeDashboardLayout, type DashboardPreferences } from "./windows";
import { periodSpan, type SourcesPeriod } from "./period";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// saveDashboardLayoutAction — the ONLY writer of users.ui_preferences.dashboard.
//
// THREE THINGS IT DELIBERATELY DOES NOT DO:
//
//  · It does not overwrite the column. `ui_preferences || jsonb_build_object(…)`
//    merges at the top level, so a second screen's key added later survives a
//    dashboard drag. Writing the whole column would silently delete it.
//
//  · It does not gate on a permission. /dashboard is the redirect target for
//    every other screen's authorization failure (audit §2.4); a permission
//    error here would bounce the operator to the screen that just rejected
//    them. Being signed in IS the authorization for arranging your own cards,
//    and the write is scoped to the caller's own row.
//
//  · It does not revalidate a path. The layout the browser is showing is
//    already the layout being saved — a revalidate would re-render the whole
//    dashboard on every drop for no visible change. The next full load reads
//    the new value; that is the only moment it matters.
//
// The payload is normalised through the SAME function the reader uses, so an
// invented id cannot reach the column and a stale client cannot drop a window
// by omitting it.
// ============================================================

export async function saveDashboardLayoutAction(input: unknown): Promise<ActionResult> {
  const actor = await getActor();
  if (!actor) return { success: false, error: "אין משתמש מחובר" };

  const prefs: DashboardPreferences = normalizeDashboardLayout(input);

  await sql`
    UPDATE guesthub.users
    SET ui_preferences = ui_preferences || jsonb_build_object('dashboard', ${sql.json(prefs as never)}::jsonb),
        updated_at = now()
    WHERE id = ${actor.userId} AND tenant_id = ${actor.tenantId}`;

  return { success: true };
}

// ============================================================
// sourcesBreakdownAction — the drawer's period/metric re-query.
//
// It calls the SAME sourcesBreakdown() the page already called for the src
// window. The drawer changing period must not become a second definition of the
// numbers; it is the same function over a different span.
//
// Read-only and tenant-scoped. Gated on reservations.view: the breakdown is
// commercial data about bookings, and that is the key that already governs
// seeing bookings.
// ============================================================
export async function sourcesBreakdownAction(
  period: SourcesPeriod,
  metric: SourceMetric,
): Promise<ActionResult<SourcesBreakdown>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.view");
    const [{ timezone }] = await sql<{ timezone: string | null }[]>`
      SELECT timezone FROM guesthub.tenants WHERE id = ${actor.tenantId}`;
    const today = todayInTz(timezone || "Asia/Jerusalem");
    const { from, to } = periodSpan(today, period);
    const data = await sourcesBreakdown(actor.tenantId, from, to, metric);
    return { success: true, data };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[dashboard/sources]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}
