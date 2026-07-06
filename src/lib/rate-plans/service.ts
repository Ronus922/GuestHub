import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { planFormulaLabel, type PlanKind } from "@/lib/pricing/resolve";

// ============================================================
// Rate Plans read layer. Tenant-level plans only (sellable_unit_id IS NULL) —
// the SU-scoped base plans stay the Rates-grid base layer and are not managed
// here. Every query is tenant-scoped by the caller's actor.tenantId.
// ============================================================

export type RatePlanListItem = {
  id: string;
  code: string;
  name: string;
  public_name: string | null;
  plan_kind: PlanKind;
  parent_plan_id: string | null;
  parent_name: string | null;
  adjustment_value: number | null;
  is_active: boolean;
  is_archived: boolean;
  is_refundable: boolean;
  meal_plan: string | null;
  cancellation_policy_id: string | null;
  cancellation_policy_name: string | null;
  valid_from: string | null;
  valid_until: string | null;
  min_advance_days: number | null;
  max_advance_days: number | null;
  allowed_checkin_days: number[] | null;
  default_min_stay: number | null;
  default_max_stay: number | null;
  default_closed_to_arrival: boolean;
  default_closed_to_departure: boolean;
  is_visible_website: boolean;
  is_visible_channels: boolean;
  sort_order: number;
  assigned_units: number;
  active_assigned_units: number;
  override_rows: number;
  independent_price_rows: number;
  formula: string;
  incomplete: string[]; // Hebrew completeness flags
};

export async function listRatePlans(
  tenantId: string,
  db: Sql | TransactionSql = sql,
): Promise<RatePlanListItem[]> {
  const rows = await db<(Omit<RatePlanListItem, "formula" | "incomplete"> & { parent_active: boolean | null })[]>`
    SELECT p.id, p.code, p.name, p.public_name, p.plan_kind, p.parent_plan_id,
           pp.name AS parent_name,
           (pp.is_active AND NOT pp.is_archived) AS parent_active,
           p.adjustment_value::float8 AS adjustment_value,
           p.is_active, p.is_archived, p.is_refundable, p.meal_plan,
           p.cancellation_policy_id, cp.name AS cancellation_policy_name,
           p.valid_from::text AS valid_from, p.valid_until::text AS valid_until,
           p.min_advance_days, p.max_advance_days, p.allowed_checkin_days,
           p.default_min_stay, p.default_max_stay,
           p.default_closed_to_arrival, p.default_closed_to_departure,
           p.is_visible_website, p.is_visible_channels, p.sort_order,
           (SELECT count(*)::int FROM guesthub.pricing_plan_units u
             WHERE u.pricing_plan_id = p.id) AS assigned_units,
           (SELECT count(*)::int FROM guesthub.pricing_plan_units u
             WHERE u.pricing_plan_id = p.id AND u.is_active) AS active_assigned_units,
           (SELECT count(*)::int FROM guesthub.pricing_plan_unit_rates r
             WHERE r.pricing_plan_id = p.id) AS override_rows,
           (SELECT count(*)::int FROM guesthub.pricing_plan_unit_rates r
             WHERE r.pricing_plan_id = p.id AND r.price IS NOT NULL) AS independent_price_rows
    FROM guesthub.pricing_plans p
    LEFT JOIN guesthub.pricing_plans pp ON pp.id = p.parent_plan_id
    LEFT JOIN guesthub.cancellation_policies cp
      ON cp.id = p.cancellation_policy_id AND cp.tenant_id = p.tenant_id
    WHERE p.tenant_id = ${tenantId} AND p.sellable_unit_id IS NULL
    ORDER BY p.is_archived, p.sort_order, p.name`;

  return rows.map((r) => {
    const incomplete: string[] = [];
    if (r.active_assigned_units === 0 && !r.is_archived) incomplete.push("לא משויכת לאף חדר");
    if (r.plan_kind === "independent" && r.independent_price_rows === 0)
      incomplete.push("תוכנית עצמאית ללא מחירים");
    if ((r.plan_kind === "derived_percentage" || r.plan_kind === "derived_fixed") && r.parent_active === false)
      incomplete.push("תוכנית האב אינה פעילה");
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { parent_active: _pa, ...rest } = r;
    return {
      ...rest,
      formula: planFormulaLabel(
        { planKind: r.plan_kind, adjustmentValue: r.adjustment_value },
        r.parent_name,
      ),
      incomplete,
    };
  });
}

export type PlanAssignmentRow = {
  sellable_unit_id: string;
  is_active: boolean;
  adjustment_value: number | null;
  valid_from: string | null;
  valid_until: string | null;
};

export type RatePlanDetail = RatePlanListItem & {
  description: string | null;
  public_description: string | null;
  payment_policy_id: string | null;
  assignments: PlanAssignmentRow[];
};

export async function getRatePlanDetail(
  tenantId: string,
  planId: string,
  db: Sql | TransactionSql = sql,
): Promise<RatePlanDetail | null> {
  const plans = await listRatePlans(tenantId, db);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return null;
  const [extra] = await db<{ description: string | null; public_description: string | null; payment_policy_id: string | null }[]>`
    SELECT description, public_description, payment_policy_id
    FROM guesthub.pricing_plans WHERE id = ${planId} AND tenant_id = ${tenantId}`;
  const assignments = await db<PlanAssignmentRow[]>`
    SELECT sellable_unit_id, is_active, adjustment_value::float8 AS adjustment_value,
           valid_from::text AS valid_from, valid_until::text AS valid_until
    FROM guesthub.pricing_plan_units
    WHERE tenant_id = ${tenantId} AND pricing_plan_id = ${planId}`;
  return { ...plan, ...(extra ?? { description: null, public_description: null, payment_policy_id: null }), assignments };
}

// The assignable-unit list for Step 3 + the simulator: every sellable unit with
// its (1:1 today) member room, status, and how many tenant plans cover it — the
// "rooms with no active Rate Plan" indicator comes from active_plan_count = 0.
export type AssignableUnit = {
  sellable_unit_id: string;
  unit_name: string;
  unit_active: boolean;
  room_id: string | null;
  room_number: string | null;
  room_name: string | null;
  room_type_name: string | null;
  room_status: string | null;
  room_active: boolean | null;
  active_plan_count: number;
};

export async function listAssignableUnits(
  tenantId: string,
  db: Sql | TransactionSql = sql,
): Promise<AssignableUnit[]> {
  return db<AssignableUnit[]>`
    SELECT su.id AS sellable_unit_id, su.name AS unit_name, su.is_active AS unit_active,
           r.id AS room_id, r.room_number, r.name AS room_name,
           rt.name AS room_type_name, r.status AS room_status, r.is_active AS room_active,
           (SELECT count(*)::int FROM guesthub.pricing_plan_units u
             JOIN guesthub.pricing_plans p ON p.id = u.pricing_plan_id
             WHERE u.sellable_unit_id = su.id AND u.is_active
               AND p.is_active AND NOT p.is_archived) AS active_plan_count
    FROM guesthub.sellable_units su
    LEFT JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
    LEFT JOIN guesthub.rooms r ON r.id = sur.room_id
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    WHERE su.tenant_id = ${tenantId}
    ORDER BY r.room_number NULLS LAST, su.name`;
}

// Exact-date overlay rows for one plan (sparse; the plan overlay editor reads
// these — the base Rates grid stays the base layer and is NOT duplicated here).
export type PlanOverrideRow = {
  sellable_unit_id: string;
  date: string;
  price: number | null;
  min_stay_through: number | null;
  min_stay_arrival: number | null;
  max_stay: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  stop_sell: boolean;
  note: string | null;
};

export async function listPlanOverrides(
  tenantId: string,
  planId: string,
  db: Sql | TransactionSql = sql,
): Promise<PlanOverrideRow[]> {
  return db<PlanOverrideRow[]>`
    SELECT sellable_unit_id, date::text AS date, price::float8 AS price,
           min_stay_through, min_stay_arrival, max_stay,
           closed_to_arrival, closed_to_departure, stop_sell, note
    FROM guesthub.pricing_plan_unit_rates
    WHERE tenant_id = ${tenantId} AND pricing_plan_id = ${planId}
    ORDER BY date, sellable_unit_id`;
}
