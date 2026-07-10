import { redirect } from "next/navigation";
import { getActor, hasPermission, toActorContext } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { getTenantVatRate } from "@/lib/settings";
import { listBookableRatePlans } from "@/lib/rate-plans/service";
import { getBusinessProfile } from "@/lib/business/store";
import { formatPropertyIdentity, IDENTITY_NOT_SET } from "@/lib/business/profile";
import { Shell } from "@/components/layout/Shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  // Cleaners get the dedicated mobile task screen, no shell.
  if (actor.roleKey === "cleaner") redirect("/housekeeping/my-tasks");

  // Data the global new-reservation panel (D48 — sidebar button, available on
  // every dashboard page) needs. Fetched once here so the shared BookingPanel
  // mounted in the Shell works regardless of the current route.
  const [vatRate, lookups, ratePlans, profile] = await Promise.all([
    getTenantVatRate(actor.tenantId),
    sql<{ category: string; key: string; label: string; color: string | null; id: string }[]>`
      SELECT id, category, key, label, color FROM guesthub.lookup_items
      WHERE tenant_id = ${actor.tenantId}
        AND category IN ('payment_methods', 'booking_sources', 'workflow_statuses')
        AND is_active
      ORDER BY category, sort_order`,
    listBookableRatePlans(actor.tenantId),
    // Sidebar account card, second line. Tenant-scoped read through the canonical
    // D61 accessor; only the formatted string crosses to the client.
    getBusinessProfile(actor.tenantId),
  ]);

  return (
    <Shell
      actor={toActorContext(actor)}
      propertyIdentity={profile ? formatPropertyIdentity(profile) : IDENTITY_NOT_SET}
      newReservation={{
        bookingSources: lookups.filter((l) => l.category === "booking_sources"),
        paymentMethods: lookups.filter((l) => l.category === "payment_methods"),
        workflowStatuses: lookups.filter((l) => l.category === "workflow_statuses"),
        ratePlans,
        vatRate,
        canSaveCard: hasPermission(actor, "payments.card_manage"),
        canPriceOverride: hasPermission(actor, "reservations.price_override"),
        canCreate: hasPermission(actor, "reservations.create"),
      }}
    >
      {children}
    </Shell>
  );
}
