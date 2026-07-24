import type { DateOnly } from "@/lib/dates";

// ============================================================
// Shared ARI interchange types (D68/D78). Provider-neutral: the canonical
// availability/commercial projection a channel adapter turns into its own
// outbound calendar shape. The Beds24 projection (beds24-ari-projection.ts)
// produces these; beds24-ari-payloads consumes them. No I/O, no pricing rule of
// its own lives here — only the type contract.
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
  availability: number; // 0 | 1 — one channel room maps to one physical room
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

// The per-run summary every provider drain returns to the worker.
export type DrainSummary = {
  claimed: number;
  synced: number;
  retried: number;
  failed: number;
  requests: number;
  sentValues: number;
  /** §16 — true when the circuit breaker skipped this connection (still cooling) */
  circuitOpen?: boolean;
  /** P0-4 — set when the Beds24 credit window (or a 429) stopped the drain early */
  creditPausedMs?: number;
};
