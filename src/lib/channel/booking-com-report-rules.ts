// ============================================================
// Booking.com status reports — the SHARED RULES (D96).
//
// Standalone and import-free, in the spirit of payloads.ts / ranges.ts: this is
// the ONE definition of the local action vocabulary, of "is this a Booking.com
// booking", and of the three time windows. The server core
// (booking-com-reports-core.ts) and the browser (BookingComReports.tsx) both
// import it, so a disabled button and a server rejection can never disagree —
// and neither can quietly drift from the provider's documented windows.
//
// The windows are the PROVIDER's own, quoted from apiV2.yaml
// (POST /channels/booking):
//   reportInvalidCard — "Only available before check in"
//   reportNoShow      — "Only available from check in for 2 days"
//   reportCancel      — "The booking will only be cancelled if all
//                        prerequisites have been fulfilled"
// The first two are clocks; the third is a prerequisite (a prior successful
// invalid-card report), which the server owns because only the ledger knows it.
//
// These checks are SOFT. Beds24/Booking.com is the source of truth on
// eligibility; the point here is to stop an obviously-doomed, credit-burning,
// irreversible call and to tell the operator WHY — never to claim authority.
// ============================================================

/** The LOCAL action vocabulary — matches the booking_channel_reports CHECK. */
export const BOOKING_REPORT_ACTIONS = [
  "invalid_card",
  "cancel_due_invalid_card",
  "no_show",
] as const;
export type BookingReportAction = (typeof BOOKING_REPORT_ACTIONS)[number];

/**
 * Is this OTA name Booking.com? Beds24 sends `channel: "booking"` (the live
 * value in reservations.ota_name), the label is "Booking.com" and older rows
 * carry "BookingCom" — one normalization covers all three. Same shape as
 * booking-normalize.ts::otaSourceKey, kept here so the client needs no import
 * from the import pipeline.
 */
export function isBookingComOtaName(otaName: string | null | undefined): boolean {
  if (!otaName) return false;
  return otaName.toLowerCase().replace(/[^a-z]/g, "").includes("booking");
}

/** date-only arithmetic on "YYYY-MM-DD" — a noon-UTC anchor avoids every DST edge. */
export function addDaysToDateOnly(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The soft, property-local window check.
 * Returns a Hebrew reason when the window is CLOSED, or null when it is open.
 *
 *  · invalid_card — from creation until 00:00 on the check-in date
 *                   ⇒ open while today < check_in
 *  · no_show      — from 00:00 on check-in for 48h
 *                   ⇒ open while check_in <= today < check_in + 2
 *  · cancel_due_invalid_card — no clock; the prerequisite is the prior
 *                   successful invalid-card report, checked server-side.
 */
export function windowRejection(args: {
  action: BookingReportAction;
  /** property-local today, "YYYY-MM-DD" */
  today: string;
  /** the reservation's check-in date, "YYYY-MM-DD" */
  checkIn: string;
}): string | null {
  const { action, today, checkIn } = args;
  if (action === "invalid_card") {
    return today < checkIn
      ? null
      : "דיווח כרטיס לא תקין אפשרי רק עד תחילת יום הצ'ק-אין — החלון נסגר";
  }
  if (action === "no_show") {
    if (today < checkIn) return "דיווח אי-הגעה אפשרי רק מיום הצ'ק-אין ואילך";
    return today < addDaysToDateOnly(checkIn, 2)
      ? null
      : "חלון דיווח אי-הגעה (48 שעות מהצ'ק-אין) נסגר";
  }
  return null;
}

/** The operator-facing description of each window, for the confirmation modals. */
export const BOOKING_REPORT_WINDOW_TEXT: Record<BookingReportAction, string> = {
  invalid_card: "חלון הדיווח: מרגע קליטת ההזמנה ועד תחילת יום הצ'ק-אין.",
  cancel_due_invalid_card:
    "אין חלון זמן קבוע — Booking.com תבטל רק אם כל התנאים מתקיימים אצלה.",
  no_show: "חלון הדיווח: מיום הצ'ק-אין ולמשך 48 שעות.",
};
