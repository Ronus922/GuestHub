import "server-only";
import type { TransactionSql } from "postgres";
import type { CancellationTier } from "./cancellation";
import type { OtaCancellationTerms } from "@/lib/channel/booking-normalize";

// ============================================================
// Cancellation-policy SNAPSHOT (034). One canonical precedence model:
//
//   Settings templates (011)              = the editable library (the ONLY
//                                           place terms are defined/edited)
//   pricing_plans.cancellation_policy_id  = the assignment (a rate plan
//                                           REFERENCES one template — 012)
//   reservations.cancellation_policy_snapshot = an immutable COPY of the
//                                           terms that applied at booking
//
// Precedence when a reservation is CREATED:
//   1. imported OTA terms (channel bookings carry their own contract)
//   2. the selected rate plan's assigned template
//   3. the tenant's default template (cancellation_policies.is_default)
//   4. none → NULL (nothing is fabricated)
//
// Reservation views display ONLY the snapshot — a later edit to a Settings
// template never rewrites the terms of an existing reservation.
// ============================================================

export type { OtaCancellationTerms };

export type CancellationPolicySnapshot = {
  source: "rate_plan" | "property_default" | "ota";
  captured_at: string; // ISO timestamp
  /** template-based sources — a full copy, independent of the live template */
  policy?: {
    id: string;
    code: string;
    name: string;
    public_title: string;
    guest_description: string | null;
    tiers: CancellationTier[];
  };
  /** OTA source — imported terms, preserved verbatim */
  ota?: OtaCancellationTerms & { ota_name: string | null };
};

async function snapshotFromTemplate(
  tx: TransactionSql,
  tenantId: string,
  policyId: string,
  source: "rate_plan" | "property_default",
): Promise<CancellationPolicySnapshot | null> {
  const [policy] = await tx<
    { id: string; code: string; name: string; public_title: string; guest_description: string | null }[]
  >`
    SELECT id, code, name, public_title, guest_description
    FROM guesthub.cancellation_policies
    WHERE id = ${policyId} AND tenant_id = ${tenantId} AND NOT is_archived`;
  if (!policy) return null;
  const tiers = await tx<CancellationTier[]>`
    SELECT trigger_type, time_unit, time_from, time_to, fee_type,
           fee_amount::float8 AS fee_amount, fee_percent::float8 AS fee_percent,
           fee_nights, calc_base
    FROM guesthub.cancellation_policy_tiers
    WHERE policy_id = ${policy.id} AND tenant_id = ${tenantId}
    ORDER BY sort_order`;
  return {
    source,
    captured_at: new Date().toISOString(),
    policy: { ...policy, tiers },
  };
}

/**
 * Resolve the snapshot for a NEW reservation from templates:
 * rate-plan assignment first, tenant default second, NULL last.
 * (OTA terms take precedence over this — the import path checks them first.)
 */
export async function resolveCancellationSnapshot(
  tx: TransactionSql,
  tenantId: string,
  ratePlanId: string | null | undefined,
): Promise<CancellationPolicySnapshot | null> {
  if (ratePlanId) {
    const [plan] = await tx<{ cancellation_policy_id: string | null }[]>`
      SELECT cancellation_policy_id FROM guesthub.pricing_plans
      WHERE id = ${ratePlanId} AND tenant_id = ${tenantId}`;
    if (plan?.cancellation_policy_id) {
      const snap = await snapshotFromTemplate(tx, tenantId, plan.cancellation_policy_id, "rate_plan");
      if (snap) return snap;
    }
  }
  const [def] = await tx<{ id: string }[]>`
    SELECT id FROM guesthub.cancellation_policies
    WHERE tenant_id = ${tenantId} AND is_default AND is_active AND NOT is_archived
    LIMIT 1`;
  if (def) return snapshotFromTemplate(tx, tenantId, def.id, "property_default");
  return null;
}

/** Wrap imported OTA terms as a snapshot (the highest-precedence source). */
export function otaCancellationSnapshot(
  terms: OtaCancellationTerms,
  otaName: string | null,
): CancellationPolicySnapshot {
  return {
    source: "ota",
    captured_at: new Date().toISOString(),
    ota: { ...terms, ota_name: otaName },
  };
}
