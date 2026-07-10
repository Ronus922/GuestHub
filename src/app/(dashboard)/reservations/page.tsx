import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { isDateOnly } from "@/lib/dates";
import { listBookableRatePlans } from "@/lib/rate-plans/service";
import { getTenantVatRate } from "@/lib/settings";
import { getReservationsList, type ListFilters, type ListTab, type QuickFilter } from "./data";
import { ReservationsScreen } from "./ReservationsScreen";

export const dynamic = "force-dynamic";

// /reservations — הזמנות (D77 §17/§18). URL-driven filters: every control
// writes searchParams and this force-dynamic page re-queries, so the realtime
// router.refresh() keeps rows + tab counts live without a client data path.

const TAB_KEYS: ListTab[] = ["all", "confirmed", "inhouse", "out", "cancelled", "noshow"];
const QUICK_KEYS: QuickFilter[] = [
  "created24", "cancelled24", "pending", "unpaid", "partial", "inhouse",
  "arrivals", "arrivals24", "departures", "missing_docs", "invalid_card",
  "cancelled_today", "noshow_candidates",
];

// uuid-typed params are validated HERE — a mistyped/malicious filter link
// must fall back to "no filter", never crash the page with a 22P02
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | undefined) => (v && UUID_RE.test(v) ? v : null);
const ORIGIN_RE = /^[a-z_]{1,40}$/;

function parseFilters(p: Record<string, string | undefined>): ListFilters {
  return {
    tab: TAB_KEYS.includes(p.tab as ListTab) ? (p.tab as ListTab) : "all",
    q: (p.q ?? "").slice(0, 120),
    dateType:
      p.dtype === "checkout" || p.dtype === "created" ? p.dtype : "checkin",
    from: p.from && isDateOnly(p.from) ? p.from : null,
    to: p.to && isDateOnly(p.to) ? p.to : null,
    sourceId: uuidOrNull(p.source),
    workflowId: uuidOrNull(p.wf),
    payment:
      p.pay === "unpaid" || p.pay === "partial" || p.pay === "paid" ? p.pay : null,
    roomId: uuidOrNull(p.room),
    cancellationOrigin: p.corigin && ORIGIN_RE.test(p.corigin) ? p.corigin : null,
    quick: QUICK_KEYS.includes(p.quick as QuickFilter) ? (p.quick as QuickFilter) : null,
  };
}

export default async function ReservationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "reservations.view")) redirect("/dashboard");

  const filters = parseFilters(await searchParams);

  const [data, lookups, ratePlans, vatRate, rooms] = await Promise.all([
    getReservationsList(actor, filters),
    sql<{ category: string; key: string; label: string; color: string | null; id: string }[]>`
      SELECT id, category, key, label, color FROM guesthub.lookup_items
      WHERE tenant_id = ${actor.tenantId}
        AND category IN ('reservation_statuses', 'payment_methods', 'booking_sources',
                         'workflow_statuses')
        AND is_active
      ORDER BY category, sort_order`,
    listBookableRatePlans(actor.tenantId),
    getTenantVatRate(actor.tenantId),
    sql<{ id: string; room_number: string }[]>`
      SELECT id, room_number FROM guesthub.rooms
      WHERE tenant_id = ${actor.tenantId} AND is_active
      ORDER BY room_number`,
  ]);

  return (
    <ReservationsScreen
      data={data}
      filters={filters}
      bookingSources={lookups.filter((l) => l.category === "booking_sources")}
      paymentMethods={lookups.filter((l) => l.category === "payment_methods")}
      workflowStatuses={lookups.filter((l) => l.category === "workflow_statuses")}
      statusItems={lookups.filter((l) => l.category === "reservation_statuses")}
      ratePlans={ratePlans}
      rooms={rooms}
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
