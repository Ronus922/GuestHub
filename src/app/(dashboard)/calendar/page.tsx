import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { isDateOnly, todayInTz } from "@/lib/dates";
import { getCalendarData } from "./data";
import { getTenantVatRate } from "@/lib/settings";
import { CalendarScreen } from "./CalendarScreen";
import { VIEW_DAYS, type CalendarView } from "./types";

export const dynamic = "force-dynamic";

// /calendar — the production occupancy calendar (§D). URL-driven range:
// ?from=YYYY-MM-DD&view=week|3w|month, defaulting to a 3-week window
// starting today (property timezone).
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; view?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "calendar.view")) redirect("/dashboard");

  const params = await searchParams;
  const view: CalendarView =
    params.view === "week" || params.view === "month" ? params.view : "3w";
  const [tenant] = await sql<{ timezone: string }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${actor.tenantId}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");
  const from = params.from && isDateOnly(params.from) ? params.from : today;

  const data = await getCalendarData(actor, from, VIEW_DAYS[view]);
  // tenant VAT rate (Settings) — display-only in the booking/edit panels
  const vatRate = await getTenantVatRate(actor.tenantId);

  // lookups the calendar + panels need (colors/labels come from the DB, §4.5)
  const lookups = await sql<
    { category: string; key: string; label: string; color: string | null; id: string }[]
  >`
    SELECT id, category, key, label, color FROM guesthub.lookup_items
    WHERE tenant_id = ${actor.tenantId}
      AND category IN ('reservation_statuses', 'payment_methods', 'booking_sources')
      AND is_active
    ORDER BY category, sort_order`;

  return (
    <CalendarScreen
      data={data}
      view={view}
      statusItems={lookups.filter((l) => l.category === "reservation_statuses")}
      paymentMethods={lookups.filter((l) => l.category === "payment_methods")}
      bookingSources={lookups.filter((l) => l.category === "booking_sources")}
      can={{
        create: hasPermission(actor, "reservations.create"),
        edit: hasPermission(actor, "reservations.edit"),
        cancel: hasPermission(actor, "reservations.cancel"),
        close: hasPermission(actor, "rooms.edit"),
        viewReservation: hasPermission(actor, "reservations.view"),
        saveCard: hasPermission(actor, "payments.card_manage"),
        revealCard: hasPermission(actor, "payments.card_reveal"),
      }}
      vatRate={vatRate}
    />
  );
}
