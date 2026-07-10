import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { eachDay, type DateOnly } from "@/lib/dates";
import { collectSellReasons, roomAdminStateOf } from "@/lib/rates/rules";
import type { SyncState } from "@/app/(dashboard)/rates/types";
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
  room_id: string | null;
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
  // Identity (code / name / room type) is JOINED from the canonical rooms table
  // for a sole-member unit — never read from the unit's own copied columns, so a
  // room rename or re-type shows immediately and stale backfill labels (101/G1…)
  // can never surface (D74). A pooled unit (>1 member room) is its own identity.
  // Rooms sort numerically (926 < 1006 < … < 1424) inside each type band.
  const units = await db<UnitMetaRow[]>`
    SELECT su.id, su.is_pooled,
           COALESCE(m.room_number, su.code) AS code,
           COALESCE(NULLIF(m.room_name, ''), su.name) AS name,
           m.room_id,
           COALESCE(m.room_type_id, su.room_type_id) AS room_type_id,
           rt.name AS room_type_name,
           COALESCE(rt.base_price, 0)::float8 AS base_price,
           bp.id AS plan_id,
           (SELECT count(*)::int FROM guesthub.sellable_unit_rooms sur
             WHERE sur.sellable_unit_id = su.id) AS room_count
    FROM guesthub.sellable_units su
    LEFT JOIN LATERAL (
      SELECT r.id AS room_id, r.room_number, r.name AS room_name, r.room_type_id
      FROM guesthub.sellable_unit_rooms sur
      JOIN guesthub.rooms r ON r.id = sur.room_id
      WHERE sur.sellable_unit_id = su.id
        AND NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms s2
                        WHERE s2.sellable_unit_id = su.id AND s2.room_id <> r.id)
      LIMIT 1
    ) m ON true
    LEFT JOIN guesthub.room_types rt ON rt.id = COALESCE(m.room_type_id, su.room_type_id)
    LEFT JOIN guesthub.pricing_plans bp
      ON bp.sellable_unit_id = su.id AND bp.is_base AND bp.is_active
    WHERE su.tenant_id = ${tenantId} AND su.is_active
    ORDER BY COALESCE(rt.base_price, 0), rt.name NULLS LAST,
             (CASE WHEN COALESCE(m.room_number, su.code) ~ '^\\d+$'
                   THEN COALESCE(m.room_number, su.code)::bigint END) NULLS LAST,
             COALESCE(m.room_number, su.code)`;

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

  // 3b. Per-SU member-room administrative status (day-independent) → lets the
  // reason classifier say WHY physical inventory is zero (inactive vs out_of_order
  // vs mapping) rather than a generic hatch. A room is physically eligible only
  // when status='available' AND is_active (the invariant every read model shares).
  const suStatus = await db<
    { sellable_unit_id: string; inactive: number; out_of_order: number }[]
  >`
    SELECT sur.sellable_unit_id,
           count(*) FILTER (WHERE r.status = 'inactive' OR NOT r.is_active)::int AS inactive,
           count(*) FILTER (WHERE r.status = 'out_of_order')::int AS out_of_order
    FROM guesthub.sellable_unit_rooms sur
    JOIN guesthub.rooms r ON r.id = sur.room_id
    WHERE sur.tenant_id = ${tenantId}
    GROUP BY sur.sellable_unit_id`;
  const statusBySu = new Map(suStatus.map((r) => [r.sellable_unit_id, r]));

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

  // 4b. Channel mapping + connection state → mapping_valid + sync_state (axis C
  // of the projection). With NO active connection everything is "not_connected"
  // and unmapped — the honest state; GuestHub never shows "synced" without a
  // remote ack. Since D64/D68 the outbound unit is the PHYSICAL ROOM: mappings
  // live in channel_room_mappings and dirty ranges are keyed by room_id (the
  // pre-D64 room_type keying of this branch crashed the route the moment a
  // connection first became active — D73). An SU cell derives its channel state
  // from its member rooms via sellable_unit_rooms, the same join the outbound
  // writer (outbox.ts) uses.
  const [conn] = await db<{ id: string }[]>`
    SELECT id FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND state = 'active' LIMIT 1`;
  const hasActiveConnection = !!conn;
  const suRooms = new Map<string, string[]>(); // SU id → member room ids
  const mappedRooms = new Set<string>();
  const pendingRoom = new Set<string>(); // (room, day) with a non-synced dirty range
  if (hasActiveConnection) {
    const members = await db<{ sellable_unit_id: string; room_id: string }[]>`
      SELECT sellable_unit_id, room_id FROM guesthub.sellable_unit_rooms
      WHERE tenant_id = ${tenantId}`;
    for (const m of members) {
      const list = suRooms.get(m.sellable_unit_id);
      if (list) list.push(m.room_id);
      else suRooms.set(m.sellable_unit_id, [m.room_id]);
    }
    const mapped = await db<{ room_id: string }[]>`
      SELECT DISTINCT room_id FROM guesthub.channel_room_mappings
      WHERE tenant_id = ${tenantId} AND status = 'mapped' AND room_id IS NOT NULL`;
    for (const m of mapped) mappedRooms.add(m.room_id);
    const dirty = await db<{ room_id: string | null; date_from: string; date_to: string }[]>`
      SELECT room_id, date_from::text AS date_from, date_to::text AS date_to
      FROM guesthub.channel_dirty_ranges
      WHERE tenant_id = ${tenantId} AND status <> 'synced'
        AND date_from < ${toExclusive} AND date_to > ${from}`;
    for (const dr of dirty) {
      if (!dr.room_id) continue;
      for (const day of eachDay(dr.date_from, dr.date_to)) pendingRoom.add(key(dr.room_id, day));
    }
  }

  const gridUnits: RateGridUnit[] = units.map((u) => {
    const memberRooms = suRooms.get(u.id) ?? [];
    const cells: RateCellState[] = dates.map((d) => {
      const e = essByKey.get(key(u.id, d));
      const iv = invByKey.get(key(u.id, d));
      const row = u.plan_id ? pprByKey.get(key(u.plan_id, d)) : undefined;

      const explicitPrice = row?.price ?? null;
      const effectivePrice = e ? e.price : explicitPrice ?? u.base_price;
      const st = statusBySu.get(u.id);
      const availability = iv?.availability ?? e?.availability ?? 0;
      const stopSell = row?.stop_sell ?? false;
      const totalRooms = iv?.total_rooms ?? u.room_count;
      const inactiveRooms = st?.inactive ?? 0;
      const outOfOrderRooms = st?.out_of_order ?? 0;
      const classifyInput = {
        hasBasePlan: !!u.plan_id,
        totalRooms,
        sellableRooms: iv?.sellable_rooms ?? 0,
        occupiedRooms: iv?.occupied_rooms ?? 0,
        closedRooms: iv?.closed_rooms ?? 0,
        inactiveRooms,
        outOfOrderRooms,
        availability,
        effectivePrice,
        stopSell,
      };
      const reasonCodes = collectSellReasons(classifyInput);
      const sellReason = reasonCodes[0];
      const minStayThrough = row?.min_stay_through ?? null;
      const minStayArrival = row?.min_stay_arrival ?? null;
      const maxStay = row?.max_stay ?? null;
      const closedToArrival = row?.closed_to_arrival ?? false;
      const closedToDeparture = row?.closed_to_departure ?? false;
      const syncState: SyncState = !hasActiveConnection
        ? "not_connected"
        : memberRooms.some((r) => pendingRoom.has(key(r, d)))
          ? "pending"
          : "clean";
      return {
        date: d,
        price: explicitPrice,
        minStayThrough,
        minStayArrival,
        maxStay,
        closedToArrival,
        closedToDeparture,
        stopSell,
        hasRow: !!row,
        effectivePrice,
        priceSource: explicitPrice != null ? "explicit" : "inherited",
        totalRooms,
        sellableRooms: iv?.sellable_rooms ?? 0,
        occupiedRooms: iv?.occupied_rooms ?? 0,
        closedRooms: iv?.closed_rooms ?? 0,
        availability,
        // A cell is sellable iff the single reason says so (includes a valid
        // price) — the DB `sellable` only covers availability ∧ ¬stop_sell.
        sellable: sellReason === "SELLABLE",
        sellReason,
        // ---- canonical projection (three axes, never collapsed) ----
        physicalHeld: 0, // OTA holds are room-type-scoped, excluded from SU inventory (4B)
        roomAdminState: roomAdminStateOf(totalRooms, inactiveRooms, outOfOrderRooms),
        commercialOpen: !stopSell,
        inheritedRate: u.base_price,
        activeRatePlan: !!u.plan_id,
        reasonCodes,
        // valid iff EVERY member room is mapped — an SU with any unmapped room
        // cannot be fully represented outbound (the writer sends per room).
        mappingValid: memberRooms.length > 0 && memberRooms.every((r) => mappedRooms.has(r)),
        syncState,
        // D64: one room → one Channex Room Type (count_of_rooms=1), so what the
        // projection sends for this SU's room(s) IS the SU's own availability.
        outboundAvailability: availability,
        outboundRestrictions: {
          rate: effectivePrice,
          stopSell,
          closedToArrival,
          closedToDeparture,
          minStayArrival,
          minStayThrough,
          maxStay,
        },
      };
    });
    return {
      sellableUnitId: u.id,
      pricingPlanId: u.plan_id,
      roomId: u.room_id,
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
