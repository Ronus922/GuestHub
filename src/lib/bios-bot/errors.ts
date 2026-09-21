import "server-only";
import { NextResponse } from "next/server";
import type { PricingErrorCode } from "@/lib/pricing/types";

// ============================================================
// Phase 5 stable error contract. Every /api/bios-bot/v1/* route returns
// { ok: false, error: { code, message } } using ONLY these codes — GuestHub's
// internal error vocabulary (PricingErrorCode, availability conflict kinds,
// Postgres error codes, thrown Error messages, ...) is translated here and
// never leaks through. No SQL errors, stack traces, table names, secret
// values or raw upstream bodies ever reach this boundary (Phase 5 §22).
//
// TIMEOUT and CONNECTOR_UNAVAILABLE are primarily produced by the BIOS Bot
// connector itself (when it cannot reach this API at all) rather than by
// GuestHub — CONNECTOR_UNAVAILABLE is included here too for the one case
// GuestHub itself can hit it: the service is authenticated but has no
// configured tenant (BIOS_BOT_TENANT_ID unset).
// ============================================================

export type BiosBotErrorCode =
  | "ROOM_NOT_AVAILABLE"
  | "INVALID_DATES"
  | "CAPACITY_EXCEEDED"
  | "MIN_STAY_NOT_MET"
  | "PRICE_CHANGED"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_NOT_MODIFIABLE"
  | "CANCELLATION_NOT_ALLOWED"
  | "IDEMPOTENCY_CONFLICT"
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "FORBIDDEN"
  | "CONNECTOR_UNAVAILABLE"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<BiosBotErrorCode, number> = {
  ROOM_NOT_AVAILABLE: 409,
  INVALID_DATES: 400,
  CAPACITY_EXCEEDED: 422,
  MIN_STAY_NOT_MET: 422,
  PRICE_CHANGED: 409,
  RESERVATION_NOT_FOUND: 404,
  RESERVATION_NOT_MODIFIABLE: 409,
  CANCELLATION_NOT_ALLOWED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VALIDATION_ERROR: 400,
  AUTHENTICATION_ERROR: 401,
  FORBIDDEN: 403,
  CONNECTOR_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

// Thrown by service-layer functions (src/lib/bios-bot/service/*) — routes
// catch this ONE type and translate it; anything else they catch is an
// unexpected defect and becomes INTERNAL_ERROR with no detail leaked.
export class BiosBotError extends Error {
  readonly code: BiosBotErrorCode;
  constructor(code: BiosBotErrorCode, message: string) {
    super(message);
    this.name = "BiosBotError";
    this.code = code;
  }
}

export function biosBotErrorResponse(code: BiosBotErrorCode, message: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: STATUS_BY_CODE[code] });
}

// Route-level catch-all: a BiosBotError is returned as authored; anything
// else (a bug, a DB error that escaped its transaction, ...) becomes a flat
// INTERNAL_ERROR — the message is logged server-side, never returned.
export function toBiosBotErrorResponse(e: unknown, logContext: string): NextResponse {
  if (e instanceof BiosBotError) return biosBotErrorResponse(e.code, e.message);
  console.error(`[bios-bot] ${logContext} failed`, e instanceof Error ? e.message : e);
  return biosBotErrorResponse("INTERNAL_ERROR", "internal error");
}

// PricingErrorCode → the stable external contract. Deliberately a total
// mapping (every branch of the internal union is named) so a new internal
// code added later fails typecheck here instead of silently degrading to
// INTERNAL_ERROR.
export function mapPricingErrorCode(code: PricingErrorCode): BiosBotErrorCode {
  switch (code) {
    case "ROOM_NOT_FOUND":
    case "ROOM_INACTIVE":
    case "ROOM_OUT_OF_ORDER":
    case "ROOM_UNAVAILABLE":
    case "ROOM_CLOSED":
    case "RATE_PLAN_NOT_FOUND":
    case "RATE_PLAN_INACTIVE":
    case "RATE_PLAN_PARENT_INACTIVE":
    case "RATE_PLAN_NOT_ASSIGNED":
    case "RATE_PLAN_OUTSIDE_VALIDITY":
    case "ARRIVAL_DAY_NOT_ALLOWED":
    case "ADVANCE_BOOKING_RULE_FAILED":
    case "NO_PRICE_FOR_DATE":
    case "MAX_STAY_EXCEEDED":
    case "CLOSED_ON_ARRIVAL":
    case "CLOSED_ON_DEPARTURE":
    case "RATE_PLAN_CYCLE":
      // every one of these means "this room cannot be sold for this stay
      // under these terms" — MIN_STAY_NOT_MET is the one restriction code
      // Phase 5 asks to distinguish; the rest share one bucket on purpose.
      return "ROOM_NOT_AVAILABLE";
    case "MIN_STAY_NOT_MET":
      return "MIN_STAY_NOT_MET";
    case "OCCUPANCY_BELOW_MINIMUM":
    case "OCCUPANCY_EXCEEDED":
    case "ADULT_LIMIT_EXCEEDED":
    case "CHILD_LIMIT_EXCEEDED":
    case "INFANT_LIMIT_EXCEEDED":
      return "CAPACITY_EXCEEDED";
    case "ROOM_DUPLICATED":
    case "CURRENCY_MISMATCH":
      return "VALIDATION_ERROR";
    case "INVALID_DATE_RANGE":
    case "QUOTE_WINDOW_EXCEEDED":
      return "INVALID_DATES";
    case "EXTRA_GUEST_PRICING_INCOMPLETE":
    case "MIXED_TENANT_DATA":
      // a property-configuration gap, not something the caller did wrong —
      // never exposed as an actionable customer-facing reason.
      return "INTERNAL_ERROR";
  }
}

// checkRoomAvailability() conflicts (any kind: room_missing, room_status,
// reservation, closure) → the same ROOM_NOT_AVAILABLE bucket, on purpose. A
// BIOS Bot caller never learns WHY a room can't be booked, only that it
// can't.
export function mapAvailabilityConflict(): BiosBotErrorCode {
  return "ROOM_NOT_AVAILABLE";
}
