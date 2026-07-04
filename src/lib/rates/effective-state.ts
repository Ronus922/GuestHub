import "server-only";
import type { Sql, TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import type { PlanRateRow } from "./rules";

// ============================================================
// Effective Sell State — server/DB read half (§0.4/§0.6). Maps physical rooms
// to their Sellable Unit + base pricing plan and loads the canonical commercial
// rows (guesthub.pricing_plan_rates). This is the ONLY rate source the booking
// engine, quotes, and reservation snapshots read — legacy guesthub.rates is
// retired. Pure pricing/restriction logic lives in ./rules.
// ============================================================

// A room resolved to its Sellable Unit + base plan, with the canonical rows for
// a stay window. rows is empty when the SU has no base plan yet (price falls
// back to basePrice everywhere — never throws).
export type RoomPlanRates = {
  roomId: string;
  sellableUnitId: string | null;
  pricingPlanId: string | null;
  roomTypeId: string | null;
  basePrice: number;
  rows: PlanRateRow[];
};

type PlanRateDbRow = PlanRateRow & { pricing_plan_id: string };

// Batch loader: room ids → their base-plan canonical rows within
// [from, toInclusive]. One query for the room→SU→plan meta, one for the rows.
export async function getRoomPlanRates(
  db: Sql | TransactionSql,
  tenantId: string,
  roomIds: string[],
  from: DateOnly,
  toInclusive: DateOnly,
): Promise<Map<string, RoomPlanRates>> {
  const unique = [...new Set(roomIds)];
  const out = new Map<string, RoomPlanRates>();
  if (unique.length === 0) return out;

  const meta = await db<
    {
      room_id: string;
      su_id: string | null;
      plan_id: string | null;
      room_type_id: string | null;
      base_price: number;
    }[]
  >`
    SELECT r.id AS room_id, sur.sellable_unit_id AS su_id, bp.id AS plan_id,
           r.room_type_id, COALESCE(rt.base_price, 0)::float8 AS base_price
    FROM guesthub.rooms r
    LEFT JOIN guesthub.sellable_unit_rooms sur ON sur.room_id = r.id
    LEFT JOIN guesthub.pricing_plans bp
      ON bp.sellable_unit_id = sur.sellable_unit_id AND bp.is_base AND bp.is_active
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    WHERE r.tenant_id = ${tenantId} AND r.id = ANY(${unique}::uuid[])`;

  const planIds = [...new Set(meta.map((m) => m.plan_id).filter((x): x is string => !!x))];
  const rateRows = planIds.length
    ? await db<PlanRateDbRow[]>`
        SELECT pricing_plan_id, date::text AS date, price::float8 AS price,
               min_stay_through, min_stay_arrival, max_stay,
               closed_to_arrival, closed_to_departure, stop_sell
        FROM guesthub.pricing_plan_rates
        WHERE tenant_id = ${tenantId}
          AND pricing_plan_id = ANY(${planIds}::uuid[])
          AND date >= ${from} AND date <= ${toInclusive}`
    : [];

  const byPlan = new Map<string, PlanRateRow[]>();
  for (const r of rateRows) {
    const { pricing_plan_id, ...row } = r;
    const arr = byPlan.get(pricing_plan_id);
    if (arr) arr.push(row);
    else byPlan.set(pricing_plan_id, [row]);
  }

  for (const m of meta) {
    out.set(m.room_id, {
      roomId: m.room_id,
      sellableUnitId: m.su_id,
      pricingPlanId: m.plan_id,
      roomTypeId: m.room_type_id,
      basePrice: m.base_price,
      rows: m.plan_id ? (byPlan.get(m.plan_id) ?? []) : [],
    });
  }
  return out;
}

// Canonical rows for a room's base plan over one stay window (single-room path
// used by the reservation engine per stay). Convenience over getRoomPlanRates.
export async function getRoomStayRates(
  db: Sql | TransactionSql,
  tenantId: string,
  roomId: string,
  from: DateOnly,
  toInclusive: DateOnly,
): Promise<RoomPlanRates> {
  const map = await getRoomPlanRates(db, tenantId, [roomId], from, toInclusive);
  return (
    map.get(roomId) ?? {
      roomId,
      sellableUnitId: null,
      pricingPlanId: null,
      roomTypeId: null,
      basePrice: 0,
      rows: [],
    }
  );
}
