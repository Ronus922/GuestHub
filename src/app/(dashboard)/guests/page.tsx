import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { listBookableRatePlans } from "@/lib/rate-plans/service";
import { getTenantVatRate } from "@/lib/settings";
import { getGuestsList } from "./data";
import { GuestsScreen } from "./GuestsScreen";

export const dynamic = "force-dynamic";

// /guests — אורחים (D77 §19): the canonical guests table with per-guest
// reservation/payment aggregates. Search is URL-driven (?q=), so the realtime
// router.refresh() keeps the list live.
export default async function GuestsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "guests.view")) redirect("/dashboard");

  const { q = "" } = await searchParams;

  const [data, lookups, ratePlans, vatRate] = await Promise.all([
    getGuestsList(actor, q.slice(0, 120)),
    sql<{ category: string; key: string; label: string; color: string | null; id: string }[]>`
      SELECT id, category, key, label, color FROM guesthub.lookup_items
      WHERE tenant_id = ${actor.tenantId}
        AND category IN ('reservation_statuses', 'payment_methods', 'booking_sources',
                         'workflow_statuses')
        AND is_active
      ORDER BY category, sort_order`,
    listBookableRatePlans(actor.tenantId),
    getTenantVatRate(actor.tenantId),
  ]);

  return (
    <GuestsScreen
      data={data}
      q={q}
      bookingSources={lookups.filter((l) => l.category === "booking_sources")}
      paymentMethods={lookups.filter((l) => l.category === "payment_methods")}
      workflowStatuses={lookups.filter((l) => l.category === "workflow_statuses")}
      statusItems={lookups.filter((l) => l.category === "reservation_statuses")}
      ratePlans={ratePlans}
      can={{
        edit: hasPermission(actor, "reservations.edit"),
        cancel: hasPermission(actor, "reservations.cancel"),
        viewReservation: hasPermission(actor, "reservations.view"),
        saveCard: hasPermission(actor, "payments.card_manage"),
        revealCard: hasPermission(actor, "payments.card_reveal"),
        chargeCard: hasPermission(actor, "payments.card_charge"),
      }}
      vatRate={vatRate}
    />
  );
}
