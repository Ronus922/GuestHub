import "server-only";
import type { TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import { addDays } from "@/lib/dates";
import { markAriDirty } from "@/lib/channel/outbox";

// ============================================================
// Canonical commercial-write service (§0.2/§0.4). The ONE path through which
// the Rate Grid (single cell) and Group Update (batch) write commercial ARI —
// both call writeRateCells, so they can never maintain separate stores. Writes
// guesthub.pricing_plan_rates and marks the SAME outbox (rates + restrictions)
// in the caller's transaction. The occupancy calendar never calls this.
// ============================================================

// Only the provided fields are touched; an omitted field keeps its stored value
// (or the column default on a freshly-created row). This is what makes an empty
// Group-Update stepper mean "don't touch this field" (§7b).
export type RateCellPatch = {
  price?: number | null;
  min_stay_through?: number | null;
  min_stay_arrival?: number | null;
  max_stay?: number | null;
  closed_to_arrival?: boolean;
  closed_to_departure?: boolean;
  stop_sell?: boolean;
};

export type RateCell = {
  sellableUnitId: string;
  pricingPlanId: string;
  date: DateOnly;
  patch: RateCellPatch;
};

// One resolved change, for audit / bulk_rate_update_items (old → new price).
export type RateChange = {
  sellableUnitId: string;
  pricingPlanId: string;
  roomTypeId: string | null;
  date: DateOnly;
  oldPrice: number | null;
  newPrice: number | null;
};

type FullRow = {
  price: number | null;
  min_stay_through: number | null;
  min_stay_arrival: number | null;
  max_stay: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  stop_sell: boolean;
};

const EMPTY_ROW: FullRow = {
  price: null,
  min_stay_through: null,
  min_stay_arrival: null,
  max_stay: null,
  closed_to_arrival: false,
  closed_to_departure: false,
  stop_sell: false,
};

// Merge a patch over an existing/blank row — undefined keys are left untouched.
function merge(base: FullRow, patch: RateCellPatch): FullRow {
  return {
    price: patch.price !== undefined ? patch.price : base.price,
    min_stay_through: patch.min_stay_through !== undefined ? patch.min_stay_through : base.min_stay_through,
    min_stay_arrival: patch.min_stay_arrival !== undefined ? patch.min_stay_arrival : base.min_stay_arrival,
    max_stay: patch.max_stay !== undefined ? patch.max_stay : base.max_stay,
    closed_to_arrival: patch.closed_to_arrival !== undefined ? patch.closed_to_arrival : base.closed_to_arrival,
    closed_to_departure: patch.closed_to_departure !== undefined ? patch.closed_to_departure : base.closed_to_departure,
    stop_sell: patch.stop_sell !== undefined ? patch.stop_sell : base.stop_sell,
  };
}

// THE commercial write. Runs inside the caller's tx. Validates every plan is
// this tenant's plan for the claimed SU (trust boundary), upserts one canonical
// row per (plan, date), and marks the outbox (rates + restrictions) over the
// touched room-types/date-span. Returns the old→new changes for audit.
export async function writeRateCells(
  tx: TransactionSql,
  tenantId: string,
  cells: RateCell[],
): Promise<RateChange[]> {
  if (cells.length === 0) return [];

  const planIds = [...new Set(cells.map((c) => c.pricingPlanId))];
  const plans = await tx<
    { id: string; sellable_unit_id: string; room_type_id: string | null }[]
  >`
    SELECT p.id, p.sellable_unit_id, su.room_type_id
    FROM guesthub.pricing_plans p
    JOIN guesthub.sellable_units su ON su.id = p.sellable_unit_id
    WHERE p.tenant_id = ${tenantId} AND p.id = ANY(${planIds}::uuid[])`;
  const planMeta = new Map(plans.map((p) => [p.id, p]));
  for (const c of cells) {
    const meta = planMeta.get(c.pricingPlanId);
    if (!meta || meta.sellable_unit_id !== c.sellableUnitId) {
      throw new Error("תוכנית תמחור לא נמצאה ליחידה");
    }
  }

  // existing rows for the exact (plan, date) targets → old values + merge base.
  // FOR UPDATE serializes concurrent writers to the same cell so the
  // read-modify-write can't clobber a field this call omits (ponytail: locks the
  // update path; two concurrent INSERTs of a brand-new cell still race on
  // last-writer-wins, acceptable for the low-contention grid).
  const existing = await tx<
    ({ pricing_plan_id: string; date: string } & FullRow)[]
  >`
    SELECT pricing_plan_id, date::text AS date, price::float8 AS price,
           min_stay_through, min_stay_arrival, max_stay,
           closed_to_arrival, closed_to_departure, stop_sell
    FROM guesthub.pricing_plan_rates
    WHERE tenant_id = ${tenantId}
      AND pricing_plan_id = ANY(${planIds}::uuid[])
      AND date = ANY(${cells.map((c) => c.date)}::date[])
    FOR UPDATE`;
  const key = (plan: string, date: string) => `${plan}|${date}`;
  const oldByKey = new Map(existing.map((r) => [key(r.pricing_plan_id, r.date), r]));

  const rows: (FullRow & { tenant_id: string; sellable_unit_id: string; pricing_plan_id: string; date: string })[] = [];
  const changes: RateChange[] = [];
  for (const c of cells) {
    const meta = planMeta.get(c.pricingPlanId)!;
    const old = oldByKey.get(key(c.pricingPlanId, c.date));
    const base: FullRow = old ? { ...old } : { ...EMPTY_ROW };
    const next = merge(base, c.patch);
    rows.push({
      tenant_id: tenantId,
      sellable_unit_id: c.sellableUnitId,
      pricing_plan_id: c.pricingPlanId,
      date: c.date,
      ...next,
    });
    changes.push({
      sellableUnitId: c.sellableUnitId,
      pricingPlanId: c.pricingPlanId,
      roomTypeId: meta.room_type_id,
      date: c.date,
      oldPrice: old ? old.price : null,
      newPrice: next.price,
    });
  }

  await tx`
    INSERT INTO guesthub.pricing_plan_rates ${tx(
      rows,
      "tenant_id", "sellable_unit_id", "pricing_plan_id", "date", "price",
      "min_stay_through", "min_stay_arrival", "max_stay",
      "closed_to_arrival", "closed_to_departure", "stop_sell",
    )}
    ON CONFLICT (pricing_plan_id, date) DO UPDATE SET
      price = EXCLUDED.price,
      min_stay_through = EXCLUDED.min_stay_through,
      min_stay_arrival = EXCLUDED.min_stay_arrival,
      max_stay = EXCLUDED.max_stay,
      closed_to_arrival = EXCLUDED.closed_to_arrival,
      closed_to_departure = EXCLUDED.closed_to_departure,
      stop_sell = EXCLUDED.stop_sell`;

  // mark the outbox: rates + restrictions, per touched room-type, over the span.
  // markAriDirty is a no-op unless an active outbound connection exists.
  const dates = cells.map((c) => c.date).sort();
  const dateFrom = dates[0];
  const dateTo = addDays(dates[dates.length - 1], 1); // exclusive
  const roomTypeIds = [...new Set(plans.map((p) => p.room_type_id))];
  await markAriDirty(tx, {
    tenantId,
    roomTypeIds,
    dateFrom,
    dateTo,
    kinds: ["rates", "restrictions"],
  });

  return changes;
}
