import type { DateOnly } from "@/lib/dates";
import type { PaymentState, RateRow } from "@/lib/inventory-rules";

export type CalendarView = "week" | "3w" | "month";
export const VIEW_DAYS: Record<CalendarView, number> = { week: 7, "3w": 21, month: 30 };

export type CalendarRoom = {
  id: string;
  room_number: string;
  name: string | null;
  floor: string | null;
  status: string; // available | inactive | out_of_order | maintenance
  is_active: boolean;
  room_type_id: string | null;
  room_type_name: string | null;
  area_name: string | null;
  base_price: number;
  max_occupancy: number;
};

// One card per reservation-room assignment (locked per-room model, §C) —
// multi-room reservations share reservation_id.
export type CalendarStay = {
  rr_id: string;
  reservation_id: string;
  room_id: string;
  check_in: DateOnly;
  check_out: DateOnly;
  adults: number;
  children: number;
  infants: number;
  status: string;
  reservation_number: string;
  guest_name: string; // per-room guest if set, else primary guest
  is_vip: boolean;
  source_label: string | null;
  total_price: number;
  paid_amount: number;
  payment: PaymentState;
  room_count: number; // rooms in the shared reservation
};

export type CalendarClosure = {
  id: string;
  room_id: string;
  start_date: DateOnly;
  end_date: DateOnly;
  reason: string | null;
};

// Active room-type-level inventory hold (future unassigned OTA booking, §R).
export type CalendarHold = {
  id: string;
  room_type_id: string;
  room_type_name: string | null;
  check_in: DateOnly;
  check_out: DateOnly;
  rooms_count: number;
  guest_name: string | null;
};

export type CalendarKpis = {
  arrivalsToday: number;
  departuresToday: number;
  guestsInHouse: number;
  occupiedToday: number;
  sellableToday: number;
  occupancyPct: number; // 0–100
  occupancyDeltaPct: number; // vs yesterday
};

export type CalendarData = {
  today: DateOnly;
  from: DateOnly;
  days: number;
  rooms: CalendarRoom[];
  stays: CalendarStay[];
  closures: CalendarClosure[];
  holds: CalendarHold[];
  rates: RateRow[];
  kpis: CalendarKpis;
  currency: string;
};

export type ActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string };
