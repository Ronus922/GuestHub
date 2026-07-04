import type { DateOnly } from "@/lib/dates";

// Shared, client-safe types for the Rate Grid / Group Update UI. The server read
// model (src/lib/rates/grid-state.ts) produces these; client components consume
// them. Kept out of the server-only module so both sides can import them.

// One (SellableUnit, date) cell — editable commercial vs read-only physical/derived.
export type RateCellState = {
  date: DateOnly;
  price: number | null;
  minStayThrough: number | null;
  minStayArrival: number | null;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
  hasRow: boolean;
  effectivePrice: number;
  priceSource: "explicit" | "inherited";
  totalRooms: number;
  sellableRooms: number;
  occupiedRooms: number;
  closedRooms: number;
  availability: number;
  sellable: boolean;
};

export type RateGridUnit = {
  sellableUnitId: string;
  pricingPlanId: string | null;
  code: string;
  name: string;
  isPooled: boolean;
  roomCount: number;
  roomTypeId: string | null;
  roomTypeName: string | null;
  basePrice: number;
  hasBasePlan: boolean;
  // Count of dates in the visible window this unit is commercially closed
  // (stop_sell) — the reference "N סגורים" descriptor badge.
  closedCount: number;
  cells: RateCellState[];
};

export type RateGridType = {
  roomTypeId: string | null;
  roomTypeName: string;
  basePrice: number;
  unitIds: string[];
  units: RateGridUnit[];
};

export type RateGridState = {
  from: DateOnly;
  toInclusive: DateOnly;
  dates: DateOnly[];
  types: RateGridType[];
  unitCount: number;
  typeCount: number;
};

// Which capabilities the current actor has (drives read-only vs editable UI).
export type RateCan = {
  edit: boolean; // rates.edit → direct cell editing
  bulk: boolean; // rates.bulk_update → Group Update
};

// Date-window presets (mirror the reference: שבועיים / חודש).
export type RateView = "2w" | "month";
export const RATE_VIEW_DAYS: Record<RateView, number> = { "2w": 14, month: 30 };

// The seven editable commercial fields, in the reference row order.
export const COMMERCIAL_FIELDS = [
  "price",
  "minStayThrough",
  "maxStay",
  "minStayArrival",
  "closedToArrival",
  "closedToDeparture",
  "stopSell",
] as const;
export type CommercialField = (typeof COMMERCIAL_FIELDS)[number];
