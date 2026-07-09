import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { getTenantVatRate, getTenantCurrency } from "@/lib/settings";
import {
  getExtraGuestDefaults,
  listCancellationPolicies,
  listPaymentPolicies,
  getPaymentMethods,
} from "@/lib/commercial/service";
import { SettingsShell } from "./SettingsShell";
import { getMessagingSettingsAction } from "./messaging-actions";
import { getBusinessProfileContextAction, type BusinessProfileContext } from "./business-actions";
import type { MessagingSettingsView } from "./types";

export const dynamic = "force-dynamic";

// /settings — tenant business + commercial settings. Gated by settings.edit, the
// same permission every mutating Server Action enforces. Data is loaded here and
// passed to the client shell.
export default async function SettingsPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "settings.edit")) redirect("/dashboard");

  const [currency, vatRate, extraGuest, cancellationPolicies, paymentPolicies, paymentMethods, businessCtx] =
    await Promise.all([
      getTenantCurrency(actor.tenantId),
      getTenantVatRate(actor.tenantId),
      getExtraGuestDefaults(actor.tenantId),
      listCancellationPolicies(actor.tenantId),
      listPaymentPolicies(actor.tenantId),
      getPaymentMethods(actor.tenantId),
      getBusinessProfileContextAction(),
    ]);
  const businessProfile: BusinessProfileContext | null =
    businessCtx.success && businessCtx.data ? businessCtx.data : null;

  // Messaging providers are super_admin-only integration secrets (§ guards).
  const canManageMessaging = actor.roleKey === "super_admin";
  let messaging: MessagingSettingsView | null = null;
  if (canManageMessaging) {
    const res = await getMessagingSettingsAction();
    if (res.success && res.data) messaging = res.data;
  }

  return (
    <SettingsShell
      tenantName={actor.tenantName}
      businessProfile={businessProfile}
      currency={currency}
      vatRate={vatRate}
      extraGuest={extraGuest}
      cancellationPolicies={cancellationPolicies}
      paymentPolicies={paymentPolicies}
      paymentMethods={paymentMethods}
      canManageMessaging={canManageMessaging}
      messaging={messaging}
    />
  );
}
