// ============================================================
// Beds24 Booking.com reporting client (D96) — the ONLY module that sends a
// status report to Booking.com. Sibling of beds24-ari.ts: same shared,
// leak-proof core in ./beds24-http (single attempt, bounded timeout, fixed safe
// Hebrew messages, token never echoed), same "2xx-with-errors" doctrine.
//
// SCOPE: POST /channels/booking ONLY. It never reads bookings, never touches
// authentication, never DELETEs, and never sees a card.
//
// THE PROVIDER CONTRACT (apiV2.yaml, POST /channels/booking — "Alpha - Perform
// actions at Booking.com"). The request body is an ARRAY of objects with
// EXACTLY two fields:
//     [{ "bookingId": <integer>, "action": <enum> }]
// enum = reportInvalidCard | reportNoShow | reportCancel. Nothing else exists
// in the schema — no fee-waiver field, no reason, no note. An undocumented
// field is a guess, and a guess is never sent.
// The response is 201 with an ARRAY of multiplePostResponse
// ({success, new, modified, errors[{action,field,message}], warnings[…]}) — the
// same envelope the calendar POST already answers with, so the 2xx-with-errors
// trap is handled identically: ANY success:false ⇒ the report FAILED.
//
// LOCAL vs WIRE vocabulary is kept explicit on purpose. The operator's action
// `cancel_due_invalid_card` is the wire action `reportCancel`; the local name
// carries the intent (we are cancelling BECAUSE the card was invalid), the wire
// name is what Booking.com understands. The mapping lives here and only here.
//
// CREDITS: metered by beds24-http like every other call; the remaining
// 5-minute-window counter rides along for observability, never control flow.
// ============================================================

import {
  beds24Request, beds24Fail, mapErrorStatus,
  type Beds24ApiFailure,
} from "./beds24-http";
import { asObj, asInt, asStr } from "./channel-http";
import type { BookingReportAction } from "./booking-com-report-rules";

/** The provider's enum, verbatim. Local → wire; the ONLY place this mapping exists. */
const WIRE_ACTION: Record<BookingReportAction, "reportInvalidCard" | "reportNoShow" | "reportCancel"> = {
  invalid_card: "reportInvalidCard",
  cancel_due_invalid_card: "reportCancel",
  no_show: "reportNoShow",
};

export function wireActionFor(action: BookingReportAction): string {
  return WIRE_ACTION[action];
}

/**
 * Allow-listed structural extract of the provider envelope, persisted to
 * booking_channel_reports.response. Never a raw upstream body: only the
 * documented multiplePostResponse fields survive, strings are truncated, and
 * any other key the provider might add is dropped on the floor.
 */
export type BookingReportEnvelope = {
  httpStatus: number;
  items: {
    success: boolean | null;
    new: number | null;
    modified: number | null;
    errors: { action: string | null; field: string | null; message: string | null }[];
    warnings: { action: string | null; field: string | null; message: string | null }[];
  }[];
};

const MAX_MESSAGE = 300;
const trunc = (v: unknown): string | null => {
  const s = asStr(v);
  return s === null ? null : s.slice(0, MAX_MESSAGE);
};

function extractNotices(v: unknown): BookingReportEnvelope["items"][number]["errors"] {
  if (!Array.isArray(v)) return [];
  const out: BookingReportEnvelope["items"][number]["errors"] = [];
  for (const item of v.slice(0, 20)) {
    const o = asObj(item);
    if (!o) continue;
    out.push({ action: trunc(o.action), field: trunc(o.field), message: trunc(o.message) });
  }
  return out;
}

export function extractBookingReportEnvelope(
  httpStatus: number,
  body: unknown,
): BookingReportEnvelope {
  const raw: unknown[] = Array.isArray(body) ? body : body !== undefined ? [body] : [];
  const items = raw.slice(0, 20).map((item) => {
    const o = asObj(item);
    return {
      success: typeof o?.success === "boolean" ? o.success : null,
      new: asInt(o?.new),
      modified: asInt(o?.modified),
      errors: extractNotices(o?.errors),
      warnings: extractNotices(o?.warnings),
    };
  });
  return { httpStatus, items };
}

export type BookingReportResult =
  | {
      ok: true;
      envelope: BookingReportEnvelope;
      creditsRemaining: number | null;
    }
  | (Beds24ApiFailure & {
      /** present whenever a response was actually received */
      envelope?: BookingReportEnvelope;
      creditsRemaining?: number;
    });

/** Beds24 rejected the report on an otherwise-successful HTTP status. */
const REJECTED_MESSAGE =
  "Booking.com דחה את הדיווח — ייתכן שהוא מחוץ לחלון הזמן המותר או שהתנאים אינם מתקיימים";

/**
 * Report ONE booking's status to Booking.com through Beds24.
 *
 * Single booking per call by design: an array body could batch, but an
 * operator-triggered, irreversible report must never carry a second booking it
 * did not intend — and a partial batch result is unactionable.
 */
export async function reportBeds24BookingStatus(
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number },
  args: {
    token: string;
    baseUrl: string; // from beds24BaseUrl() — never a literal at the call site
    /** the Beds24 booking id; stored locally as text, sent as an INTEGER */
    bookingId: string;
    action: BookingReportAction;
  },
): Promise<BookingReportResult> {
  // structural gate: a non-integer booking id never reaches the network.
  // Beds24 booking ids are integers; the local column is text, so this is the
  // one place the conversion is proven rather than assumed.
  const numericId = Number(args.bookingId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return beds24Fail("validation");

  const r = await beds24Request({
    token: args.token,
    baseUrl: args.baseUrl,
    method: "POST",
    path: "/channels/booking",
    // EXACTLY the two documented fields, in an array — nothing more (see header)
    body: [{ bookingId: numericId, action: WIRE_ACTION[args.action] }],
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if ("ok" in r) return r; // transport-level failure, already a safe category

  const creditsRemaining = r.creditsRemaining ?? null;
  const envelope = extractBookingReportEnvelope(r.status, r.body);

  if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
    const f: BookingReportResult = {
      ...beds24Fail(mapErrorStatus(r.status), r.status),
      envelope,
      ...(creditsRemaining !== null ? { creditsRemaining } : {}),
      ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}),
    };
    return f;
  }

  // the 2xx-with-errors trap (beds24-ari.ts doctrine): success:false, or an
  // errors[] on a 2xx, means Booking.com did NOT accept the report. Never a
  // clean success — an operator must not be told a report landed when it did not.
  const rejected =
    envelope.items.length === 0 ||
    envelope.items.some((i) => i.success === false || i.errors.length > 0);
  if (rejected) {
    return {
      ok: false,
      category: "validation",
      message: REJECTED_MESSAGE,
      httpStatus: r.status,
      envelope,
      ...(creditsRemaining !== null ? { creditsRemaining } : {}),
    };
  }

  return { ok: true, envelope, creditsRemaining };
}
