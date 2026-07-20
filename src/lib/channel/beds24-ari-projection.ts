import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { eachDay, dayOfWeek, type DateOnly } from "@/lib/dates";
import { getRoomPlanRates } from "@/lib/rates/effective-state";
import { indexByDate, type PlanRateRow } from "@/lib/rates/rules";
import {
  mergeRestrictionRows, resolveChainNightPrice, resolveParentChain,
  type EngineAssignment, type EnginePlan, type PlanKind,
} from "@/lib/pricing/resolve";
import type { AriProjection, BlockReason, OccupancyRate } from "./ari-projection";

// ============================================================
// Beds24 ARI projection (D78/D79) — a SIBLING of projectAri and of
// projectHospitableAri, not a duplicate. It exists because projectAri scopes
// its work through the Channex-owned mapping tables
// (channel_room_mappings.channex_room_type_id,
// channel_room_rate_mappings.channex_rate_plan_id, snapshot->>'occ_adults'),
// which are — by design, migrations 044/045 — NEVER written for a
// provider='beds24' connection. Beds24 maps one physical room to one Beds24
// room (propertyId+roomId) in guesthub.channel_beds24_room_mappings, with ONE
// designated local plan whose base-occupancy rate is the pushed price. So:
//
//   · scoping comes from channel_beds24_room_mappings
//     (status='mapped' AND local_rate_plan_id IS NOT NULL);
//   · the occ_adults / extra-guest per-person ladder is INTENTIONALLY skipped —
//     the Beds24 calendar takes a single price per date (price1), the plan's
//     base-occupancy nightly, so the projected rates array is exactly one
//     entry;
//   · EVERYTHING ELSE is the same canonical machinery projectAri uses, called
//     through the same imports — never copied:
//       availability  ← guesthub.sellable_unit_inventory()
//       nightly price ← resolveChainNightPrice() + resolveParentChain()
//       restrictions  ← mergeRestrictionRows()
//
// DO NOT "fix" this module by merging it back into projectAri (or into the
// Hospitable sibling): the three providers legitimately disagree about what a
// mapping IS. Output shape is the SAME AriProjection, so payload building /
// evidence code reads one shape.
//
// FAIL CLOSED (§6, identical to projectAri): a (room, plan, date) whose price
// cannot be resolved is never guessed, never zero. It is projected with
// stopSell=true and NO rate, and the reason is reported.
//
// PURE OF I/O BEYOND ITS LOADS: no HTTP lives here. The sender is
// beds24-ari-sync.ts.
// ============================================================

export type ProjectBeds24AriArgs = {
  tenantId: string;
  connectionId: string;
  dateFrom: DateOnly; // inclusive
  dateTo: DateOnly; // exclusive
  /** restrict to these mapped rooms; omitted = every mapped room */
  roomIds?: string[];
};

type MappedRoomRow = {
  room_id: string;
  local_rate_plan_id: string;
  sellable_unit_id: string | null;
  su_room_count: number;
};

type PlanDbRow = {
  id: string; code: string; name: string; public_name: string | null; plan_kind: PlanKind;
  parent_plan_id: string | null; adjustment_value: number | null; is_active: boolean; is_archived: boolean;
  valid_from: string | null; valid_until: string | null;
  min_advance_days: number | null; max_advance_days: number | null;
  allowed_checkin_days: number[] | null; default_min_stay: number | null; default_max_stay: number | null;
  default_closed_to_arrival: boolean; default_closed_to_departure: boolean;
  cancellation_policy_id: string | null;
  is_visible_channels: boolean;
};

function toEnginePlan(r: PlanDbRow): EnginePlan {
  return {
    id: r.id, code: r.code, name: r.name, publicName: r.public_name,
    planKind: r.plan_kind, parentPlanId: r.parent_plan_id, adjustmentValue: r.adjustment_value,
    isActive: r.is_active, isArchived: r.is_archived,
    validFrom: r.valid_from, validUntil: r.valid_until,
    minAdvanceDays: r.min_advance_days, maxAdvanceDays: r.max_advance_days,
    allowedCheckinDays: r.allowed_checkin_days, defaultMinStay: r.default_min_stay,
    defaultMaxStay: r.default_max_stay, defaultClosedToArrival: r.default_closed_to_arrival,
    defaultClosedToDeparture: r.default_closed_to_departure, cancellationPolicyId: r.cancellation_policy_id,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const maxNullable = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.max(a, b);
const minNullable = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.min(a, b);

export async function projectBeds24Ari(
  db: Sql | TransactionSql,
  args: ProjectBeds24AriArgs,
): Promise<AriProjection> {
  const dates = eachDay(args.dateFrom, args.dateTo);
  const empty: AriProjection = { availability: [], commercial: [], blocked: [] };
  if (dates.length === 0) return empty;

  // ---- mapped physical rooms. An unmapped room simply has no mapping row and
  // cannot appear; a mapping without a designated plan has no price source and
  // is excluded here (the payload builder surfaces it as unmapped). ----
  const roomRows = await db<MappedRoomRow[]>`
    SELECT m.room_id, m.local_rate_plan_id,
           sur.sellable_unit_id,
           (SELECT count(*)::int FROM guesthub.sellable_unit_rooms x
             WHERE x.sellable_unit_id = sur.sellable_unit_id) AS su_room_count
    FROM guesthub.channel_beds24_room_mappings m
    JOIN guesthub.rooms r ON r.id = m.room_id
    LEFT JOIN guesthub.sellable_unit_rooms sur ON sur.room_id = r.id
    WHERE m.connection_id = ${args.connectionId}
      AND m.tenant_id = ${args.tenantId}
      AND m.status = 'mapped' AND m.local_rate_plan_id IS NOT NULL
      ${args.roomIds?.length ? db`AND r.id = ANY(${args.roomIds}::uuid[])` : db``}
    ORDER BY r.room_number`;
  if (roomRows.length === 0) return empty;
  const roomIds = roomRows.map((r) => r.room_id);

  const out: AriProjection = { availability: [], commercial: [], blocked: [] };

  // one Beds24 room IS one physical room: a pooled sellable unit would make
  // `availability` a count of OTHER rooms. Refuse rather than over-sell.
  const isExclusive = (room: MappedRoomRow) =>
    room.sellable_unit_id != null && room.su_room_count === 1;

  // ============================================================
  // Pass 1 — availability: THE canonical physical projection, unmodified.
  // ============================================================
  const invRows = await db<{ room_id: string; day: string; availability: number }[]>`
    SELECT sur.room_id, inv.day::text AS day, inv.availability
    FROM guesthub.sellable_unit_inventory(${args.tenantId}, ${args.dateFrom}, ${args.dateTo}) inv
    JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = inv.sellable_unit_id
    WHERE sur.tenant_id = ${args.tenantId} AND sur.room_id = ANY(${roomIds}::uuid[])`;
  const availByRoomDay = new Map<string, number>();
  for (const r of invRows) availByRoomDay.set(`${r.room_id}|${r.day}`, r.availability);

  for (const room of roomRows) {
    const exclusive = isExclusive(room);
    for (const date of dates) {
      const raw = exclusive ? (availByRoomDay.get(`${room.room_id}|${date}`) ?? 0) : 0;
      out.availability.push({ roomId: room.room_id, date, availability: raw > 0 ? 1 : 0 });
    }
  }

  // ============================================================
  // Pass 2 — the designated plan's base-occupancy price + restrictions.
  // ============================================================

  // ---- tenant-level Rate Plans (the whole small set: parent chains resolve
  // without per-plan roundtrips, exactly as projectAri loads them) ----
  const planRows = await db<PlanDbRow[]>`
    SELECT id, code, name, public_name, plan_kind, parent_plan_id,
           adjustment_value::float8 AS adjustment_value, is_active, is_archived,
           valid_from::text AS valid_from, valid_until::text AS valid_until,
           min_advance_days, max_advance_days, allowed_checkin_days,
           default_min_stay, default_max_stay,
           default_closed_to_arrival, default_closed_to_departure,
           cancellation_policy_id, is_visible_channels
    FROM guesthub.pricing_plans
    WHERE tenant_id = ${args.tenantId} AND sellable_unit_id IS NULL`;
  const plansById = new Map(planRows.map((p) => [p.id, toEnginePlan(p)]));
  // Same withdrawal rule as projectAri: a plan that was archived, deactivated
  // or hidden from channels is still projected — as stopSell with no rate —
  // so its Beds24 room stops selling instead of selling stale prices.
  const sellablePlanIds = new Set(
    planRows.filter((p) => p.is_active && !p.is_archived && p.is_visible_channels).map((p) => p.id),
  );

  // ---- base room-night ARI + plan overlays + assignments (projectAri's loads) ----
  const lastDate = dates[dates.length - 1];
  const baseRates = await getRoomPlanRates(db, args.tenantId, roomIds, args.dateFrom, lastDate);

  const chainIds = new Set<string>();
  for (const room of roomRows) {
    chainIds.add(room.local_rate_plan_id);
    for (const p of resolveParentChain(plansById, room.local_rate_plan_id).chain) chainIds.add(p.id);
  }
  const chainIdList = [...chainIds];
  const suIds = [...new Set(roomRows.map((r) => r.sellable_unit_id).filter((x): x is string => !!x))];

  const assignmentRows = chainIdList.length && suIds.length
    ? await db<EngineAssignment[]>`
        SELECT pricing_plan_id AS "pricingPlanId", sellable_unit_id AS "sellableUnitId",
               is_active AS "isActive", adjustment_value::float8 AS "adjustmentValue",
               valid_from::text AS "validFrom", valid_until::text AS "validUntil"
        FROM guesthub.pricing_plan_units
        WHERE tenant_id = ${args.tenantId}
          AND pricing_plan_id = ANY(${chainIdList}::uuid[])
          AND sellable_unit_id = ANY(${suIds}::uuid[])`
    : [];
  const assignmentByKey = new Map(assignmentRows.map((a) => [`${a.pricingPlanId}|${a.sellableUnitId}`, a]));

  const overlayRows = chainIdList.length && suIds.length
    ? await db<(PlanRateRow & { pricing_plan_id: string; sellable_unit_id: string })[]>`
        SELECT pricing_plan_id, sellable_unit_id, date::text AS date, price::float8 AS price,
               min_stay_through, min_stay_arrival, max_stay,
               closed_to_arrival, closed_to_departure, stop_sell
        FROM guesthub.pricing_plan_unit_rates
        WHERE tenant_id = ${args.tenantId}
          AND pricing_plan_id = ANY(${chainIdList}::uuid[])
          AND sellable_unit_id = ANY(${suIds}::uuid[])
          AND date >= ${args.dateFrom} AND date <= ${lastDate}`
    : [];
  const overlayByPlanUnit = new Map<string, Map<string, PlanRateRow>>();
  for (const r of overlayRows) {
    const key = `${r.pricing_plan_id}|${r.sellable_unit_id}`;
    let m = overlayByPlanUnit.get(key);
    if (!m) { m = new Map(); overlayByPlanUnit.set(key, m); }
    const { pricing_plan_id: _p, sellable_unit_id: _s, ...row } = r;
    void _p; void _s;
    m.set(row.date, row);
  }
  const EMPTY_OVERLAY = new Map<string, PlanRateRow>();

  // ---- assemble: exactly ONE (room × plan) combination per mapped room ----
  for (const room of roomRows) {
    const exclusive = isExclusive(room);
    const su = room.sellable_unit_id;
    const base = baseRates.get(room.room_id);
    const baseByDate = indexByDate(base?.rows ?? []);
    const planId = room.local_rate_plan_id;
    const plan = plansById.get(planId);
    if (!plan) continue;
    const { chain, error: chainError } = resolveParentChain(plansById, planId);
    const assignment = su ? assignmentByKey.get(`${planId}|${su}`) : undefined;
    const overlay = su ? (overlayByPlanUnit.get(`${planId}|${su}`) ?? EMPTY_OVERLAY) : EMPTY_OVERLAY;

    // plan-level blockers that hold for EVERY date of the window. Same chain as
    // projectAri MINUS the occupancy/extra-guest checks (not applicable here).
    let planBlock: BlockReason | null = null;
    if (!exclusive) planBlock = "SELLABLE_UNIT_NOT_EXCLUSIVE";
    else if (chainError || !sellablePlanIds.has(planId)) planBlock = "RATE_PLAN_INACTIVE";
    else if (chain.slice(1).some((p) => !p.isActive || p.isArchived)) planBlock = "RATE_PLAN_INACTIVE";
    else if (!assignment || !assignment.isActive) planBlock = "RATE_PLAN_NOT_ASSIGNED";

    const merged = mergeRestrictionRows(dates, baseByDate, overlay, plan);

    for (const date of dates) {
      const m = merged.get(date) as PlanRateRow;

      // plan/assignment validity windows and arrival-day rule are canonical
      // GuestHub restrictions; express what the calendar can express, per date.
      const outsidePlan =
        (plan.validFrom != null && date < plan.validFrom) ||
        (plan.validUntil != null && date > plan.validUntil);
      const outsideAssignment =
        assignment != null &&
        ((assignment.validFrom != null && date < assignment.validFrom) ||
          (assignment.validUntil != null && date > assignment.validUntil));

      const closedToArrival =
        m.closed_to_arrival ||
        (plan.allowedCheckinDays != null && !plan.allowedCheckinDays.includes(dayOfWeek(date)));

      const restrictions = {
        minStayArrival: maxNullable(m.min_stay_arrival, plan.defaultMinStay),
        minStayThrough: m.min_stay_through,
        maxStay: minNullable(m.max_stay, plan.defaultMaxStay),
        closedToArrival,
        closedToDeparture: m.closed_to_departure,
      };

      const blockedReason: BlockReason | null = planBlock;
      if (blockedReason || outsidePlan || outsideAssignment) {
        if (blockedReason) out.blocked.push({ roomId: room.room_id, planId, date, reason: blockedReason });
        out.commercial.push({
          roomId: room.room_id, planId, date,
          rates: null, ...restrictions, stopSell: true, blockedReason,
        });
        continue;
      }

      const baseRow = baseByDate.get(date);
      const basePriceRaw =
        baseRow?.price != null ? Number(baseRow.price) : base && base.basePrice > 0 ? base.basePrice : null;
      const basePriceSource = baseRow?.price != null ? ("base_plan_rate" as const)
        : basePriceRaw != null ? ("room_type_base_price" as const)
        : null;

      // THE canonical resolution — identical call to the one engine.ts makes.
      const { resolution } = resolveChainNightPrice({
        chain, date, basePrice: basePriceRaw, basePriceSource,
        overlayFor: (id) => (su ? overlayByPlanUnit.get(`${id}|${su}`) : undefined),
        assignmentFor: (id) => (su ? assignmentByKey.get(`${id}|${su}`) : undefined),
      });
      const nightly = resolution.price;
      if (nightly == null || nightly <= 0) {
        out.blocked.push({ roomId: room.room_id, planId, date, reason: "NO_PRICE_FOR_DATE" });
        out.commercial.push({
          roomId: room.room_id, planId, date,
          rates: null, ...restrictions, stopSell: true, blockedReason: "NO_PRICE_FOR_DATE",
        });
        continue;
      }

      // ONE base-occupancy price — the Beds24 calendar push carries a single
      // price1 per date, no per-person ladder.
      const rates: OccupancyRate[] = [{ occupancy: 1, rate: round2(nightly) }];
      out.commercial.push({
        roomId: room.room_id, planId, date,
        rates, ...restrictions,
        stopSell: m.stop_sell,
        blockedReason: null,
      });
    }
  }

  return out;
}
