import "server-only";
import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { eachDay, isDateOnly, todayInTz } from "@/lib/dates";
import { DEFAULT_VAT_RATE, includedVatAmount, parseVatRate } from "@/lib/vat";
import { indexByDate, stayRestrictionViolationStructured, stayViolationMessage, type PlanRateRow } from "@/lib/rates/rules";
import { getRoomPlanRates } from "@/lib/rates/effective-state";
import { checkRoomAvailability } from "@/lib/inventory";
import { normalizeExtraGuestDefaults, roundMoney, type ExtraGuestDefaults } from "@/lib/commercial/extra-guest";
import { calculateChargeableGuests, resolveEffectivePricing } from "@/lib/commercial/room-pricing";
import {
  assignmentViolation, mergeRestrictionRows, planStayRuleViolation, resolveChainNightPrice, resolveParentChain,
  type EngineAssignment, type EnginePlan, type PlanKind,
} from "./resolve";
import { PRICING_ERROR_MESSAGES } from "./messages";
import {
  MAX_QUOTE_NIGHTS, PRICING_ENGINE_VERSION,
  type NightQuote, type PriceSource, type PricingError, type PricingErrorCode,
  type PricingQuoteRequest, type PricingQuoteResult, type PricingWarning, type RoomQuote,
} from "./types";

// ============================================================
// THE central server-side pricing engine (spec §14). One canonical calculation
// for the simulator, manual reservations, the future website booking engine and
// channel processing. Callable from server actions, API routes and tests —
// never from React state. All loads are BATCHED (spec §28): one query per
// concern for the whole quote, never per-room-per-night.
//
// Rounding policy (§12): nightly resolved plan price → round2; extra-guest
// amount → the property rounding rule (roundMoney); totals summed in integer
// cents; VAT extracted from the gross total (project canonical: VAT-inclusive,
// whole-currency VAT amount per lib/vat.ts).
// ============================================================

const ROUNDING_POLICY =
  "nightly price rounded to cents after adjustment; extra-guest amount per property rounding rule; totals summed in cents; VAT extracted from gross (inclusive)";

const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);

const err = (code: PricingErrorCode, extra?: Partial<PricingError>): PricingError => ({
  code, message: extra?.message ?? PRICING_ERROR_MESSAGES[code], ...extra,
});

// Deterministic JSON: recursively key-sorted, so the fingerprint is stable for
// identical commercial inputs and changes whenever a resolved value changes.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

type TenantRow = {
  currency: string; timezone: string | null;
  vat_rate: string | null; extra_guest: unknown;
};

type EngineRoomRow = {
  id: string; room_number: string; name: string | null; status: string; is_active: boolean;
  max_occupancy: number; max_adults: number; max_children: number; max_infants: number;
  min_occupancy: number | null; included_occupancy: number | null;
  extra_guest_pricing_mode: "inherit" | "override";
  extra_adult_override: number | null; extra_child_override: number | null; extra_infant_override: number | null;
  charge_frequency_override: "per_night" | "per_stay" | null;
  sellable_unit_id: string | null; unit_active: boolean | null;
};

type PlanDbRow = {
  id: string; code: string; name: string; public_name: string | null; plan_kind: PlanKind;
  parent_plan_id: string | null; adjustment_value: number | null; is_active: boolean; is_archived: boolean;
  valid_from: string | null; valid_until: string | null;
  min_advance_days: number | null; max_advance_days: number | null;
  allowed_checkin_days: number[] | null; default_min_stay: number | null; default_max_stay: number | null;
  default_closed_to_arrival: boolean; default_closed_to_departure: boolean;
  cancellation_policy_id: string | null;
};

type OverlayDbRow = PlanRateRow & { pricing_plan_id: string; sellable_unit_id: string };

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

// Assemble an early-invalid result (request-level rejection) that still carries
// a deterministic fingerprint of the inputs.
function invalidResult(
  req: PricingQuoteRequest, currency: string, vatRate: number, errors: PricingError[],
): PricingQuoteResult {
  return {
    engineVersion: PRICING_ENGINE_VERSION,
    quoteFingerprint: fingerprintOf({ req: { ...req }, currency, vatRate, rooms: [] }),
    tenantId: req.tenantId, currency,
    checkIn: req.checkIn, checkOut: req.checkOut,
    numberOfNights: 0, valid: false, rooms: [],
    subtotalNet: 0, vatRate, vatAmount: 0, totalGross: 0,
    priceIncludesVat: true, roundingPolicy: ROUNDING_POLICY,
    warnings: [], errors,
  };
}

function fingerprintOf(payload: unknown): string {
  return createHash("sha256")
    .update(PRICING_ENGINE_VERSION)
    .update(stableStringify(payload))
    .digest("hex");
}

// THE single public pricing entry point (D51). Every price-determining surface
// — the Rate Plan simulator, manual reservation create/edit/move, quote
// previews, the future direct booking engine and channel processing — calls
// THIS function. `calculateQuote` below is the same function under its
// original name (kept for the existing check suites).
export async function calculateReservationPrice(
  db: Sql | TransactionSql,
  req: PricingQuoteRequest,
): Promise<PricingQuoteResult> {
  return calculateQuote(db, req);
}

export async function calculateQuote(
  db: Sql | TransactionSql,
  req: PricingQuoteRequest,
): Promise<PricingQuoteResult> {
  // ---- tenant context (one query; §28 loads tenant settings once) ----
  const [tenant] = await db<TenantRow[]>`
    SELECT currency, timezone,
           settings->>'vat_rate' AS vat_rate,
           settings->'extra_guest' AS extra_guest
    FROM guesthub.tenants WHERE id = ${req.tenantId}`;
  if (!tenant) return invalidResult(req, "ILS", DEFAULT_VAT_RATE, [err("MIXED_TENANT_DATA")]);

  const currency = tenant.currency || "ILS";
  const vatRate = parseVatRate(tenant.vat_rate) ?? DEFAULT_VAT_RATE;
  const egDefaults: ExtraGuestDefaults = normalizeExtraGuestDefaults(tenant.extra_guest);
  const today = todayInTz(tenant.timezone || "Asia/Jerusalem");

  // ---- request-level validation ----
  if (req.requestedCurrency && req.requestedCurrency !== currency)
    return invalidResult(req, currency, vatRate, [err("CURRENCY_MISMATCH")]);
  if (!isDateOnly(req.checkIn) || !isDateOnly(req.checkOut) || req.checkOut <= req.checkIn || req.rooms.length === 0)
    return invalidResult(req, currency, vatRate, [err("INVALID_DATE_RANGE")]);
  const nights = eachDay(req.checkIn, req.checkOut);
  if (nights.length > MAX_QUOTE_NIGHTS)
    return invalidResult(req, currency, vatRate, [err("QUOTE_WINDOW_EXCEEDED")]);

  const stay = { checkIn: req.checkIn, checkOut: req.checkOut, nights };
  const roomIds = [...new Set(req.rooms.map((r) => r.roomId))];

  // ---- batched loads (§28) ----
  const roomRows = await db<EngineRoomRow[]>`
    SELECT r.id, r.room_number, r.name, r.status, r.is_active,
           r.max_occupancy, r.max_adults, r.max_children, r.max_infants,
           r.min_occupancy, r.included_occupancy, r.extra_guest_pricing_mode,
           r.extra_adult_override::float8  AS extra_adult_override,
           r.extra_child_override::float8  AS extra_child_override,
           r.extra_infant_override::float8 AS extra_infant_override,
           r.charge_frequency_override,
           sur.sellable_unit_id, su.is_active AS unit_active
    FROM guesthub.rooms r
    LEFT JOIN guesthub.sellable_unit_rooms sur ON sur.room_id = r.id
    LEFT JOIN guesthub.sellable_units su ON su.id = sur.sellable_unit_id
    WHERE r.tenant_id = ${req.tenantId} AND r.id = ANY(${roomIds}::uuid[])`;
  const roomsById = new Map(roomRows.map((r) => [r.id, r]));

  // Tenant-level Rate Plans — the whole (small) set, so parent chains resolve
  // without per-plan roundtrips.
  const planRows = await db<PlanDbRow[]>`
    SELECT id, code, name, public_name, plan_kind, parent_plan_id,
           adjustment_value::float8 AS adjustment_value, is_active, is_archived,
           valid_from::text AS valid_from, valid_until::text AS valid_until,
           min_advance_days, max_advance_days, allowed_checkin_days,
           default_min_stay, default_max_stay,
           default_closed_to_arrival, default_closed_to_departure,
           cancellation_policy_id
    FROM guesthub.pricing_plans
    WHERE tenant_id = ${req.tenantId} AND sellable_unit_id IS NULL`;
  const plansById = new Map(planRows.map((p) => [p.id, toEnginePlan(p)]));

  // Base ARI for every room over [checkIn, checkOut] — checkout row included
  // for the CTD rule. This is the same read the reservation engine uses.
  const baseRates = await getRoomPlanRates(db, req.tenantId, roomIds, req.checkIn, req.checkOut);

  // Parent chains → the full plan-id set the overlay/assignment loads need.
  // Entries with ratePlanId null price the base-ARI layer and need no plan rows.
  const chainIdSet = new Set<string>();
  for (const entry of req.rooms) {
    if (entry.ratePlanId == null) continue;
    const { chain } = resolveParentChain(plansById, entry.ratePlanId);
    for (const p of chain) chainIdSet.add(p.id);
    chainIdSet.add(entry.ratePlanId);
  }
  const chainIds = [...chainIdSet];
  const suIds = [...new Set(roomRows.map((r) => r.sellable_unit_id).filter((x): x is string => !!x))];

  const assignmentRows = chainIds.length && suIds.length
    ? await db<(EngineAssignment & Record<never, never>)[]>`
        SELECT pricing_plan_id AS "pricingPlanId", sellable_unit_id AS "sellableUnitId",
               is_active AS "isActive", adjustment_value::float8 AS "adjustmentValue",
               valid_from::text AS "validFrom", valid_until::text AS "validUntil"
        FROM guesthub.pricing_plan_units
        WHERE tenant_id = ${req.tenantId}
          AND pricing_plan_id = ANY(${chainIds}::uuid[])
          AND sellable_unit_id = ANY(${suIds}::uuid[])`
    : [];
  const assignmentByKey = new Map(assignmentRows.map((a) => [`${a.pricingPlanId}|${a.sellableUnitId}`, a]));

  const overlayRows = chainIds.length && suIds.length
    ? await db<OverlayDbRow[]>`
        SELECT pricing_plan_id, sellable_unit_id, date::text AS date, price::float8 AS price,
               min_stay_through, min_stay_arrival, max_stay,
               closed_to_arrival, closed_to_departure, stop_sell
        FROM guesthub.pricing_plan_unit_rates
        WHERE tenant_id = ${req.tenantId}
          AND pricing_plan_id = ANY(${chainIds}::uuid[])
          AND sellable_unit_id = ANY(${suIds}::uuid[])
          AND date >= ${req.checkIn} AND date <= ${req.checkOut}`
    : [];
  const overlayByPlanUnit = new Map<string, Map<string, PlanRateRow>>();
  for (const r of overlayRows) {
    const key = `${r.pricing_plan_id}|${r.sellable_unit_id}`;
    let m = overlayByPlanUnit.get(key);
    if (!m) { m = new Map(); overlayByPlanUnit.set(key, m); }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { pricing_plan_id: _p, sellable_unit_id: _s, ...row } = r;
    m.set(row.date, row);
  }
  const EMPTY_OVERLAY = new Map<string, PlanRateRow>();

  // Physical availability for all rooms at once (same seam as reservations).
  // An edit/move excludes the stay's own rows exactly like the legacy path.
  const conflicts = await checkRoomAvailability(db, {
    tenantId: req.tenantId, roomIds, checkIn: req.checkIn, checkOut: req.checkOut,
    excludeReservationRoomIds: req.excludeReservationRoomIds,
  });
  const conflictsByRoom = new Map<string, typeof conflicts>();
  for (const c of conflicts) {
    const arr = conflictsByRoom.get(c.room_id) ?? [];
    arr.push(c);
    conflictsByRoom.set(c.room_id, arr);
  }

  // ---- per-room assembly ----
  const seenRoomIds = new Set<string>();
  const roomQuotes: RoomQuote[] = [];

  for (const entry of req.rooms) {
    const roomErrors: PricingError[] = [];
    const roomWarnings: PricingWarning[] = [];
    const restrictionsEvaluated: string[] = [];
    const ctx = { roomId: entry.roomId, ratePlanId: entry.ratePlanId ?? undefined };

    if (seenRoomIds.has(entry.roomId)) roomErrors.push(err("ROOM_DUPLICATED", ctx));
    seenRoomIds.add(entry.roomId);

    const room = roomsById.get(entry.roomId);
    if (!room) {
      roomQuotes.push(emptyRoomQuote(entry, [err("ROOM_NOT_FOUND", ctx), ...roomErrors]));
      continue;
    }

    // physical eligibility (§3.1: a Rate Plan never adds availability)
    restrictionsEvaluated.push("room_status", "availability");
    if (!room.is_active || room.status === "inactive") roomErrors.push(err("ROOM_INACTIVE", ctx));
    else if (room.status === "out_of_order") roomErrors.push(err("ROOM_OUT_OF_ORDER", ctx));
    const roomConflicts = conflictsByRoom.get(entry.roomId) ?? [];
    let available = roomErrors.length === 0;
    for (const c of roomConflicts) {
      if (c.conflict_kind === "reservation") { roomErrors.push(err("ROOM_UNAVAILABLE", ctx)); available = false; }
      else if (c.conflict_kind === "closure") { roomErrors.push(err("ROOM_CLOSED", ctx)); available = false; }
      else available = false; // room_missing / room_status already covered above
    }
    if (room.unit_active === false) { roomErrors.push(err("ROOM_UNAVAILABLE", { ...ctx, message: "יחידת המכירה של החדר אינה פעילה" })); available = false; }

    // rate plan + chain — ratePlanId null is the explicit base-ARI mode: no
    // tenant-level plan is applied, so no plan lookups/rules/assignment run.
    const plan = entry.ratePlanId != null ? plansById.get(entry.ratePlanId) : null;
    if (entry.ratePlanId != null && !plan) {
      roomQuotes.push(emptyRoomQuote(entry, [...roomErrors, err("RATE_PLAN_NOT_FOUND", ctx)], room, available));
      continue;
    }
    let chain: ReturnType<typeof resolveParentChain>["chain"] = [];
    if (plan) {
      if (plan.isArchived || !plan.isActive) roomErrors.push(err("RATE_PLAN_INACTIVE", ctx));
      const resolvedChain = resolveParentChain(plansById, plan.id);
      chain = resolvedChain.chain;
      if (resolvedChain.error) roomErrors.push(err(resolvedChain.error, ctx));
      for (const p of chain.slice(1)) {
        if (p.isArchived || !p.isActive) { roomErrors.push(err("RATE_PLAN_PARENT_INACTIVE", ctx)); break; }
      }
    }

    // assignment (the REQUESTED plan must be actively assigned to the unit;
    // parents only provide the pricing basis and need no assignment; the
    // base-ARI mode needs only a sellable unit)
    restrictionsEvaluated.push("assignment");
    const su = room.sellable_unit_id;
    if (!su) roomErrors.push(err("RATE_PLAN_NOT_ASSIGNED", { ...ctx, message: "לחדר אין יחידת מכירה מוגדרת" }));
    else if (plan) {
      const assignment = assignmentByKey.get(`${plan.id}|${su}`);
      const v = assignmentViolation(assignment, stay);
      if (v) roomErrors.push(err(v, ctx));
    }

    // plan-level stay rules (validity, booking window, DOW, plan min/max stay)
    if (plan) {
      restrictionsEvaluated.push("plan_rules");
      const planRule = planStayRuleViolation(plan, stay, today);
      if (planRule) roomErrors.push(err(planRule.code, { ...ctx, message: planRule.detail }));
    }

    // date-level restrictions: base room-night state + plan overlay, merged,
    // through the SAME shared validator the grid and reservations use.
    restrictionsEvaluated.push("date_restrictions");
    const base = baseRates.get(entry.roomId);
    const baseByDate = indexByDate(base?.rows ?? []);
    const overlay = plan && su ? (overlayByPlanUnit.get(`${plan.id}|${su}`) ?? EMPTY_OVERLAY) : EMPTY_OVERLAY;
    const merged = mergeRestrictionRows(
      [...nights, req.checkOut], baseByDate, overlay,
      plan ?? { defaultClosedToArrival: false, defaultClosedToDeparture: false },
    );
    const violation = stayRestrictionViolationStructured(merged, stay);
    if (violation) {
      const code: PricingErrorCode = violation.code === "STOP_SELL" ? "ROOM_CLOSED" : violation.code;
      roomErrors.push(err(code, { ...ctx, date: violation.date, message: stayViolationMessage(violation) }));
    }

    // occupancy (§11) — canonical room fields; included_occupancy is the
    // extra-guest threshold, default_occupancy is NEVER used for charging.
    restrictionsEvaluated.push("occupancy");
    const occupancy = entry.adults + entry.children + (egDefaults.infants_count_occupancy ? entry.infants : 0);
    if (entry.adults < 1) roomErrors.push(err("OCCUPANCY_BELOW_MINIMUM", { ...ctx, message: "נדרש לפחות מבוגר אחד" }));
    if (room.min_occupancy != null && occupancy < room.min_occupancy)
      roomErrors.push(err("OCCUPANCY_BELOW_MINIMUM", ctx));
    if (occupancy > room.max_occupancy) roomErrors.push(err("OCCUPANCY_EXCEEDED", ctx));
    if (entry.adults > room.max_adults) roomErrors.push(err("ADULT_LIMIT_EXCEEDED", ctx));
    if (entry.children > room.max_children) roomErrors.push(err("CHILD_LIMIT_EXCEEDED", ctx));
    if (entry.infants > room.max_infants) roomErrors.push(err("INFANT_LIMIT_EXCEEDED", ctx));

    // extra guests — the EXISTING canonical mechanism (§11): pure resolver over
    // room override ↓ property default, then the shared chargeable calculation.
    const effective = resolveEffectivePricing(
      {
        mode: room.extra_guest_pricing_mode,
        extra_adult: room.extra_adult_override,
        extra_child: room.extra_child_override,
        extra_infant: room.extra_infant_override,
        charge_frequency: room.charge_frequency_override,
      },
      egDefaults,
    );
    // authorized manual override (§13): the final nightly price — extra-guest
    // charging is bypassed exactly like the legacy manual-rate semantics
    // (priceTotal = rate × nights). Rules/occupancy above still ran.
    const manualRate = entry.manualRatePerNight ?? null;
    let extraAdults = 0, extraChildren = 0, extraInfants = 0;
    let extraPerNight = 0, extraPerStay = 0;
    const frequency = effective.charge_frequency.value;
    if (manualRate != null) {
      // no extra-guest computation — the override IS the whole nightly price
    } else if (room.included_occupancy == null) {
      roomErrors.push(err("EXTRA_GUEST_PRICING_INCOMPLETE", { ...ctx, message: "אורחים הכלולים במחיר הבסיס טרם הוגדרו לחדר" }));
    } else {
      const chargeable = calculateChargeableGuests({
        adults: entry.adults, children: entry.children, infants: entry.infants,
        includedOccupancy: room.included_occupancy,
        maxAdults: room.max_adults, maxChildren: room.max_children, maxInfants: room.max_infants,
        maxOccupancy: room.max_occupancy,
        infantsCountOccupancy: egDefaults.infants_count_occupancy,
        infantsUseIncluded: egDefaults.infants_use_included,
        pricing: {
          adult: effective.extra_adult.value ?? 0,
          child: effective.extra_child.value ?? 0,
          infant: effective.extra_infant.value ?? 0,
          frequency,
        },
      });
      extraAdults = chargeable.extraAdults;
      extraChildren = chargeable.extraChildren;
      extraInfants = chargeable.extraInfants;
      // fail closed: a chargeable extra guest whose category amount is not
      // configured makes the quote invalid — never a silent ₪0.
      if (
        (extraAdults > 0 && effective.extra_adult.value == null) ||
        (extraChildren > 0 && effective.extra_child.value == null) ||
        (extraInfants > 0 && effective.extra_infant.value == null)
      ) {
        roomErrors.push(err("EXTRA_GUEST_PRICING_INCOMPLETE", ctx));
      } else {
        const rounded = roundMoney(chargeable.totalExtra, egDefaults.rounding_mode, egDefaults.rounding_increment);
        if (frequency === "per_night") extraPerNight = rounded;
        else extraPerStay = rounded;
      }
    }
    const extraGuestSource: RoomQuote["extraGuestSource"] =
      [effective.extra_adult, effective.extra_child, effective.extra_infant].some((a) => a.source === "room_override")
        ? "room_override"
        : [effective.extra_adult, effective.extra_child, effective.extra_infant].some((a) => a.source === "property_default")
          ? "property_default"
          : "unconfigured";

    // nightly pricing through the parent chain, root-first (§8.2/§8.3)
    const nightQuotes: NightQuote[] = [];
    const sourcesUsed = new Set<PriceSource>();
    let subtotalCents = 0;
    let priced = true;
    for (const date of nights) {
      const baseRow = baseByDate.get(date);
      const basePriceRaw = baseRow?.price != null ? Number(baseRow.price) : (base && base.basePrice > 0 ? base.basePrice : null);
      const basePriceSource: NightQuote["basePriceSource"] =
        baseRow?.price != null ? "base_plan_rate" : basePriceRaw != null ? "room_type_base_price" : null;

      // authorized manual override: the final nightly price, never re-resolved
      if (manualRate != null) {
        const resolved = round2(manualRate);
        sourcesUsed.add("manual_override");
        subtotalCents += cents(resolved);
        nightQuotes.push({
          date,
          basePrice: basePriceRaw != null ? round2(basePriceRaw) : null,
          basePriceSource,
          parentPlanId: null,
          parentResolvedPrice: null,
          adjustmentValue: null,
          adjustmentSource: null,
          overridePrice: null,
          resolvedPlanPrice: resolved,
          priceSource: "manual_override",
          extraGuestAmount: 0,
          nightTotal: resolved,
        });
        continue;
      }

      // THE canonical chain resolution — shared verbatim with the channel ARI
      // projection (src/lib/channel/ari-projection.ts). An empty chain is the
      // base-ARI layer.
      const { resolution, directParentPrice } = resolveChainNightPrice({
        chain: plan ? chain : [],
        date,
        basePrice: basePriceRaw,
        basePriceSource,
        overlayFor: (planId) => (su ? overlayByPlanUnit.get(`${planId}|${su}`) : undefined),
        assignmentFor: (planId) => (su ? assignmentByKey.get(`${planId}|${su}`) : undefined),
      });
      const resolved = resolution.price;
      const parent = chain.length > 1 ? chain[1] : null;
      if (resolved == null || resolved <= 0) {
        priced = false;
        roomErrors.push(err("NO_PRICE_FOR_DATE", { ...ctx, date }));
      }
      if (resolved != null && resolution.source) sourcesUsed.add(resolution.source);

      const nightTotal = resolved != null && resolved > 0 ? round2(resolved + extraPerNight) : null;
      if (nightTotal != null) subtotalCents += cents(nightTotal);
      nightQuotes.push({
        date,
        basePrice: basePriceRaw != null ? round2(basePriceRaw) : null,
        basePriceSource,
        parentPlanId: parent?.id ?? null,
        parentResolvedPrice: directParentPrice,
        adjustmentValue: resolution.adjustmentValue,
        adjustmentSource: resolution.adjustmentSource,
        overridePrice: plan && su ? (overlayByPlanUnit.get(`${plan.id}|${su}`)?.get(date)?.price ?? null) : null,
        resolvedPlanPrice: resolved != null ? round2(resolved) : null,
        priceSource: resolution.source,
        extraGuestAmount: extraPerNight,
        nightTotal,
      });
    }
    if (extraPerStay > 0) subtotalCents += cents(extraPerStay);
    const extraGuestTotal = round2(
      (frequency === "per_night" ? extraPerNight * nights.length : extraPerStay),
    );

    roomQuotes.push({
      roomId: entry.roomId,
      roomNumber: room.room_number,
      roomName: room.name,
      ratePlanId: plan?.id ?? null,
      ratePlanName: plan ? (plan.publicName ?? plan.name) : "מחיר בסיס",
      ratePlanCode: plan?.code ?? "",
      adults: entry.adults, children: entry.children, infants: entry.infants,
      includedOccupancy: room.included_occupancy,
      extraAdults, extraChildren, extraInfants,
      extraGuestSource,
      extraGuestFrequency: frequency,
      extraGuestPerNight: extraPerNight,
      extraGuestPerStay: extraPerStay,
      extraGuestTotal,
      nights: nightQuotes,
      roomSubtotal: priced ? round2(subtotalCents / 100) : 0,
      available,
      valid: roomErrors.length === 0,
      errors: roomErrors,
      warnings: roomWarnings,
      priceSourcesUsed: [...sourcesUsed],
      restrictionsEvaluated,
    });
  }

  // ---- totals (§16): per-room subtotals + one combined total; never averaged ----
  const grossCents = roomQuotes.reduce((acc, r) => acc + cents(r.roomSubtotal), 0);
  const totalGross = round2(grossCents / 100);
  const vatAmount = includedVatAmount(totalGross, vatRate);
  const subtotalNet = round2(totalGross - vatAmount);
  const valid = roomQuotes.length > 0 && roomQuotes.every((r) => r.valid);

  const quoteFingerprint = fingerprintOf({
    tenantId: req.tenantId, currency, vatRate,
    checkIn: req.checkIn, checkOut: req.checkOut,
    egDefaults: {
      cf: egDefaults.charge_frequency, rm: egDefaults.rounding_mode, ri: egDefaults.rounding_increment,
      ico: egDefaults.infants_count_occupancy, iui: egDefaults.infants_use_included,
    },
    rooms: roomQuotes.map((r) => ({
      roomId: r.roomId, planId: r.ratePlanId,
      adults: r.adults, children: r.children, infants: r.infants,
      nights: r.nights.map((n) => ({
        d: n.date, p: n.resolvedPlanPrice, s: n.priceSource, b: n.basePrice, a: n.adjustmentValue,
      })),
      egN: r.extraGuestPerNight, egS: r.extraGuestPerStay, egSrc: r.extraGuestSource,
      subtotal: r.roomSubtotal, valid: r.valid,
      errs: r.errors.map((e) => e.code).sort(),
    })),
  });

  return {
    engineVersion: PRICING_ENGINE_VERSION,
    quoteFingerprint,
    tenantId: req.tenantId,
    currency,
    checkIn: req.checkIn,
    checkOut: req.checkOut,
    numberOfNights: nights.length,
    valid,
    rooms: roomQuotes,
    subtotalNet,
    vatRate,
    vatAmount,
    totalGross,
    priceIncludesVat: true,
    roundingPolicy: ROUNDING_POLICY,
    warnings: [],
    errors: [],
  };
}

function emptyRoomQuote(
  entry: PricingQuoteRequest["rooms"][number],
  errors: PricingError[],
  room?: EngineRoomRow,
  available = false,
): RoomQuote {
  return {
    roomId: entry.roomId,
    roomNumber: room?.room_number ?? "",
    roomName: room?.name ?? null,
    ratePlanId: entry.ratePlanId,
    ratePlanName: "",
    ratePlanCode: "",
    adults: entry.adults, children: entry.children, infants: entry.infants,
    includedOccupancy: room?.included_occupancy ?? null,
    extraAdults: 0, extraChildren: 0, extraInfants: 0,
    extraGuestSource: "unconfigured",
    extraGuestFrequency: "per_night",
    extraGuestPerNight: 0, extraGuestPerStay: 0, extraGuestTotal: 0,
    nights: [],
    roomSubtotal: 0,
    available,
    valid: false,
    errors,
    warnings: [],
    priceSourcesUsed: [],
    restrictionsEvaluated: [],
  };
}
