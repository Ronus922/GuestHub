import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { addDays, isDateOnly, todayInTz } from "@/lib/dates";
import { getRateGridState } from "@/lib/rates/grid-state";
import { RateGridScreen } from "./RateGridScreen";
import { RATE_VIEW_DAYS, type RateView } from "./types";

export const dynamic = "force-dynamic";

// /rates — the Rate Grid (Synchronization Table). Sellable Units × dates over the
// canonical commercial state (pricing_plan_rates) fused with Effective Sell State.
// URL-driven window: ?from=YYYY-MM-DD&view=2w|month (default: month from today).
export default async function RatesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; view?: string; panel?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "rates.view")) redirect("/dashboard");

  const params = await searchParams;
  const view: RateView = params.view === "2w" ? "2w" : "month";
  const [tenant] = await sql<{ timezone: string }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${actor.tenantId}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");
  const from = params.from && isDateOnly(params.from) ? params.from : today;
  const toInclusive = addDays(from, RATE_VIEW_DAYS[view] - 1);

  const state = await getRateGridState(sql, actor.tenantId, from, toInclusive);

  return (
    <RateGridScreen
      state={state}
      view={view}
      today={today}
      can={{
        edit: hasPermission(actor, "rates.edit"),
        bulk: hasPermission(actor, "rates.bulk_update"),
      }}
    />
  );
}
