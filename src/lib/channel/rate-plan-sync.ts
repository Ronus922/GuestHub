// ============================================================
// PURE rate-plan sync logic (D65) — no I/O, no network, no DB. Everything here
// is deterministic and unit-tested by scripts/check-channex-rate-plans.mjs.
//
// MODEL: the local GuestHub Rate Plan is defined ONCE (tenant-scoped
// pricing_plans row, e.g. "ללא דמי ביטול") and is never duplicated locally.
// Each Channex Rate Plan belongs to one Channex Room Type = one physical room
// (D64), so the required external set is the Cartesian product:
//     active local Rate Plans × active mapped physical rooms.
// The count is always CALCULATED — never hardcoded to 13.
//
// SELL MODE (decision + evidence): GuestHub nightly pricing is
//     base price (per unit per date) + extra-guest fee × chargeable guests
//     beyond rooms.included_occupancy (src/lib/pricing/engine.ts §11 —
//     "included_occupancy is the extra-guest threshold, default_occupancy is
//     NEVER used for charging"; fees from tenants.settings.extra_guest,
//     ₪200/night flat, charge_frequency=per_night),
// i.e. the nightly total varies deterministically with adult occupancy
// (occupancies at or below included_occupancy price at base). That is exactly
// Channex sell_mode=per_person: one option per possible adult count
// 1..occ_adults of the mapped Room Type, primary at included_occupancy — the
// occupancy whose price IS the base price. per_room would silently lose the
// additional-adult pricing, so it is not used. A room without
// included_occupancy fails closed in the engine (EXTRA_GUEST_PRICING_
// INCOMPLETE) and is blocked here for the same reason — never guessed.
//
// CHILD/INFANT FEES: GuestHub charges extra_child/extra_infant only for guests
// BEYOND the included occupancy; Channex children_fee/infant_fee are flat
// per-child/per-infant surcharges. The semantics differ, so no fee is fabricated
// here — child/infant channel pricing stays pending until the ARI milestone.
//
// SAFETY AT CREATION: every plan is created with rate_mode=manual, a zero
// default rate on every occupancy option and stop_sell enabled for all seven
// weekdays — nothing becomes sellable before the first verified ARI snapshot.
// ============================================================

export type LocalRatePlan = {
  id: string;
  name: string;
  is_active: boolean;
  is_archived: boolean;
  is_visible_channels: boolean;
};

export type RatePlanRoom = {
  roomId: string;
  roomNumber: string;
  isActive: boolean;
  /** rooms.included_occupancy — the occupancy included in the base price (the
   *  extra-guest threshold). The pricing engine charges extras beyond it. */
  includedOccupancy: number | null;
  /** D64 mapping state for this room */
  mappingStatus: string | null;
  channexRoomTypeId: string | null;
  /** occ_adults of the mapped Channex Room Type (from the verified snapshot) */
  roomTypeOccAdults: number | null;
};

export type RateMapping = {
  room_id: string;
  local_rate_plan_id: string;
  channex_rate_plan_id: string | null;
  status: string; // creating | mapped | failed | reconciliation_required
  /** stored external title snapshot — drives rename-mismatch detection */
  channex_title: string | null;
};

export const SELL_MODE = "per_person" as const;
export const RATE_MODE = "manual" as const;
// Channex weekday-default restriction: closed for sale every day of the week
// until the first verified ARI snapshot opens it deliberately.
export const STOP_SELL_ALL_WEEK: boolean[] = [true, true, true, true, true, true, true];

// ---- titles ----
// Exact external format: "חדר <room_number> - <local plan title>". Plain hyphen
// with spaces; no GuestHub/Staging/tenant/UUID/floor/building. Channex caps
// titles at 255 symbols.
export const TITLE_MAX = 255;

export function buildRatePlanTitle(
  roomNumber: string,
  planName: string,
): { ok: true; title: string } | { ok: false; message: string } {
  const num = (roomNumber ?? "").trim();
  const plan = (planName ?? "").trim();
  if (!num) return { ok: false, message: "לחדר אין מספר" };
  if (!plan) return { ok: false, message: "לתוכנית התעריף אין שם" };
  const title = `חדר ${num} - ${plan}`;
  if (title.length > TITLE_MAX)
    return { ok: false, message: `שם התוכנית ארוך מ-${TITLE_MAX} תווים` };
  return { ok: true, title };
}

// ---- occupancy options ----
// per_person: one option for EVERY possible adult count 1..occ_adults of the
// mapped Channex Room Type — never above it, never zero, never duplicated,
// exactly one primary. The primary is rooms.included_occupancy (the occupancy
// whose nightly price IS the base price — engine.ts §11), capped into the valid
// range (Channex forbids a primary above occ_adults).
export type OccupancyOption = { occupancy: number; is_primary: boolean; rate: number };

export function buildOccupancyOptions(
  roomTypeOccAdults: number,
  includedOccupancy: number | null,
):
  | { ok: true; options: OccupancyOption[]; primary: number; primaryCapped: boolean }
  | { ok: false; message: string } {
  if (!Number.isInteger(roomTypeOccAdults) || roomTypeOccAdults < 1)
    return { ok: false, message: "לסוג החדר ב-Channex אין קיבולת מבוגרים תקינה" };
  // Same fail-closed rule as the pricing engine (EXTRA_GUEST_PRICING_INCOMPLETE):
  // without the included-occupancy threshold there is no deterministic primary.
  if (includedOccupancy === null)
    return { ok: false, message: "אורחים הכלולים במחיר הבסיס טרם הוגדרו לחדר" };
  if (!Number.isInteger(includedOccupancy) || includedOccupancy < 1)
    return { ok: false, message: "מספר האורחים הכלולים במחיר הבסיס אינו תקין" };
  const primary = Math.min(includedOccupancy, roomTypeOccAdults);
  const options: OccupancyOption[] = [];
  for (let occ = 1; occ <= roomTypeOccAdults; occ++) {
    // rate 0 = placeholder, NOT a real GuestHub price; the plan is stop-sold.
    options.push({ occupancy: occ, is_primary: occ === primary, rate: 0 });
  }
  return { ok: true, options, primary, primaryCapped: primary !== includedOccupancy };
}

// ---- create payload ----
// ONLY structure + safety. rate_mode=manual, zero default rates, stop_sell on
// all 7 weekdays. No children_fee/infant_fee (never fabricated), no meal type,
// no parent plan, no inheritance, no real prices, no availability.
export function buildCreateRatePlanPayload(args: {
  propertyId: string;
  roomTypeId: string;
  title: string;
  currency: string;
  options: OccupancyOption[];
}): { rate_plan: Record<string, unknown> } {
  return {
    rate_plan: {
      property_id: args.propertyId,
      room_type_id: args.roomTypeId,
      title: args.title,
      currency: args.currency,
      sell_mode: SELL_MODE,
      rate_mode: RATE_MODE,
      options: args.options.map((o) => ({ ...o })),
      stop_sell: [...STOP_SELL_ALL_WEEK],
    },
  };
}

// ---- combinations ----
export type ComboStatus =
  | "ready"
  | "validation_required"
  | "creating"
  | "mapped"
  | "failed"
  | "reconciliation_required";

export type ComboRow = {
  roomId: string;
  roomNumber: string;
  localRatePlanId: string;
  localRatePlanName: string;
  channexRoomTypeId: string | null;
  proposedTitle: string | null;
  status: ComboStatus;
  validationError: string | null;
  channexRatePlanId: string | null;
  creatable: boolean;
};

export type ComboPlan = {
  rows: ComboRow[];
  summary: {
    activePlans: number;
    mappedRooms: number;
    requiredCombinations: number;
    mappedCombinations: number;
    creatable: number;
    validationErrors: number;
    reconciliationRequired: number;
    failed: number;
  };
};

// A local plan participates only when it is active, not archived and marked
// visible to channels; a room participates only when it is active AND its D64
// Room Type mapping is complete ('mapped'). Inactive/unmapped/invalid records
// never reach the Cartesian product.
export function eligiblePlans(plans: LocalRatePlan[]): LocalRatePlan[] {
  return plans.filter((p) => p.is_active && !p.is_archived && p.is_visible_channels);
}

export function eligibleRooms(rooms: RatePlanRoom[]): RatePlanRoom[] {
  return rooms.filter((r) => r.isActive && r.mappingStatus === "mapped" && !!r.channexRoomTypeId);
}

export function buildComboPlan(args: {
  plans: LocalRatePlan[];
  rooms: RatePlanRoom[];
  rateMappings: RateMapping[];
}): ComboPlan {
  const plans = eligiblePlans(args.plans);
  const rooms = sortByRoomNumber(eligibleRooms(args.rooms));
  const byCombo = new Map(args.rateMappings.map((m) => [`${m.room_id}:${m.local_rate_plan_id}`, m]));

  // Channex titles must be unique per property; two local plans sharing a name
  // would collide on every room. Such combos are blocked, never guessed around.
  const nameCount = new Map<string, number>();
  for (const p of plans) {
    const key = p.name.trim();
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }

  const rows: ComboRow[] = [];
  for (const plan of plans) {
    for (const room of rooms) {
      const mapping = byCombo.get(`${room.roomId}:${plan.id}`) ?? null;
      const title =
        (nameCount.get(plan.name.trim()) ?? 0) > 1
          ? ({ ok: false, message: "שם תוכנית התעריף אינו ייחודי — יש לתת שם שונה לכל תוכנית" } as const)
          : buildRatePlanTitle(room.roomNumber, plan.name);
      const occ =
        room.roomTypeOccAdults === null
          ? ({ ok: false, message: "לסוג החדר הממופה אין קיבולת מבוגרים ידועה" } as const)
          : buildOccupancyOptions(room.roomTypeOccAdults, room.includedOccupancy);
      const validationError =
        (title.ok === false ? title.message : null) ?? (occ.ok === false ? occ.message : null);

      let status: ComboStatus;
      if (mapping && mapping.status !== "failed") status = mapping.status as ComboStatus;
      else if (validationError) status = "validation_required";
      else if (mapping) status = "failed";
      else status = "ready";

      rows.push({
        roomId: room.roomId,
        roomNumber: room.roomNumber,
        localRatePlanId: plan.id,
        localRatePlanName: plan.name,
        channexRoomTypeId: room.channexRoomTypeId,
        proposedTitle: title.ok ? title.title : null,
        status,
        validationError,
        channexRatePlanId: mapping?.channex_rate_plan_id ?? null,
        creatable: !validationError && (status === "ready" || status === "failed"),
      });
    }
  }

  return {
    rows,
    summary: {
      activePlans: plans.length,
      mappedRooms: rooms.length,
      requiredCombinations: rows.length,
      mappedCombinations: rows.filter((r) => r.status === "mapped").length,
      creatable: rows.filter((r) => r.creatable).length,
      validationErrors: rows.filter((r) => r.validationError !== null).length,
      reconciliationRequired: rows.filter(
        (r) => r.status === "reconciliation_required" || r.status === "creating",
      ).length,
      failed: rows.filter((r) => r.status === "failed").length,
    },
  };
}

export function sortByRoomNumber<T extends { roomNumber: string }>(rooms: T[]): T[] {
  return [...rooms].sort((a, b) => {
    const na = Number(a.roomNumber);
    const nb = Number(b.roomNumber);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;
    if (bNum) return 1;
    return a.roomNumber.localeCompare(b.roomNumber, "he");
  });
}

// ---- title synchronization (external rename after a LOCAL plan rename) ----
// The canonical name lives on the local pricing_plans row; the external title
// must follow it. A mapped combination whose stored external title differs from
// the CURRENT canonical "חדר <num> - <plan>" needs a title update — derived
// dynamically for ANY renamed plan, any room set: no old name, no new name, no
// count, no plan id and no external UUID is ever hardcoded.
export type TitleMismatch = {
  roomId: string;
  roomNumber: string;
  localRatePlanId: string;
  localRatePlanName: string;
  channexRatePlanId: string;
  channexRoomTypeId: string | null;
  currentTitle: string | null;
  expectedTitle: string;
};

export function titleMismatches(
  plan: ComboPlan,
  mappings: Pick<RateMapping, "room_id" | "local_rate_plan_id" | "channex_title">[],
): TitleMismatch[] {
  const titleByCombo = new Map(
    mappings.map((m) => [`${m.room_id}:${m.local_rate_plan_id}`, m.channex_title ?? null]),
  );
  const out: TitleMismatch[] = [];
  for (const row of plan.rows) {
    // only live, already-created combinations with a valid canonical title —
    // creation gaps belong to the create flow, never to a rename
    if (row.status !== "mapped" || !row.channexRatePlanId || !row.proposedTitle) continue;
    const current = titleByCombo.get(`${row.roomId}:${row.localRatePlanId}`) ?? null;
    if (current === row.proposedTitle) continue;
    out.push({
      roomId: row.roomId,
      roomNumber: row.roomNumber,
      localRatePlanId: row.localRatePlanId,
      localRatePlanName: row.localRatePlanName,
      channexRatePlanId: row.channexRatePlanId,
      channexRoomTypeId: row.channexRoomTypeId,
      currentTitle: current,
      expectedTitle: row.proposedTitle,
    });
  }
  return out;
}

// Channex documents Update Rate Plan as taking the SAME fields as Create — a
// title-only partial body is never assumed to be supported. The update payload
// therefore ECHOES the freshly-GET external plan: every documented rate-plan
// field present upstream is sent back byte-for-byte; ONLY the title changes.
// Keys the external plan does not carry are omitted, never fabricated.
const RATE_PLAN_ECHO_FIELDS = [
  "property_id",
  "room_type_id",
  "parent_rate_plan_id",
  "currency",
  "sell_mode",
  "rate_mode",
  "options",
  "children_fee",
  "infant_fee",
  "meal_type",
  "tax_set_id",
  "stop_sell",
  "closed_to_arrival",
  "closed_to_departure",
  "min_stay_arrival",
  "min_stay_through",
  "max_stay",
  "max_sell",
  "max_availability",
  "availability_offset",
  "inherit_rate",
  "inherit_closed_to_arrival",
  "inherit_closed_to_departure",
  "inherit_stop_sell",
  "inherit_min_stay_arrival",
  "inherit_min_stay_through",
  "inherit_max_stay",
  "inherit_max_sell",
  "inherit_max_availability",
  "inherit_availability_offset",
  "auto_rate_settings",
] as const;

export function buildTitleUpdatePayload(args: {
  /** raw `attributes` of the fresh GET — echoed, never stored or logged */
  attributes: Record<string, unknown>;
  /** ids resolved from relationships when attributes omit them (JSON:API) */
  propertyId: string;
  roomTypeId: string;
  title: string;
}): { rate_plan: Record<string, unknown> } {
  const rate_plan: Record<string, unknown> = {};
  for (const key of RATE_PLAN_ECHO_FIELDS) {
    if (args.attributes[key] !== undefined) rate_plan[key] = args.attributes[key];
  }
  // JSON:API GETs may carry these only under relationships — always present
  rate_plan.property_id = rate_plan.property_id ?? args.propertyId;
  rate_plan.room_type_id = rate_plan.room_type_id ?? args.roomTypeId;
  rate_plan.title = args.title; // the ONE change
  return { rate_plan };
}

// ---- durable job identity ----
// tenant+provider+environment are encoded by connection_id (UNIQUE per tenant/
// provider/environment); property, local plan, room and operation are explicit.
export function ratePlanJobKey(propertyId: string, planId: string, roomId: string): string {
  return `channex:rate_plan:create:${propertyId}:${planId}:${roomId}`;
}
export function ratePlanSyncJobKey(propertyId: string): string {
  return `channex:rate_plan:sync:${propertyId}`;
}
export function ratePlanTitleSyncJobKey(propertyId: string): string {
  return `channex:rate_plan:title_sync:${propertyId}`;
}
