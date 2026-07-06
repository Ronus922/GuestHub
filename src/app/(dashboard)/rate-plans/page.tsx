import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { listAssignableUnits, listRatePlans } from "@/lib/rate-plans/service";
import { listCancellationPolicies, listPaymentPolicies } from "@/lib/commercial/service";
import { RatePlansScreen } from "./RatePlansScreen";

export const dynamic = "force-dynamic";

export default async function RatePlansPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "rate_plans.view")) redirect("/dashboard");

  const [plans, units, cancellationPolicies, paymentPolicies] = await Promise.all([
    listRatePlans(actor.tenantId),
    listAssignableUnits(actor.tenantId),
    listCancellationPolicies(actor.tenantId),
    listPaymentPolicies(actor.tenantId),
  ]);

  return (
    <RatePlansScreen
      plans={plans}
      units={units}
      cancellationPolicies={cancellationPolicies.map((p) => ({ id: p.id, name: p.name, is_active: p.is_active }))}
      paymentPolicies={paymentPolicies.map((p) => ({ id: p.id, name: p.name, is_active: p.is_active }))}
      can={{
        create: hasPermission(actor, "rate_plans.create"),
        edit: hasPermission(actor, "rate_plans.edit"),
        del: hasPermission(actor, "rate_plans.delete"),
        simulate: hasPermission(actor, "pricing.simulate"),
      }}
    />
  );
}
