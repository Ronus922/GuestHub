// ============================================================
// Physical-room → Channex Room Type sync — PURE logic (D64). No IO, no fetch,
// no secrets. Exported pure so scripts/check-channex-room-types.mjs asserts it
// without a DB or a live socket.
//
// THE MODEL: the Channex inventory mapping unit is the individual PHYSICAL
// GuestHub room. One physical room → one Channex Room Type → count_of_rooms = 1.
// The 3 GuestHub room_types (סטודיו / סוויטה / חדר שינה וסלון) are DESCRIPTIVE
// metadata; they are never mapped as Channex inventory.
//
// count_of_rooms = 1 means "this Room Type contains one physical unit". It says
// nothing about date availability: Channex documents that "Availability of all
// rooms created will be defaulted to 0" until the Availability & Rates (ARI) API
// is used. Nothing here pushes availability.
// ============================================================

// ---- occupancy semantics ----
//
// Channex (docs.channex.io/api-v.1-documentation/room-types-collection), verbatim:
//   occ_adults        "How many Adult bed spaces have in this Room Type."
//   occ_children      "How many Child only bed spaces in this Room Type. Children
//                      can sleep in adult beds also. If no Child only beds then
//                      set this to 0."
//   occ_infants       "How many Infants cots available in this Room Type."
//   default_occupancy "Any positive integer number lower or equal to occ_adults."
//
// GuestHub (db/migrations/000_init_schema.sql + 012 + 014), on guesthub.rooms:
//   max_occupancy     total guests the room holds
//   max_adults        adult capacity
//   max_children      MAXIMUM CHILDREN ALLOWED — not child-only bed spaces
//   max_infants       infant/cot capacity
//   default_occupancy תפוסת ברירת מחדל (nullable = unset)
//
// EVIDENCE that max_children is "children allowed", not child-only beds: in the
// live tenant 5 of 13 rooms have max_adults == max_occupancy AND max_children > 0
// (e.g. 1006: total 4, adults 4, children 2; 1329: total 6, adults 6, children 4),
// and 6 rooms have max_adults + max_children > max_occupancy. If max_children
// were extra child-only beds, those rooms would hold more guests than their own
// max_occupancy. So max_children is a cap on how many of the existing beds may be
// occupied by children — it is NEVER copied to occ_children.
//
// Child-only bed spaces are therefore derived, never invented:
//     occ_children = clamp(max_occupancy - max_adults, 0, max_children)
// i.e. the beds that remain once every adult bed space is counted, capped by the
// maximum children the room allows. This can never push occ_adults + occ_children
// above max_occupancy, and never fabricates capacity GuestHub does not record.

export const MAX_TITLE_LENGTH = 255; // Channex: "maximum length of 255 symbols"
export const COUNT_OF_ROOMS = 1; // one physical unit per Room Type — always

export type RoomOccupancySource = {
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
  default_occupancy: number | null;
};

export type ChannexOccupancy = {
  occ_adults: number;
  occ_children: number;
  occ_infants: number;
  default_occupancy: number;
  // true when GuestHub's default_occupancy exceeded occ_adults and was reduced to
  // it (Channex forbids default_occupancy > occ_adults). Surfaced in the preview —
  // never applied silently, and never written back to GuestHub.
  defaultOccupancyCapped: boolean;
  sourceDefaultOccupancy: number;
};

export type OccupancyErrorCode =
  | "total_invalid"
  | "adults_invalid"
  | "adults_exceed_total"
  | "negative_capacity"
  | "default_missing"
  | "default_invalid";

export type OccupancyResult =
  | { ok: true; occ: ChannexOccupancy }
  | { ok: false; code: OccupancyErrorCode; message: string };

const OCCUPANCY_MESSAGE: Record<OccupancyErrorCode, string> = {
  total_invalid: "תפוסה מקסימלית חייבת להיות לפחות 1",
  adults_invalid: "מספר המבוגרים המקסימלי חייב להיות לפחות 1",
  adults_exceed_total: "מספר המבוגרים גדול מהתפוסה המקסימלית — הנתונים סותרים",
  negative_capacity: "ערכי תפוסה שליליים אינם חוקיים",
  default_missing: "תפוסת ברירת מחדל לא הוגדרה לחדר — יש להשלים אותה במסך החדרים",
  default_invalid: "תפוסת ברירת מחדל חייבת להיות לפחות 1",
};

const occFail = (code: OccupancyErrorCode): OccupancyResult => ({
  ok: false,
  code,
  message: OCCUPANCY_MESSAGE[code],
});

// The ONE deterministic conversion. Never negative, never above GuestHub's total
// capacity, never default_occupancy > occ_adults, never invents capacity. An
// ambiguous or incomplete room is BLOCKED rather than guessed at.
export function deriveChannexOccupancy(room: RoomOccupancySource): OccupancyResult {
  const { max_occupancy: total, max_adults: adults, max_children: children, max_infants: infants } = room;

  if (![total, adults, children, infants].every(Number.isInteger)) return occFail("negative_capacity");
  if (children < 0 || infants < 0) return occFail("negative_capacity");
  if (!Number.isInteger(total) || total < 1) return occFail("total_invalid");
  if (!Number.isInteger(adults) || adults < 1) return occFail("adults_invalid");
  // adult beds cannot exceed the room's own total capacity — that record is
  // self-contradictory and no safe adult/child split can be determined.
  if (adults > total) return occFail("adults_exceed_total");

  const src = room.default_occupancy;
  if (src === null || src === undefined) return occFail("default_missing");
  if (!Number.isInteger(src) || src < 1) return occFail("default_invalid");

  const occ_adults = adults;
  const occ_children = Math.max(0, Math.min(total - adults, children));
  const occ_infants = infants;
  const default_occupancy = Math.min(src, occ_adults);

  return {
    ok: true,
    occ: {
      occ_adults,
      occ_children,
      occ_infants,
      default_occupancy,
      defaultOccupancyCapped: default_occupancy !== src,
      sourceDefaultOccupancy: src,
    },
  };
}

// ---- title ----
// Exactly "חדר <room_number> - <GuestHub room type name>". A normal hyphen with a
// space on each side. No tenant id, no database id, no building, no floor, no
// "GuestHub", no "Staging".
export const TITLE_SEPARATOR = " - ";
export const TITLE_PREFIX = "חדר ";

export type TitleErrorCode = "room_number_missing" | "room_type_missing" | "title_too_long";

export type TitleResult =
  | { ok: true; title: string }
  | { ok: false; code: TitleErrorCode; message: string };

const TITLE_MESSAGE: Record<TitleErrorCode, string> = {
  room_number_missing: "לחדר אין מספר חדר",
  room_type_missing: "לחדר לא משויך סוג חדר — יש להשלים אותו במסך החדרים",
  title_too_long: `שם סוג החדר ב-Channex חורג מ-${MAX_TITLE_LENGTH} תווים`,
};

export function buildRoomTypeTitle(
  roomNumber: string | null,
  roomTypeName: string | null,
): TitleResult {
  const num = (roomNumber ?? "").trim();
  const type = (roomTypeName ?? "").trim();
  if (!num) return { ok: false, code: "room_number_missing", message: TITLE_MESSAGE.room_number_missing };
  if (!type) return { ok: false, code: "room_type_missing", message: TITLE_MESSAGE.room_type_missing };
  const title = `${TITLE_PREFIX}${num}${TITLE_SEPARATOR}${type}`;
  if (title.length > MAX_TITLE_LENGTH)
    return { ok: false, code: "title_too_long", message: TITLE_MESSAGE.title_too_long };
  return { ok: true, title };
}

// ---- create payload (§6) ----
// ONLY the documented required attributes plus room_kind. No facilities, photos,
// descriptions, rate plans, rates, restrictions, availability or OTA mappings —
// all of those are optional in the API and are deliberately omitted.
export function buildCreateRoomTypePayload(
  propertyId: string,
  input: { title: string; occ: ChannexOccupancy },
): { room_type: Record<string, unknown> } {
  return {
    room_type: {
      property_id: propertyId,
      title: input.title,
      count_of_rooms: COUNT_OF_ROOMS,
      occ_adults: input.occ.occ_adults,
      occ_children: input.occ.occ_children,
      occ_infants: input.occ.occ_infants,
      default_occupancy: input.occ.default_occupancy,
      room_kind: "room",
    },
  };
}

// ---- preview plan ----
export type SyncRoom = {
  id: string;
  room_number: string;
  room_type_name: string | null;
  area_name: string | null;
  floor: string | null;
  is_active: boolean;
  status: string;
} & RoomOccupancySource;

export type SyncMapping = {
  room_id: string;
  channex_room_type_id: string | null;
  channex_title: string | null;
  status: "creating" | "mapped" | "failed" | "reconciliation_required";
  method: "created" | "adopted" | null;
  external_state: "ok" | "inaccessible" | null;
  last_verified_at: string | null;
  last_error: string | null;
};

export type ExternalRoomType = {
  id: string;
  title: string | null;
  countOfRooms: number | null;
  occAdults: number | null;
  occChildren: number | null;
  occInfants: number | null;
};

// Every state a preview row can be in (§9).
export type RowStatus =
  | "ready"
  | "validation_required"
  | "excluded_inactive"
  | "creating"
  | "mapped"
  | "adopted"
  | "inaccessible"
  | "failed"
  | "reconciliation_required";

export type PreviewRow = {
  roomId: string;
  roomNumber: string;
  roomTypeName: string | null;
  areaName: string | null;
  floor: string | null;
  isActive: boolean;
  roomStatus: string;
  proposedTitle: string | null;
  countOfRooms: number; // always 1
  occ: ChannexOccupancy | null;
  status: RowStatus;
  validationError: string | null;
  channexRoomTypeId: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  // true when the room is a valid, unmapped, active candidate for creation
  creatable: boolean;
};

export type SyncSummary = {
  roomCategories: number; // the 3 descriptive GuestHub categories — NOT inventory
  activeRooms: number;
  inactiveRooms: number;
  validReady: number; // valid + unmapped + active → will be created
  mappedRooms: number;
  unmappedRooms: number; // active rooms without a mapped external room type
  externalRoomTypes: number;
  externalUnmapped: number;
  validationErrors: number;
  reconciliationRequired: number;
};

export type SyncPlan = {
  rows: PreviewRow[];
  summary: SyncSummary;
  externalUnmapped: ExternalRoomType[];
};

function roomNumberKey(rn: string): [number, string] {
  const m = /^\s*(\d+)/.exec(rn ?? "");
  return [m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY, (rn ?? "").toString()];
}

// Numeric-first ordering: "2" < "10" < "10A" < "b".
export function sortByRoomNumber<T extends { roomNumber: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const [an, as] = roomNumberKey(a.roomNumber);
    const [bn, bs] = roomNumberKey(b.roomNumber);
    if (an !== bn) return an - bn;
    return as.localeCompare(bs, "en");
  });
}

// Build the read-only preview. NOTHING here mutates GuestHub or Channex.
// `externalRoomTypes` may be null when the external list has not been fetched
// (page load performs no network call) — external columns then stay unknown.
export function buildSyncPlan(args: {
  rooms: readonly SyncRoom[];
  mappings: readonly SyncMapping[];
  externalRoomTypes: readonly ExternalRoomType[] | null;
  roomCategories: number;
}): SyncPlan {
  const byRoom = new Map(args.mappings.map((m) => [m.room_id, m]));
  const mappedExternalIds = new Set(
    args.mappings.map((m) => m.channex_room_type_id).filter((v): v is string => !!v),
  );

  const rows: PreviewRow[] = args.rooms.map((room) => {
    const m = byRoom.get(room.id);
    const title = buildRoomTypeTitle(room.room_number, room.room_type_name);
    const occ = deriveChannexOccupancy(room);
    const validationError =
      (title.ok === false ? title.message : null) ?? (occ.ok === false ? occ.message : null);

    let status: RowStatus;
    if (!room.is_active) status = "excluded_inactive";
    else if (m?.status === "mapped")
      status = m.external_state === "inaccessible" ? "inaccessible" : m.method === "adopted" ? "adopted" : "mapped";
    else if (m?.status === "creating") status = "creating";
    else if (m?.status === "reconciliation_required") status = "reconciliation_required";
    else if (m?.status === "failed") status = "failed";
    else if (validationError) status = "validation_required";
    else status = "ready";

    return {
      roomId: room.id,
      roomNumber: room.room_number,
      roomTypeName: room.room_type_name,
      areaName: room.area_name,
      floor: room.floor,
      isActive: room.is_active,
      roomStatus: room.status,
      proposedTitle: title.ok ? title.title : null,
      countOfRooms: COUNT_OF_ROOMS,
      occ: occ.ok ? occ.occ : null,
      status,
      validationError,
      channexRoomTypeId: m?.channex_room_type_id ?? null,
      lastVerifiedAt: m?.last_verified_at ?? null,
      lastError: m?.last_error ?? null,
      // an inactive, invalid, already-mapped, in-flight or ambiguous room is never
      // a creation candidate. 'failed' rooms ARE retryable.
      creatable:
        room.is_active && !validationError && (status === "ready" || status === "failed"),
    };
  });

  const sorted = sortByRoomNumber(rows);
  const active = sorted.filter((r) => r.isActive);
  const externalUnmapped = (args.externalRoomTypes ?? []).filter((e) => !mappedExternalIds.has(e.id));

  // Counters read the underlying MAPPING status, not the display status, so they
  // stay honest regardless of how a row happens to render. A 'mapped' row counts
  // as mapped even when external_state='inaccessible' (it holds an external id —
  // it is a mapped room that needs attention, not an unmapped one).
  const activeMapped = active.filter((r) => byRoom.get(r.roomId)?.status === "mapped");
  // reconciliation/creating counts ALL mappings (even a room since deactivated),
  // so a stuck room still blocks a new run and is never a silent "settled".
  const pendingReconcile = args.mappings.filter(
    (m) => m.status === "reconciliation_required" || m.status === "creating",
  );

  return {
    rows: sorted,
    externalUnmapped,
    summary: {
      roomCategories: args.roomCategories,
      activeRooms: active.length,
      inactiveRooms: sorted.length - active.length,
      validReady: sorted.filter((r) => r.creatable).length,
      mappedRooms: activeMapped.length,
      unmappedRooms: active.length - activeMapped.length,
      externalRoomTypes: args.externalRoomTypes?.length ?? 0,
      externalUnmapped: externalUnmapped.length,
      validationErrors: active.filter((r) => r.validationError).length,
      reconciliationRequired: pendingReconcile.length,
    },
  };
}

// ---- durable job identity (§12) ----
// tenant + provider + environment are all encoded by connection_id, which is
// UNIQUE (tenant_id, provider, environment). The key still names the property and
// the operation explicitly so a property remap can never collide with old jobs.
export function roomTypeJobKey(propertyId: string, roomId: string): string {
  return `channex:room_type:create:${propertyId}:${roomId}`;
}
export function roomTypeSyncJobKey(propertyId: string): string {
  return `channex:room_type:sync:${propertyId}`;
}

// ---- external verification (§14) ----
export type VerificationDrift = { field: string; expected: string; actual: string };

// Compare a mapped external room type against what GuestHub expects. Reports
// drift; NEVER mutates the external entity and never rewrites GuestHub.
export function verifyExternalRoomType(
  expected: { title: string; occ: ChannexOccupancy },
  actual: ExternalRoomType,
): VerificationDrift[] {
  const out: VerificationDrift[] = [];
  const cmp = (field: string, e: number | string, a: number | string | null) => {
    if (a === null || a === undefined) return; // not surfaced by the API — not drift
    if (String(e) !== String(a)) out.push({ field, expected: String(e), actual: String(a) });
  };
  cmp("title", expected.title, actual.title);
  cmp("count_of_rooms", COUNT_OF_ROOMS, actual.countOfRooms);
  cmp("occ_adults", expected.occ.occ_adults, actual.occAdults);
  cmp("occ_children", expected.occ.occ_children, actual.occChildren);
  cmp("occ_infants", expected.occ.occ_infants, actual.occInfants);
  return out;
}
