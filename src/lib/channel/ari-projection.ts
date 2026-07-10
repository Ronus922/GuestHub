import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { eachDay, dayOfWeek, type DateOnly } from "@/lib/dates";
import { getRoomPlanRates } from "@/lib/rates/effective-state";
import { indexByDate, type PlanRateRow } from "@/lib/rates/rules";
import {
  mergeRestrictionRows, resolveChainNightPrice, resolveParentChain,
  type EngineAssignment, type EnginePlan, type PlanKind,
} from "@/lib/pricing/resolve";
import { normalizeExtraGuestDefaults, roundMoney, type ExtraGuestDefaults } from "@/lib/commercial/extra-guest";
import { calculateChargeableGuests, resolveEffectivePricing } from "@/lib/commercial/room-pricing";

// ============================================================
// Channex ARI projection (D68). Turns CANONICAL GuestHub state into the two
// outbound shapes. It owns NO pricing, availability or restriction rule of its
// own — every value comes from a function the booking path already uses:
//
//   availability  ← guesthub.sellable_unit_inventory()  (the same function the
//                   occupancy calendar, the rate grid and booking validation
//                   read: reservations in inventory_blocking_statuses, room
//                   closures, rooms.status/is_active)
//   nightly price ← resolveChainNightPrice() + resolveParentChain()  — the exact
//                   functions src/lib/pricing/engine.ts calls for a quote
//   restrictions  ← mergeRestrictionRows()  — base room-night state ∪ plan overlay
//   occupancy     ← calculateChargeableGuests() + roundMoney()  — the extra-guest
//                   mechanism, per adult count
//
// scripts/check-channex-ari.mjs asserts the projected price equals
// calculateQuote()'s resolvedPlanPrice for the same (room, plan, night), so a
// divergence between what we sell and what we publish is a test failure.
//
// FAIL CLOSED (§6): a (room, plan, date) whose price cannot be resolved is never
// guessed, never zero, never copied from another room. It is published with
// stop_sell=true and NO rate, and the reason is reported.
//
// PURE OF I/O BEYOND ITS LOADS: no HTTP lives here. The sender is ari-sync.ts.
// ============================================================

export type BlockReason =
  | "NO_PRICE_FOR_DATE"
  | "EXTRA_GUEST_PRICING_INCOMPLETE"
  | "EXTRA_GUEST_FREQUENCY_UNSUPPORTED"
  | "RATE_PLAN_NOT_ASSIGNED"
  | "RATE_PLAN_INACTIVE"
  | "OCCUPANCY_UNKNOWN"
  | "SELLABLE_UNIT_NOT_EXCLUSIVE";

export type OccupancyRate = { occupancy: number; rate: number };

export type AvailabilityRow = {
  roomId: string;
  date: DateOnly;
  availability: number; // 0 | 1 — one Channex Room Type is one physical room
};

export type CommercialRow = {
  roomId: string;
  planId: string;
  date: DateOnly;
  /** null ⇔ blocked: no sellable price exists. Never [] and never rate 0. */
  rates: OccupancyRate[] | null;
  minStayArrival: number | null;
  minStayThrough: number | null;
  maxStay: number | null;
  stopSell: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  blockedReason: BlockReason | null;
};

export type AriProjection = {
  availability: AvailabilityRow[];
  commercial: CommercialRow[];
  /** distinct (room, plan, reason) — surfaced to the operator, never swallowed */
  blocked: { roomId: string; planId: string; date: DateOnly; reason: BlockReason }[];
};

export type ProjectAriArgs = {
  tenantId: string;
  connectionId: string;
  dateFrom: DateOnly; // inclusive
  dateTo: DateOnly; // exclusive
  /** restrict to these mapped rooms; omitted = every mapped room */
  roomIds?: string[];
  /** restrict to these tenant-level plans; omitted = every channel-visible plan */
  planIds?: string[];
};

type TenantRow = { timezone: string | null; extra_guest: unknown };

type MappedRoomRow = {
  room_id: string;
  room_number: string;
  included_occupancy: number | null;
  max_adults: number;
  max_children: number;
  max_infants: number;
  max_occupancy: number;
  extra_guest_pricing_mode: "inherit" | "override";
  extra_adult_override: number | null;
  extra_child_override: number | null;
  extra_infant_override: number | null;
  charge_frequency_override: "per_night" | "per_stay" | null;
  sellable_unit_id: string | null;
  su_room_count: number;
  occ_adults: string | null;
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

// The nightly extra-guest surcharge for every adult count 1..occAdults, through
// the SAME canonical mechanism a reservation uses. Depends only on (room,
// occupancy), so it is resolved ONCE per room rather than per date. Fails closed
// for the whole room when the configuration cannot price an occupancy — never ₪0.
function extraPerNightByOccupancy(
  room: MappedRoomRow,
  eg: ExtraGuestDefaults,
  occAdults: number,
): { ok: true; byOccupancy: number[] } | { ok: false; reason: BlockReason } {
  if (room.included_occupancy == null) return { ok: false, reason: "EXTRA_GUEST_PRICING_INCOMPLETE" };
  const effective = resolveEffectivePricing(
    {
      mode: room.extra_guest_pricing_mode,
      extra_adult: room.extra_adult_override,
      extra_child: room.extra_child_override,
      extra_infant: room.extra_infant_override,
      charge_frequency: room.charge_frequency_override,
    },
    eg,
  );
  // A per-stay surcharge has no honest per-night representation in a Channex
  // per_person option. Refuse rather than silently drop or amortise it.
  if (effective.charge_frequency.value !== "per_night")
    return { ok: false, reason: "EXTRA_GUEST_FREQUENCY_UNSUPPORTED" };

  const byOccupancy: number[] = [0]; // index = adult count; [0] unused
  for (let adults = 1; adults <= occAdults; adults++) {
    const chargeable = calculateChargeableGuests({
      adults, children: 0, infants: 0,
      includedOccupancy: room.included_occupancy,
      maxAdults: room.max_adults, maxChildren: room.max_children, maxInfants: room.max_infants,
      maxOccupancy: room.max_occupancy,
      infantsCountOccupancy: eg.infants_count_occupancy,
      infantsUseIncluded: eg.infants_use_included,
      pricing: {
        adult: effective.extra_adult.value ?? 0,
        child: effective.extra_child.value ?? 0,
        infant: effective.extra_infant.value ?? 0,
        frequency: effective.charge_frequency.value,
      },
    });
    if (!chargeable.valid) return { ok: false, reason: "EXTRA_GUEST_PRICING_INCOMPLETE" };
    // same fail-closed rule as engine.ts: a chargeable extra adult with no
    // configured amount invalidates the price — it never becomes a free guest.
    if (chargeable.extraAdults > 0 && effective.extra_adult.value == null)
      return { ok: false, reason: "EXTRA_GUEST_PRICING_INCOMPLETE" };
    byOccupancy.push(roundMoney(chargeable.totalExtra, eg.rounding_mode, eg.rounding_increment));
  }
  return { ok: true, byOccupancy };
}

export async function projectAri(
  db: Sql | TransactionSql,
  args: ProjectAriArgs,
): Promise<AriProjection> {
  const dates = eachDay(args.dateFrom, args.dateTo);
  const empty: AriProjection = { availability: [], commercial: [], blocked: [] };
  if (dates.length === 0) return empty;

  const [tenant] = await db<TenantRow[]>`
    SELECT timezone, settings->'extra_guest' AS extra_guest
    FROM guesthub.tenants WHERE id = ${args.tenantId}`;
  if (!tenant) return empty;
  const eg = normalizeExtraGuestDefaults(tenant.extra_guest);

  // ---- mapped physical rooms (D64). An unmapped room — and a permanently
  // removed one, e.g. 302/303 — simply has no mapping row and cannot appear. ----
  const roomRows = await db<MappedRoomRow[]>`
    SELECT r.id AS room_id, r.room_number, r.included_occupancy,
           r.max_adults, r.max_children, r.max_infants, r.max_occupancy,
           r.extra_guest_pricing_mode,
           r.extra_adult_override::float8  AS extra_adult_override,
           r.extra_child_override::float8  AS extra_child_override,
           r.extra_infant_override::float8 AS extra_infant_override,
           r.charge_frequency_override,
           sur.sellable_unit_id,
           (SELECT count(*)::int FROM guesthub.sellable_unit_rooms x
             WHERE x.sellable_unit_id = sur.sellable_unit_id) AS su_room_count,
           m.snapshot->>'occ_adults' AS occ_adults
    FROM guesthub.channel_room_mappings m
    JOIN guesthub.rooms r ON r.id = m.room_id
    LEFT JOIN guesthub.sellable_unit_rooms sur ON sur.room_id = r.id
    WHERE m.connection_id = ${args.connectionId}
      AND m.tenant_id = ${args.tenantId}
      AND m.status = 'mapped' AND m.channex_room_type_id IS NOT NULL
      ${args.roomIds?.length ? db`AND r.id = ANY(${args.roomIds}::uuid[])` : db``}
    ORDER BY r.room_number`;
  if (roomRows.length === 0) return empty;
  const roomIds = roomRows.map((r) => r.room_id);

  // ---- availability: THE canonical physical projection, unmodified ----
  const invRows = await db<{ room_id: string; day: string; availability: number }[]>`
    SELECT sur.room_id, inv.day::text AS day, inv.availability
    FROM guesthub.sellable_unit_inventory(${args.tenantId}, ${args.dateFrom}, ${args.dateTo}) inv
    JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = inv.sellable_unit_id
    WHERE sur.tenant_id = ${args.tenantId} AND sur.room_id = ANY(${roomIds}::uuid[])`;
  const availByRoomDay = new Map<string, number>();
  for (const r of invRows) availByRoomDay.set(`${r.room_id}|${r.day}`, r.availability);

  // ---- tenant-level Rate Plans (the whole small set: parent chains resolve
  // without per-plan roundtrips, exactly as engine.ts loads them) ----
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

  // The projected plan set is DERIVED, never a hardcoded four: EVERY live
  // (room × plan) Channex mapping. A plan that was archived or hidden from
  // channels is deliberately still projected — as stop_sell with no rate. Were
  // it merely filtered out, its Channex Rate Plan would keep selling at the last
  // prices we published. Withdrawal must be an explicit publication.
  const mappedCombos = await db<{ room_id: string; local_rate_plan_id: string }[]>`
    SELECT room_id, local_rate_plan_id
    FROM guesthub.channel_room_rate_mappings
    WHERE connection_id = ${args.connectionId} AND tenant_id = ${args.tenantId}
      AND status = 'mapped' AND channex_rate_plan_id IS NOT NULL`;
  const sellablePlanIds = new Set(
    planRows.filter((p) => p.is_active && !p.is_archived && p.is_visible_channels).map((p) => p.id),
  );
  const wanted = args.planIds?.length ? new Set(args.planIds) : null;
  const combosByRoom = new Map<string, string[]>();
  for (const c of mappedCombos) {
    if (wanted && !wanted.has(c.local_rate_plan_id)) continue;
    const arr = combosByRoom.get(c.room_id);
    if (arr) arr.push(c.local_rate_plan_id);
    else combosByRoom.set(c.room_id, [c.local_rate_plan_id]);
  }

  // ---- base room-night ARI + plan overlays + assignments (engine.ts's loads) ----
  const lastDate = dates[dates.length - 1];
  const baseRates = await getRoomPlanRates(db, args.tenantId, roomIds, args.dateFrom, lastDate);

  const chainIds = new Set<string>();
  for (const planIds of combosByRoom.values()) {
    for (const id of planIds) {
      chainIds.add(id);
      for (const p of resolveParentChain(plansById, id).chain) chainIds.add(p.id);
    }
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

  // ---- assemble ----
  const out: AriProjection = { availability: [], commercial: [], blocked: [] };

  for (const room of roomRows) {
    // one Channex Room Type IS one physical room: a pooled sellable unit would
    // make `availability` a count of OTHER rooms. Refuse rather than over-sell.
    const exclusive = room.sellable_unit_id != null && room.su_room_count === 1;

    for (const date of dates) {
      const raw = exclusive ? (availByRoomDay.get(`${room.room_id}|${date}`) ?? 0) : 0;
      out.availability.push({ roomId: room.room_id, date, availability: raw > 0 ? 1 : 0 });
    }

    const su = room.sellable_unit_id;
    const base = baseRates.get(room.room_id);
    const baseByDate = indexByDate(base?.rows ?? []);
    const occAdultsRaw = room.occ_adults === null ? NaN : Number(room.occ_adults);
    const occAdults = Number.isInteger(occAdultsRaw) && occAdultsRaw > 0 ? occAdultsRaw : null;

    // resolved once per room: the extra-guest surcharge per adult count
    const extras = occAdults === null ? null : extraPerNightByOccupancy(room, eg, occAdults);

    for (const planId of combosByRoom.get(room.room_id) ?? []) {
      const plan = plansById.get(planId);
      if (!plan) continue;
      const { chain, error: chainError } = resolveParentChain(plansById, planId);
      const assignment = su ? assignmentByKey.get(`${planId}|${su}`) : undefined;
      const overlay = su ? (overlayByPlanUnit.get(`${planId}|${su}`) ?? EMPTY_OVERLAY) : EMPTY_OVERLAY;

      // plan-level blockers that hold for EVERY date of the window
      let planBlock: BlockReason | null = null;
      if (!exclusive) planBlock = "SELLABLE_UNIT_NOT_EXCLUSIVE";
      else if (occAdults === null || extras === null) planBlock = "OCCUPANCY_UNKNOWN";
      else if (!extras.ok) planBlock = extras.reason;
      // archived / deactivated / withdrawn from channels ⇒ publish stop_sell
      else if (chainError || !sellablePlanIds.has(planId)) planBlock = "RATE_PLAN_INACTIVE";
      else if (chain.slice(1).some((p) => !p.isActive || p.isArchived)) planBlock = "RATE_PLAN_INACTIVE";
      else if (!assignment || !assignment.isActive) planBlock = "RATE_PLAN_NOT_ASSIGNED";

      const merged = mergeRestrictionRows(dates, baseByDate, overlay, plan);

      for (const date of dates) {
        const m = merged.get(date) as PlanRateRow;

        // plan/assignment validity windows and arrival-day rule are canonical
        // GuestHub restrictions; express what Channex can express, per date.
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

        // one option per adult count the mapped Channex Room Type accepts (D65).
        // `extras` is proven ok above (planBlock would have fired otherwise).
        const byOccupancy = (extras as { ok: true; byOccupancy: number[] }).byOccupancy;
        const rates: OccupancyRate[] = [];
        let occBlock: BlockReason | null = null;
        for (let occ = 1; occ <= (occAdults as number); occ++) {
          const rate = round2(nightly + byOccupancy[occ]);
          if (!(rate > 0)) { occBlock = "NO_PRICE_FOR_DATE"; break; }
          rates.push({ occupancy: occ, rate });
        }
        if (occBlock) {
          out.blocked.push({ roomId: room.room_id, planId, date, reason: occBlock });
          out.commercial.push({
            roomId: room.room_id, planId, date,
            rates: null, ...restrictions, stopSell: true, blockedReason: occBlock,
          });
          continue;
        }

        out.commercial.push({
          roomId: room.room_id, planId, date,
          rates, ...restrictions,
          stopSell: m.stop_sell,
          blockedReason: null,
        });
      }
    }
  }

  return out;
}
