import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { todayInTz, formatFullDate, HEBREW_DAY_LETTERS, dayOfWeek } from "@/lib/dates";
import { getDashboardPreferences } from "./preferences";
import { getDashboardData } from "./data";
import { DashboardScreen } from "./DashboardScreen";

// The dashboard is live: SSE nudges router.refresh(), so the page must not be
// served from the full-route cache.
export const dynamic = "force-dynamic";

// NO PERMISSION GATE HERE, deliberately. /dashboard is the redirect target for
// every other screen's authorization failure (audit §2.4) — gating it would
// bounce an operator from the screen that rejected them straight into another
// rejection. `dashboard.view` gates the nav LINK; per-window gating arrives
// with the data in Phase 2, where there is finally something to gate.
export default async function DashboardPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");

  const [tenant, prefs] = await Promise.all([
    sql<{ timezone: string }[]>`
      SELECT timezone FROM guesthub.tenants WHERE id = ${actor.tenantId}`,
    getDashboardPreferences(actor.userId, actor.tenantId),
  ]);

  // the property's day, not the server's — the session runs in UTC, so between
  // local midnight and ~03:00 a naive new Date() names yesterday. THE one date
  // every window and every KPI below is computed against.
  const today = todayInTz(tenant[0]?.timezone || "Asia/Jerusalem");
  const data = await getDashboardData(actor.tenantId, today);

  return (
    <DashboardScreen
      initial={prefs}
      data={data}
      todayLabel={`יום ${HEBREW_DAY_LETTERS[dayOfWeek(today)]} · ${formatFullDate(today)}`}
      // the header's unit count is the SAME denominator the occupancy KPI
      // divides by, so the two can never tell the operator different numbers
      unitLabel={`${data.kpi.sellable} יחידות`}
    />
  );
}
