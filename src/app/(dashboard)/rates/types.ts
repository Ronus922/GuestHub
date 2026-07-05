import type { DateOnly } from "@/lib/dates";
import type { SellReason } from "@/lib/rates/rules";

export type { SellReason } from "@/lib/rates/rules";

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
  // The single explicit reason this cell is / isn't sellable (Step 2).
  sellReason: SellReason;
};

// Hebrew hover/detail text per reason — the exact cause shown in the tooltip.
export const SELL_REASON_TEXT: Record<SellReason, string> = {
  SELLABLE: "ניתן למכירה",
  COMMERCIAL_STOP_SELL: "סגור למכירה — ניתן לפתוח מרשת התעריפים",
  PHYSICAL_INVENTORY_ZERO: "לא ניתן למכירה — אין מלאי פיזי",
  ROOM_INACTIVE: "לא ניתן למכירה — החדר מושבת",
  ROOM_OUT_OF_ORDER: "לא ניתן למכירה — החדר מושבת (תקלה)",
  PHYSICAL_BLOCK: "לא ניתן למכירה — קיימת חסימה פיזית",
  RESERVED: "לא ניתן למכירה — קיימת הזמנה פעילה",
  NO_ACTIVE_RATE_PLAN: "לא ניתן למכירה — אין תוכנית תמחור פעילה",
  MISSING_EFFECTIVE_PRICE: "לא ניתן למכירה — חסר מחיר אפקטיבי",
  INVALID_EFFECTIVE_PRICE: "לא ניתן למכירה — מחיר לא תקין",
  MAPPING_ERROR: "שגיאת מיפוי — אין חדר משויך ליחידת המכירה",
};

// Visual grouping → the price-cell state class. Keeps physical (hatch),
// commercial stop-sell (red), missing-price (amber), and mapping/config error
// (error box) visually DISTINCT so unrelated causes never look the same.
export type SellReasonKind = "ok" | "commercial" | "physical" | "price" | "error";
export const SELL_REASON_KIND: Record<SellReason, SellReasonKind> = {
  SELLABLE: "ok",
  COMMERCIAL_STOP_SELL: "commercial",
  PHYSICAL_INVENTORY_ZERO: "physical",
  ROOM_INACTIVE: "physical",
  ROOM_OUT_OF_ORDER: "physical",
  PHYSICAL_BLOCK: "physical",
  RESERVED: "physical",
  NO_ACTIVE_RATE_PLAN: "error",
  MISSING_EFFECTIVE_PRICE: "price",
  INVALID_EFFECTIVE_PRICE: "price",
  MAPPING_ERROR: "error",
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
