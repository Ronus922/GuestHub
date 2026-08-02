import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { todayInTz, formatFullDate, HEBREW_DAY_LETTERS, dayOfWeek } from "@/lib/dates";
import { getDashboardPreferences } from "./preferences";
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

  const [tenant, units, prefs] = await Promise.all([
    sql<{ timezone: string }[]>`
      SELECT timezone FROM guesthub.tenants WHERE id = ${actor.tenantId}`,
    sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM guesthub.rooms
      WHERE tenant_id = ${actor.tenantId} AND is_active`,
    getDashboardPreferences(actor.userId, actor.tenantId),
  ]);

  // the property's day, not the server's — the session runs in UTC, so between
  // local midnight and ~03:00 a naive new Date() names yesterday
  const today = todayInTz(tenant[0]?.timezone || "Asia/Jerusalem");
  const count = units[0]?.c ?? 0;

  return (
    <DashboardScreen
      initial={prefs}
      todayLabel={`יום ${HEBREW_DAY_LETTERS[dayOfWeek(today)]} · ${formatFullDate(today)}`}
      unitLabel={`${count} יחידות`}
    />
  );
}
