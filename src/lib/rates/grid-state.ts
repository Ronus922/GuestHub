import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { eachDay, type DateOnly } from "@/lib/dates";
import type {
  RateCellState,
  RateGridUnit,
  RateGridType,
  RateGridState,
} from "@/app/(dashboard)/rates/types";

export type {
  RateCellState,
  RateGridUnit,
  RateGridType,
  RateGridState,
} from "@/app/(dashboard)/rates/types";

// ============================================================
// Rate Grid read model (§0.4/§0.6). Assembles THE grid page state from the
// canonical sources — it writes nothing. Fuses three authoritative reads:
//   1. guesthub.effective_sell_state()      → derived price + availability + sellable
//   2. guesthub.sellable_unit_inventory()   → physical breakdown (total/occupied/closed)
//   3. raw guesthub.pricing_plan_rates      → EXPLICIT commercial values + hasRow
// The editable commercial fields come from the raw canonical rows; the derived
// (read-only) physical/sell fields come from the SQL read models — never mixed.
// The single write path stays src/lib/rates/service.ts::writeRateCells.
// ============================================================

type UnitMetaRow = {
  id: string;
  code: string;
  name: string;
  is_pooled: boolean;
  room_type_id: string | null;
  room_type_name: string | null;
  base_price: number;
  plan_id: string | null;
  room_count: number;
};

type PprRow = {
  pricing_plan_id: string;
  date: string;
  price: number | null;
  min_stay_through: number | null;
  min_stay_arrival: number | null;
  max_stay: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  stop_sell: boolean;
};

type EssRow = {
  sellable_unit_id: string;
  day: string;
  availability: number;
  price: number;
  sellable: boolean;
};

type InvRow = {
  sellable_unit_id: string;
  day: string;
  total_rooms: number;
  sellable_rooms: number;
  occupied_rooms: number;
  closed_rooms: number;
  availability: number;
};

const key = (a: string, b: string) => `${a}|${b}`;

// Read the full grid state for [from, toInclusive]. `toExclusive` is derived once
// for the half-open SQL functions. Works on a pool or a transaction (tests pass a tx).
export async function getRateGridState(
  db: Sql | TransactionSql,
  tenantId: string,
  from: DateOnly,
  toInclusive: DateOnly,
): Promise<RateGridState> {
  const dates = eachDay(from, addOneDay(toInclusive)); // inclusive → list of days
  const toExclusive = addOneDay(toInclusive);

  // 1. SU meta: base plan, base price (room-type fallback), member room count.
  const units = await db<UnitMetaRow[]>`
    SELECT su.id, su.code, su.name, su.is_pooled,
           su.room_type_id, rt.name AS room_type_name,
           COALESCE(rt.base_price, 0)::float8 AS base_price,
           bp.id AS plan_id,
           (SELECT count(*)::int FROM guesthub.sellable_unit_rooms sur
             WHERE sur.sellable_unit_id = su.id) AS room_count
    FROM guesthub.sellable_units su
    LEFT JOIN guesthub.room_types rt ON rt.id = su.room_type_id
    LEFT JOIN guesthub.pricing_plans bp
      ON bp.sellable_unit_id = su.id AND bp.is_base AND bp.is_active
    WHERE su.tenant_id = ${tenantId} AND su.is_active
    ORDER BY COALESCE(rt.base_price, 0), rt.name NULLS LAST, su.code`;

  // 2. Authoritative Effective Sell State (derived price + availability + sellable).
  const ess = await db<EssRow[]>`
    SELECT sellable_unit_id, day::text AS day, availability,
           price::float8 AS price, sellable
    FROM guesthub.effective_sell_state(${tenantId}, ${from}, ${toExclusive})`;
  const essByKey = new Map(ess.map((r) => [key(r.sellable_unit_id, r.day), r]));

  // 3. Physical breakdown per SU/day (total/occupied/closed).
  const inv = await db<InvRow[]>`
    SELECT sellable_unit_id, day::text AS day, total_rooms, sellable_rooms,
           occupied_rooms, closed_rooms, availability
    FROM guesthub.sellable_unit_inventory(${tenantId}, ${from}, ${toExclusive})`;
  const invByKey = new Map(inv.map((r) => [key(r.sellable_unit_id, r.day), r]));

  // 4. Raw canonical rows → EXPLICIT editable values + hasRow, keyed by plan/date.
  const planIds = units.map((u) => u.plan_id).filter((x): x is string => !!x);
  const ppr = planIds.length
    ? await db<PprRow[]>`
        SELECT pricing_plan_id, date::text AS date, price::float8 AS price,
               min_stay_through, min_stay_arrival, max_stay,
               closed_to_arrival, closed_to_departure, stop_sell
        FROM guesthub.pricing_plan_rates
        WHERE tenant_id = ${tenantId}
          AND pricing_plan_id = ANY(${planIds}::uuid[])
          AND date >= ${from} AND date <= ${toInclusive}`
    : [];
  const pprByKey = new Map(ppr.map((r) => [key(r.pricing_plan_id, r.date), r]));

  const gridUnits: RateGridUnit[] = units.map((u) => {
    const cells: RateCellState[] = dates.map((d) => {
      const e = essByKey.get(key(u.id, d));
      const iv = invByKey.get(key(u.id, d));
      const row = u.plan_id ? pprByKey.get(key(u.plan_id, d)) : undefined;

      const explicitPrice = row?.price ?? null;
      const effectivePrice = e ? e.price : explicitPrice ?? u.base_price;
      return {
        date: d,
        price: explicitPrice,
        minStayThrough: row?.min_stay_through ?? null,
        minStayArrival: row?.min_stay_arrival ?? null,
        maxStay: row?.max_stay ?? null,
        closedToArrival: row?.closed_to_arrival ?? false,
        closedToDeparture: row?.closed_to_departure ?? false,
        stopSell: row?.stop_sell ?? false,
        hasRow: !!row,
        effectivePrice,
        priceSource: explicitPrice != null ? "explicit" : "inherited",
        totalRooms: iv?.total_rooms ?? u.room_count,
        sellableRooms: iv?.sellable_rooms ?? 0,
        occupiedRooms: iv?.occupied_rooms ?? 0,
        closedRooms: iv?.closed_rooms ?? 0,
        availability: iv?.availability ?? e?.availability ?? 0,
        sellable: e ? e.sellable : false,
      };
    });
    return {
      sellableUnitId: u.id,
      pricingPlanId: u.plan_id,
      code: u.code,
      name: u.name,
      isPooled: u.is_pooled,
      roomCount: u.room_count,
      roomTypeId: u.room_type_id,
      roomTypeName: u.room_type_name,
      basePrice: u.base_price,
      hasBasePlan: !!u.plan_id,
      closedCount: cells.reduce((n, c) => n + (c.stopSell ? 1 : 0), 0),
      cells,
    };
  });

  // Group into room-type bands (matching the reference), keeping SU order.
  const types: RateGridType[] = [];
  const byType = new Map<string, RateGridType>();
  for (const gu of gridUnits) {
    const tk = gu.roomTypeId ?? "—";
    let band = byType.get(tk);
    if (!band) {
      band = {
        roomTypeId: gu.roomTypeId,
        roomTypeName: gu.roomTypeName ?? "ללא סוג",
        basePrice: gu.basePrice,
        unitIds: [],
        units: [],
      };
      byType.set(tk, band);
      types.push(band);
    }
    band.units.push(gu);
    band.unitIds.push(gu.sellableUnitId);
  }

  return {
    from,
    toInclusive,
    dates,
    types,
    unitCount: gridUnits.length,
    typeCount: types.length,
  };
}

// Local inclusive→exclusive helper (avoids importing addDays under a different name).
function addOneDay(d: DateOnly): DateOnly {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
